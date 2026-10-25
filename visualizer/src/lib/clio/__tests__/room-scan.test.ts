import { describe, expect, test } from "bun:test";
import type { Vec3 } from "@clio/protocol";
import { rosFromW } from "@clio-viewer/capture/from-clio";
import * as THREE from "three";
import {
  BACKDROP_LAYER,
  W_TO_ROS,
  windToward,
} from "@/components/clio/layers/gltf";
import { disposeModel, loadModel } from "@/components/clio/layers/model";
import { disposeRoomScan, loadRoomScan } from "@/components/clio/layers/room";
import { SOLID_PROGRAM } from "@/components/clio/layers/solid";
import { syntheticDerived } from "../__fixtures__/synthetic-derived";
import { syntheticEpisode } from "../__fixtures__/synthetic-episode";
import {
  boxMesh,
  nodePoint,
  syntheticRoom,
  syntheticScene,
} from "../__fixtures__/synthetic-scene";

// The room scan and a generated model as three.js parses and prepares them,
// without a browser: GLTFLoader reads the fixture's GLBs (written with the
// pipeline's node layout), and the room's nodes, inside the W-to-ROS turn,
// land where rosFromW puts each vertex placed by its node's transform in W.

const EPISODE = syntheticEpisode();
const ROOM = syntheticRoom(EPISODE);
const SCENE = syntheticScene(EPISODE, syntheticDerived(EPISODE).manifest);

const buffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.slice().buffer as ArrayBuffer;

const expectClose = (
  actual: readonly number[],
  expected: readonly number[],
) => {
  expect(actual.length).toBe(expected.length);
  actual.forEach((v, i) => expect(v).toBeCloseTo(expected[i], 5));
};

/** Every geometry and material under `root`. */
function resources(
  root: THREE.Object3D,
): (THREE.BufferGeometry | THREE.Material)[] {
  const found = new Set<THREE.BufferGeometry | THREE.Material>();
  root.traverse((object) => {
    const drawn = object as Partial<THREE.Mesh>;
    if (drawn.geometry) found.add(drawn.geometry);
    const m = drawn.material;
    for (const material of Array.isArray(m) ? m : m ? [m] : [])
      found.add(material);
  });
  return [...found];
}

function tracked(
  items: { addEventListener(type: "dispose", fn: () => void): void }[],
) {
  const disposed = new Set<object>();
  for (const item of items)
    item.addEventListener("dispose", () => disposed.add(item));
  return disposed;
}

describe("the room scan", () => {
  test("each mesh is named by its id, with its kind, label and global from the node extras", async () => {
    const scan = await loadRoomScan(buffer(ROOM.glb));
    expect(scan.parts.map((p) => [p.id, p.kind, p.label, p.global])).toEqual(
      ROOM.scan.meshes.map((m) => [m.id, m.kind, m.label, m.global]),
    );
    disposeRoomScan(scan);
  });

  test("a node's vertices, inside the W-to-ROS turn, land where rosFromW puts them", async () => {
    const scan = await loadRoomScan(buffer(ROOM.glb));
    // The scene's ROS group, and the room's turn inside it.
    const ros = new THREE.Group();
    const turn = new THREE.Group();
    turn.quaternion.copy(W_TO_ROS);
    turn.add(scan.root);
    ros.add(turn);
    ros.updateMatrixWorld(true);
    for (const [i, part] of scan.parts.entries()) {
      const node = ROOM.nodes[i];
      const positions = node.mesh?.positions ?? [];
      const position = part.mesh.geometry.getAttribute("position");
      expect(position.count).toBe(positions.length / 3);
      for (let v = 0; v < position.count; v += 7) {
        const local: Vec3 = [
          positions[3 * v],
          positions[3 * v + 1],
          positions[3 * v + 2],
        ];
        const drawn = part.mesh.localToWorld(
          new THREE.Vector3().fromBufferAttribute(position, v),
        );
        expectClose(drawn.toArray(), rosFromW(nodePoint(node, local)));
      }
    }
    disposeRoomScan(scan);
  });

  test("the global mesh faces the room's middle; furniture keeps its winding", async () => {
    const scan = await loadRoomScan(buffer(ROOM.glb));
    const facing = (mesh: THREE.Mesh, middle: THREE.Vector3) => {
      const index = mesh.geometry.index as THREE.BufferAttribute;
      const position = mesh.geometry.getAttribute("position");
      const tri = new THREE.Triangle();
      const normal = new THREE.Vector3();
      const center = new THREE.Vector3();
      let toward = 0;
      for (let t = 0; t < index.count; t += 3) {
        tri.setFromAttributeAndIndices(
          position,
          index.getX(t),
          index.getX(t + 1),
          index.getX(t + 2),
        );
        tri.getNormal(normal);
        tri.getMidpoint(center);
        if (normal.dot(middle.clone().sub(center)) > 0) toward++;
      }
      return toward / (index.count / 3);
    };
    const [global, table] = scan.parts;
    // Written wound outward; every triangle now faces in.
    expect(facing(global.mesh, new THREE.Vector3(0, 1.3, 0))).toBe(1);
    expect(facing(table.mesh, new THREE.Vector3())).toBe(0);
    // Front faces only: a wall seen from behind (between the camera and the
    // room) is not drawn. Flat shaded, so each face reads by its facing.
    const surface = global.mesh.material as THREE.MeshLambertMaterial;
    expect(surface.side).toBe(THREE.FrontSide);
    expect(surface.flatShading).toBe(true);
    disposeRoomScan(scan);
  });

  test("everything is on the backdrop layer, with edges for every mesh", async () => {
    const scan = await loadRoomScan(buffer(ROOM.glb));
    scan.root.traverse((o) => {
      expect(o.layers.mask).toBe(1 << BACKDROP_LAYER);
    });
    for (const part of scan.parts) {
      expect(part.edges.parent).toBe(part.mesh);
      expect(part.edges.geometry).toBeInstanceOf(THREE.EdgesGeometry);
    }
    disposeRoomScan(scan);
  });

  test("the walls, floor and furniture are solid: opaque, grained and depth-biased", async () => {
    const scan = await loadRoomScan(buffer(ROOM.glb));
    const [global, ...furniture] = scan.parts;
    const surface = global.mesh.material as THREE.MeshLambertMaterial;
    const volume = furniture[0].mesh.material as THREE.MeshLambertMaterial;
    for (const part of furniture) expect(part.mesh.material).toBe(volume);
    for (const material of [surface, volume]) {
      expect(material.transparent).toBe(false);
      expect(material.opacity).toBe(1);
      expect(material.depthWrite).toBe(true);
      expect(material.customProgramCacheKey()).toBe(SOLID_PROGRAM.biased);
    }
    expect(volume.flatShading).toBe(true);
    // The grain reaches the shader as a uniform, the same texture for both.
    const uniformsOf = (material: THREE.Material) => {
      const shader = {
        uniforms: {} as Record<string, THREE.IUniform>,
        vertexShader: THREE.ShaderLib.lambert.vertexShader,
        fragmentShader: THREE.ShaderLib.lambert.fragmentShader,
      };
      material.onBeforeCompile(
        shader as unknown as THREE.WebGLProgramParametersWithUniforms,
        undefined as unknown as THREE.WebGLRenderer,
      );
      return shader;
    };
    const a = uniformsOf(surface);
    const b = uniformsOf(volume);
    expect(a.uniforms.solidGrain.value).toBe(scan.grain);
    expect(b.uniforms.solidGrain.value).toBe(scan.grain);
    expect(a.vertexShader).toContain("vSolidWorld");
    expect(a.vertexShader).toContain("gl_Position.z");
    expect(a.fragmentShader).toContain("texture2D(solidGrain");
    disposeRoomScan(scan);
  });

  test("disposing the scan releases every geometry, material and the grain, the edges' too", async () => {
    const scan = await loadRoomScan(buffer(ROOM.glb));
    const all = [...resources(scan.root), scan.grain];
    expect(all.filter((r) => r instanceof THREE.EdgesGeometry).length).toBe(5);
    const disposed = tracked(all);
    disposeRoomScan(scan);
    expect(all.filter((r) => !disposed.has(r))).toEqual([]);
  });

  test("a file that is not a GLB is rejected, so it reads as invalid", async () => {
    await expect(
      loadRoomScan(buffer(new TextEncoder().encode('{"not": "a glb"}'))),
    ).rejects.toThrow();
  });

  test("windToward turns only the triangles facing away", () => {
    const geometry = new THREE.BufferGeometry();
    const box = boxMesh([2, 2, 2]);
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(box.positions, 3),
    );
    geometry.setIndex(box.indices);
    expect(windToward(geometry, new THREE.Vector3())).toBe(12);
    expect(windToward(geometry, new THREE.Vector3())).toBe(0);
    // Without an index one is made, the same triangles in order.
    const soup = geometry.toNonIndexed();
    expect(windToward(soup, new THREE.Vector3(0, 0, 0))).toBe(0);
    expect(soup.index?.count).toBe(36);
  });
});

describe("a generated model", () => {
  test("takes the generated look, with a depth pass and an outline per mesh", async () => {
    const model = await loadModel(buffer(SCENE.files["model-syringe.glb"]));
    const meshes: THREE.Mesh[] = [];
    model.root.traverse((o) => {
      if (o instanceof THREE.Mesh && o.renderOrder === 2) meshes.push(o);
    });
    // Barrel, tip, flange, plunger and thumb rest.
    expect(meshes.length).toBe(5);
    expect(model.outlines.length).toBe(5);
    for (const mesh of meshes) {
      const material = mesh.material as THREE.MeshLambertMaterial;
      expect(material).toBeInstanceOf(THREE.MeshLambertMaterial);
      expect(material.transparent).toBe(true);
      expect(material.depthWrite).toBe(false);
      expect(material.opacity).toBeCloseTo(0.5, 6);
      expect(material.customProgramCacheKey()).toBe("clio-generated");
      const prepass = mesh.children.find(
        (c): c is THREE.Mesh => c instanceof THREE.Mesh && c.renderOrder === 1,
      );
      expect(prepass?.geometry).toBe(mesh.geometry);
      expect((prepass?.material as THREE.Material).colorWrite).toBe(false);
    }
    // The plunger keeps its own color.
    const colors = meshes.map((m) =>
      (m.material as THREE.MeshLambertMaterial).color.getHexString(),
    );
    expect(new Set(colors).size).toBeGreaterThan(1);
    disposeModel(model);
  });

  test("disposing it releases its geometries and materials, not the object's outline material", async () => {
    const model = await loadModel(buffer(SCENE.files["model-cup_a.glb"]));
    const outline = new THREE.LineBasicMaterial();
    for (const line of model.outlines) line.material = outline;
    const own = resources(model.root).filter((r) => r !== outline);
    const outlines = model.outlines.map((l) => l.geometry);
    const disposed = tracked([...own, ...outlines, outline]);
    disposeModel(model);
    expect([...own, ...outlines].filter((r) => !disposed.has(r))).toEqual([]);
    expect(disposed.has(outline)).toBe(false);
  });
});

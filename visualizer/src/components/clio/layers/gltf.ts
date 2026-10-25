import {
  BufferAttribute,
  type BufferGeometry,
  type Group,
  type Material,
  Mesh,
  type Object3D,
  Quaternion,
  Texture,
  Vector3,
} from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { W_TO_ROS_QUAT } from "@/lib/clio/scene-display";

// GLB files the Clio scene draws (the room scan, the generated object models): parsing with
// three's GLTFLoader, releasing everything a parsed file holds, the turn from W to ROS their nodes
// sit in, and the layer that draws the room behind the measured data. Draco-compressed files are not read: their decoder is not bundled, so
// such a model reads as invalid and is left out.

/** The GLB's default scene. Meshopt-compressed buffers are decoded; textures load from the file. */
export async function parseGlb(bytes: ArrayBuffer): Promise<Group> {
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.parseAsync(bytes, "");
  return gltf.scene;
}

/** W to ROS: the group W-frame content (GLB nodes with their own transforms in W) sits in. */
export const W_TO_ROS = new Quaternion(...W_TO_ROS_QUAT);

/** Every texture a material holds (its map, normal map and so on). */
function texturesOf(material: Material): Texture[] {
  const textures: Texture[] = [];
  for (const value of Object.values(material)) {
    if (value instanceof Texture) textures.push(value);
  }
  return textures;
}

/** Disposes every geometry, material and texture under `root`, each once. */
export function disposeTree(root: Object3D): void {
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<Material>();
  root.traverse((object) => {
    const drawn = object as Partial<Mesh>;
    if (drawn.geometry) geometries.add(drawn.geometry);
    const material = drawn.material;
    for (const m of Array.isArray(material)
      ? material
      : material
        ? [material]
        : []) {
      materials.add(m);
    }
  });
  const textures = new Set<Texture>();
  for (const material of materials) {
    for (const texture of texturesOf(material)) textures.add(texture);
    material.dispose();
  }
  for (const texture of textures) texture.dispose();
  for (const geometry of geometries) geometry.dispose();
}

/**
 * Winds every triangle of `geometry` to face `center` (in the geometry's own frame): a closed room
 * mesh then shows its inside faces from within the room, and, drawn front faces only, the walls
 * nearest a camera outside the room drop away like a dollhouse's. Returns how many it turned.
 */
export function windToward(geometry: BufferGeometry, center: Vector3): number {
  const position = geometry.getAttribute("position");
  if (!position) return 0;
  if (!geometry.index) {
    const order = new Uint32Array(position.count);
    for (let i = 0; i < order.length; i++) order[i] = i;
    geometry.setIndex(new BufferAttribute(order, 1));
  }
  const index = geometry.index as BufferAttribute;
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  const ab = new Vector3();
  const ac = new Vector3();
  const normal = new Vector3();
  const toCenter = new Vector3();
  let turned = 0;
  for (let t = 0; t + 2 < index.count; t += 3) {
    const ib = index.getX(t + 1);
    const ic = index.getX(t + 2);
    a.fromBufferAttribute(position, index.getX(t));
    b.fromBufferAttribute(position, ib);
    c.fromBufferAttribute(position, ic);
    normal.crossVectors(ab.subVectors(b, a), ac.subVectors(c, a));
    // From the triangle's centroid toward the center.
    toCenter.copy(a).add(b).add(c).divideScalar(3).negate().add(center);
    if (normal.dot(toCenter) < 0) {
      index.setX(t + 1, ic);
      index.setX(t + 2, ib);
      turned++;
    }
  }
  if (turned > 0) index.needsUpdate = true;
  return turned;
}

/**
 * The layer the room is drawn on. ClioScene draws it first and then everything else over it with
 * a cleared depth buffer (BackdropPass in clio-scene.tsx), so context never hides the table, the
 * hands or the objects, whatever the room scan's surfaces are in front of.
 */
export const BACKDROP_LAYER = 1;

/** Puts everything under `root` on the backdrop layer only. */
export function onBackdrop(root: Object3D): void {
  root.traverse((object) => object.layers.set(BACKDROP_LAYER));
}

/** Meshes under `root`, in traversal order. */
export function meshesOf(root: Object3D): Mesh[] {
  const meshes: Mesh[] = [];
  root.traverse((object) => {
    if (object instanceof Mesh) meshes.push(object);
  });
  return meshes;
}

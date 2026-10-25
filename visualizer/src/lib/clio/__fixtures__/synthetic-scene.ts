import {
  type CompileManifest,
  type EnvironmentDoc,
  type ModelBackend,
  type Quat,
  type RoomScan,
  SCENE_SCHEMA_ID,
  type SceneDoc,
  type SceneModel,
  type SceneStage,
  type SurfaceKind,
  type Vec3,
} from "@clio/protocol";
import type { SyntheticEpisode } from "./synthetic-episode";

// The room scan and the rebuilt scene for a synthetic episode (synthetic-episode.ts), as the
// pipeline would write them: room.glb beside the compile (with environment.json's `room`
// describing it) and data/scenes/<id>/ with scene.json and one model-<id>.glb per object. Pure
// and deterministic, for tests and the dev harness page, so the room and the generated models show
// without a server or the Python pipeline. The GLBs are written by hand (encodeGlb), with the node
// layout of pipeline/src/clio_pipeline/glb.py: one root node per mesh, its translation and rotation
// the pose in W, POSITION (and NORMAL for models) as float32, uint32 indices, the scan's
// `extras: {kind, label, global}` and a model's part colors as base color factors.
//
// The room is 3.2 x 3.2 m and 2.6 m high, its floor 75 cm below the tray: a global mesh (a closed
// box, wound outward as a mesh need not be) and four furniture volumes: the table under the tray,
// turned 6 degrees like the detected table plane, a couch along the right wall turned a quarter
// turn, the small shelf the plane fixture has, and a screen on the wall ahead. The models: the
// syringe as a Gemini CAD program of parts (barrel, plunger, flange, tip), lying along its measured
// shape's yaw; cup A as a primitive cylinder from the plan's radius; the indicator bottle as a
// primitive standing in for a CAD answer that failed, with a note saying so.

const FLOAT = 5126;
const UINT = 5125;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;
const TRIANGLES = 4;

/** A triangle mesh in its node's frame. */
export interface GlbMesh {
  positions: number[];
  indices: number[];
  normals?: number[];
}

export interface GlbNode {
  name: string;
  translation?: Vec3;
  rotation?: Quat;
  mesh?: GlbMesh;
  /** Linear RGBA base color; none writes no material. */
  color?: [number, number, number, number];
  extras?: Record<string, unknown>;
}

const align4 = (n: number) => (n + 3) & ~3;

/** A binary glTF 2.0 with every node a root, as the pipeline writes them. */
export function encodeGlb(nodes: readonly GlbNode[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  let binLength = 0;
  const bufferViews: Record<string, unknown>[] = [];
  const accessors: Record<string, unknown>[] = [];
  const add = (
    data: Float32Array | Uint32Array,
    type: "VEC3" | "SCALAR",
    target: number,
  ): number => {
    const offset = align4(binLength);
    if (offset > binLength) chunks.push(new Uint8Array(offset - binLength));
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    chunks.push(bytes);
    binLength = offset + bytes.byteLength;
    bufferViews.push({
      buffer: 0,
      byteOffset: offset,
      byteLength: bytes.byteLength,
      target,
    });
    const accessor: Record<string, unknown> = {
      bufferView: bufferViews.length - 1,
      componentType: data instanceof Float32Array ? FLOAT : UINT,
      count: type === "VEC3" ? data.length / 3 : data.length,
      type,
    };
    if (type === "VEC3" && data instanceof Float32Array) {
      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < data.length; i++) {
        min[i % 3] = Math.min(min[i % 3], data[i]);
        max[i % 3] = Math.max(max[i % 3], data[i]);
      }
      accessor.min = min;
      accessor.max = max;
    }
    accessors.push(accessor);
    return accessors.length - 1;
  };
  const meshes: Record<string, unknown>[] = [];
  const materials: Record<string, unknown>[] = [];
  const glNodes = nodes.map((node) => {
    const gl: Record<string, unknown> = { name: node.name };
    if (node.translation) gl.translation = node.translation;
    if (node.rotation) gl.rotation = node.rotation;
    if (node.extras) gl.extras = node.extras;
    if (node.mesh) {
      const attributes: Record<string, number> = {
        POSITION: add(
          new Float32Array(node.mesh.positions),
          "VEC3",
          ARRAY_BUFFER,
        ),
      };
      if (node.mesh.normals) {
        attributes.NORMAL = add(
          new Float32Array(node.mesh.normals),
          "VEC3",
          ARRAY_BUFFER,
        );
      }
      const primitive: Record<string, unknown> = {
        attributes,
        indices: add(
          new Uint32Array(node.mesh.indices),
          "SCALAR",
          ELEMENT_ARRAY_BUFFER,
        ),
        mode: TRIANGLES,
      };
      if (node.color) {
        primitive.material = materials.length;
        materials.push({
          name: node.name,
          pbrMetallicRoughness: {
            baseColorFactor: node.color,
            metallicFactor: 0,
            roughnessFactor: 0.8,
          },
          doubleSided: true,
        });
      }
      gl.mesh = meshes.length;
      meshes.push({ name: node.name, primitives: [primitive] });
    }
    return gl;
  });
  const doc: Record<string, unknown> = {
    asset: { version: "2.0", generator: "clio synthetic-scene" },
    scene: 0,
    scenes: [{ nodes: glNodes.map((_, i) => i) }],
    nodes: glNodes,
  };
  if (meshes.length > 0) doc.meshes = meshes;
  if (materials.length > 0) doc.materials = materials;
  if (accessors.length > 0) {
    doc.accessors = accessors;
    doc.bufferViews = bufferViews;
    doc.buffers = [{ byteLength: align4(binLength) }];
  }
  const json = new TextEncoder().encode(JSON.stringify(doc));
  const jsonLength = align4(json.length);
  const binPadded = align4(binLength);
  const total = 12 + 8 + jsonLength + (binLength > 0 ? 8 + binPadded : 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true); // "glTF"
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true); // "JSON"
  out.fill(0x20, 20, 20 + jsonLength);
  out.set(json, 20);
  if (binLength > 0) {
    const at = 20 + jsonLength;
    view.setUint32(at, binPadded, true);
    view.setUint32(at + 4, 0x004e4942, true); // "BIN\0"
    let offset = at + 8;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
  }
  return out;
}

const round = (v: number, digits = 4) => {
  const k = 10 ** digits;
  return Math.round(v * k) / k;
};
const roundVec = <T extends number[]>(v: T): T => v.map((x) => round(x)) as T;
const yaw = (radians: number): Quat =>
  roundVec([0, Math.sin(radians / 2), 0, Math.cos(radians / 2)]);
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

/** v turned by the unit quaternion q = [x, y, z, w]. */
export function rotateVec(q: Quat, v: Vec3): Vec3 {
  const [x, y, z, w] = q;
  const cx = y * v[2] - z * v[1];
  const cy = z * v[0] - x * v[2];
  const cz = x * v[1] - y * v[0];
  return [
    v[0] + 2 * (w * cx + y * cz - z * cy),
    v[1] + 2 * (w * cy + z * cx - x * cz),
    v[2] + 2 * (w * cz + x * cy - y * cx),
  ];
}

/** A node's local point in its parent's frame: rotation, then translation. */
export const nodePoint = (node: GlbNode, local: Vec3): Vec3 =>
  add(
    node.translation ?? [0, 0, 0],
    rotateVec(node.rotation ?? [0, 0, 0, 1], local),
  );

/** Appends a face split into `cells` x `cells` quads, wound so it faces along u x v. */
function face(
  mesh: GlbMesh,
  center: Vec3,
  u: Vec3,
  v: Vec3,
  normal: Vec3 | null,
  cells = 1,
): void {
  const base = mesh.positions.length / 3;
  for (let j = 0; j <= cells; j++) {
    for (let i = 0; i <= cells; i++) {
      const a = (2 * i) / cells - 1;
      const b = (2 * j) / cells - 1;
      mesh.positions.push(
        ...roundVec([
          center[0] + a * u[0] + b * v[0],
          center[1] + a * u[1] + b * v[1],
          center[2] + a * u[2] + b * v[2],
        ]),
      );
      if (normal) mesh.normals?.push(...normal);
    }
  }
  const row = cells + 1;
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      const p0 = base + j * row + i;
      const p1 = p0 + 1;
      const p2 = p0 + row + 1;
      const p3 = p0 + row;
      mesh.indices.push(p0, p1, p2, p0, p2, p3);
    }
  }
}

/** A box of `size` centered on `center`, every face wound outward. */
export function boxMesh(
  size: Vec3,
  center: Vec3 = [0, 0, 0],
  { normals = false, cells = 1 }: { normals?: boolean; cells?: number } = {},
): GlbMesh {
  const mesh: GlbMesh = {
    positions: [],
    indices: [],
    ...(normals && { normals: [] }),
  };
  const [hx, hy, hz] = [size[0] / 2, size[1] / 2, size[2] / 2];
  const at = (d: Vec3) => add(center, d);
  const n = (v: Vec3) => (normals ? v : null);
  face(mesh, at([hx, 0, 0]), [0, hy, 0], [0, 0, hz], n([1, 0, 0]), cells);
  face(mesh, at([-hx, 0, 0]), [0, 0, hz], [0, hy, 0], n([-1, 0, 0]), cells);
  face(mesh, at([0, hy, 0]), [0, 0, hz], [hx, 0, 0], n([0, 1, 0]), cells);
  face(mesh, at([0, -hy, 0]), [hx, 0, 0], [0, 0, hz], n([0, -1, 0]), cells);
  face(mesh, at([0, 0, hz]), [hx, 0, 0], [0, hy, 0], n([0, 0, 1]), cells);
  face(mesh, at([0, 0, -hz]), [0, hy, 0], [hx, 0, 0], n([0, 0, -1]), cells);
  return mesh;
}

/**
 * A closed cylinder (or a cone's frustum) up +y from `y0` to `y1`, radius `r0` at the bottom and
 * `r1` at the top, wound outward with normals. `alongX` lays it along +x instead (turned a
 * quarter about z, so its winding stays outward).
 */
export function cylinderMesh(
  r0: number,
  r1: number,
  y0: number,
  y1: number,
  { segments = 24, alongX = false, center = [0, 0, 0] as Vec3 } = {},
): GlbMesh {
  const mesh: GlbMesh = { positions: [], indices: [], normals: [] };
  const turn = (p: Vec3): Vec3 => (alongX ? [p[1], -p[0], p[2]] : p);
  const push = (p: Vec3, n: Vec3) => {
    mesh.positions.push(...roundVec(add(center, turn(p))));
    mesh.normals?.push(...roundVec(turn(n)));
  };
  const slope = (r0 - r1) / (y1 - y0);
  const k = 1 / Math.hypot(1, slope);
  // The side: a ring at each end per segment edge, normals across the side.
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    push([r0 * c, y0, r0 * s], [c * k, slope * k, s * k]);
    push([r1 * c, y1, r1 * s], [c * k, slope * k, s * k]);
  }
  for (let i = 0; i < segments; i++) {
    const a = 2 * i;
    const b = 2 * (i + 1);
    mesh.indices.push(a, a + 1, b, b, a + 1, b + 1);
  }
  // The caps: a center and a ring each.
  for (const [y, r, up] of [
    [y1, r1, 1],
    [y0, r0, -1],
  ] as const) {
    if (r <= 0) continue;
    const center = mesh.positions.length / 3;
    push([0, y, 0], [0, up, 0]);
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      push([r * Math.cos(a), y, r * Math.sin(a)], [0, up, 0]);
    }
    for (let i = 0; i < segments; i++) {
      const p = center + 1 + i;
      if (up > 0) mesh.indices.push(center, p + 1, p);
      else mesh.indices.push(center, p, p + 1);
    }
  }
  return mesh;
}

/** A room scan mesh as the headset reports it. */
interface ScanPart {
  id: string;
  kind: SurfaceKind;
  label: string;
  global: boolean;
  translation: Vec3;
  rotation: Quat;
  mesh: GlbMesh;
}

export interface SyntheticRoom {
  /** environment.json's `room`. */
  scan: RoomScan;
  /** room.glb, served beside the compile. */
  glb: Uint8Array;
  /** The nodes written into it, for tests. */
  nodes: GlbNode[];
}

/** The synthetic room's size: x and z across, y up, m. */
export const SYNTHETIC_ROOM_SIZE: Vec3 = [3.2, 2.6, 3.2];

/** The Quest room scan around the synthetic episode's tray, in W. */
export function syntheticRoom(episode: SyntheticEpisode): SyntheticRoom {
  const floorY = -(episode.meta.space?.worldFromWorkspace[1] ?? 0.75);
  const [rx, ry, rz] = SYNTHETIC_ROOM_SIZE;
  const tableHeight = -floorY;
  const parts: ScanPart[] = [
    {
      id: "mesh-1",
      kind: "other",
      label: "global mesh",
      global: true,
      // The room's floor center; the box rises from it.
      translation: roundVec([0.3, floorY, 0.5]),
      rotation: [0, 0, 0, 1],
      mesh: boxMesh([rx, ry, rz], [0, ry / 2, 0], { cells: 4 }),
    },
    {
      id: "mesh-2",
      kind: "table",
      label: "table",
      global: false,
      // Under the detected table plane (synthetic-derived.ts), turned with it.
      translation: roundVec([0.36, floorY / 2, -0.24]),
      rotation: yaw((6 * Math.PI) / 180),
      mesh: boxMesh([1.04, tableHeight, 0.72]),
    },
    {
      id: "mesh-3",
      kind: "couch",
      label: "couch",
      global: false,
      translation: roundVec([1.42, floorY + 0.4, 1.0]),
      rotation: yaw(Math.PI / 2),
      mesh: boxMesh([1.9, 0.8, 0.85]),
    },
    {
      id: "mesh-4",
      kind: "other",
      label: "shelf",
      global: false,
      // Below the small plane the plane fixture leaves out later.
      translation: roundVec([1.05, (floorY + 0.3) / 2, -0.55]),
      rotation: [0, 0, 0, 1],
      mesh: boxMesh([0.4, 0.3 - floorY, 0.3]),
    },
    {
      id: "mesh-5",
      kind: "other",
      label: "screen",
      global: false,
      translation: [0.3, 0.55, -1.06],
      rotation: [0, 0, 0, 1],
      mesh: boxMesh([1.0, 0.58, 0.06]),
    },
  ];
  const nodes: GlbNode[] = parts.map((part) => ({
    name: part.id,
    translation: part.translation,
    rotation: part.rotation,
    mesh: part.mesh,
    extras: { kind: part.kind, label: part.label, global: part.global },
  }));
  const meshes = parts.map((part, i) => {
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    const { positions } = part.mesh;
    for (let p = 0; p < positions.length; p += 3) {
      const w = nodePoint(nodes[i], [
        positions[p],
        positions[p + 1],
        positions[p + 2],
      ]);
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], w[k]);
        max[k] = Math.max(max[k], w[k]);
      }
    }
    return {
      id: part.id,
      kind: part.kind,
      label: part.label,
      global: part.global,
      vertices: positions.length / 3,
      triangles: part.mesh.indices.length / 3,
      bounds: { min: roundVec(min), max: roundVec(max) },
    };
  });
  return {
    scan: {
      file: "room.glb",
      source: "quest-scene",
      media: "room-scan-1.glb",
      snapshotT: 0,
      snapshots: 1,
      meshes,
    },
    glb: encodeGlb(nodes),
    nodes,
  };
}

/** environment.json with the room scan: what a compile 0.7.0 or later writes. */
export const withRoom = (
  environment: EnvironmentDoc,
  room: SyntheticRoom,
): EnvironmentDoc => ({ ...environment, room: room.scan });

const SYRINGE_YAW = (20 * Math.PI) / 180;
const FAKE_SHA = "5c".repeat(32);

/** Linear RGBA. */
type Color = [number, number, number, number];
const PART = {
  barrel: [0.82, 0.86, 0.9, 1] as Color,
  plunger: [0.36, 0.2, 0.58, 1] as Color,
  rubber: [0.08, 0.08, 0.09, 1] as Color,
  cup: [0.7, 0.76, 0.82, 1] as Color,
  bottle: [0.34, 0.2, 0.52, 1] as Color,
};

/** The syringe as the parts of a CAD program: along +x, its bottom on y = 0. */
function syringeParts(): GlbNode[] {
  return [
    {
      name: "barrel",
      mesh: cylinderMesh(0.0095, 0.0095, -0.05, 0.03, {
        alongX: true,
        center: [0, 0.0095, 0],
      }),
      color: PART.barrel,
    },
    {
      name: "tip",
      // Narrowing away from the barrel, toward -x.
      mesh: cylinderMesh(0.0012, 0.0035, -0.012, 0, {
        alongX: true,
        center: [-0.05, 0.0095, 0],
      }),
      color: PART.barrel,
    },
    {
      name: "flange",
      mesh: boxMesh([0.004, 0.019, 0.028], [0.031, 0.0095, 0], {
        normals: true,
      }),
      color: PART.barrel,
    },
    {
      name: "plunger",
      mesh: cylinderMesh(0.003, 0.003, 0.03, 0.055, {
        alongX: true,
        center: [0, 0.0095, 0],
      }),
      color: PART.plunger,
    },
    {
      name: "thumb rest",
      mesh: cylinderMesh(0.008, 0.008, 0.055, 0.058, {
        alongX: true,
        center: [0, 0.0095, 0],
      }),
      color: PART.rubber,
    },
  ];
}

export interface SyntheticSceneOptions {
  /** Default 2026-10-24T12:02:00.000Z. */
  builtAt?: string;
  /** The models stage failed with this detail. */
  modelsFailed?: string;
}

export interface SyntheticScene {
  doc: SceneDoc;
  /** Every scene file by name except the crops: scene.json and the model GLBs. */
  files: Record<string, Uint8Array>;
  /** The crops as small SVG pictures, for the dev page (the pipeline writes JPEGs). */
  crops: Record<string, string>;
}

/** What `clio scene` would write for `episode` and its compile `manifest`. */
export function syntheticScene(
  episode: SyntheticEpisode,
  manifest: CompileManifest,
  options: SyntheticSceneOptions = {},
): SyntheticScene {
  const placed = new Map(episode.meta.objects.map((o) => [o.id, o]));
  const crop = (id: string, n: number, from: "observation" | "projection") => ({
    file: `crop-${id}-${n}.jpg`,
    keyframe: `keyframe-${String(n * 4).padStart(4, "0")}.jpg`,
    box: [0.42, 0.48, 0.58, 0.62] as [number, number, number, number],
    from,
  });
  const radius = (id: string) => placed.get(id)?.radius ?? 0.03;
  /** The tracked position's height above the table: the model's bottom sits on it. */
  const lift = (id: string) => placed.get(id)?.position[1] ?? 0;
  const models: { model: SceneModel; nodes: GlbNode[] }[] = [
    {
      model: {
        id: "syringe",
        label: "syringe",
        backend: "gemini-cad",
        generator: "gemini-pro-latest",
        model: "model-syringe.glb",
        cad: "cad-syringe.json",
        crops: [
          crop("syringe", 1, "observation"),
          crop("syringe", 2, "observation"),
        ],
        size: [0.12, 0.019, 0.028],
        sizeSource: "shape",
        // The shape box (synthetic-derived.ts) sits on the tracked position.
        placement: {
          offset: [0, 0, 0],
          rotation: yaw(SYRINGE_YAW),
          rotationSource: "shape",
        },
        note: null,
      },
      nodes: syringeParts(),
    },
    {
      model: {
        id: "cup_a",
        label: "cup A",
        backend: "primitive",
        generator: null,
        model: "model-cup_a.glb",
        cad: null,
        crops: [crop("cup_a", 1, "projection")],
        size: [2 * radius("cup_a"), 0.1, 2 * radius("cup_a")],
        sizeSource: "radius",
        placement: {
          offset: [0, -lift("cup_a"), 0],
          rotation: [0, 0, 0, 1],
          rotationSource: "none",
        },
        note: null,
      },
      nodes: [
        {
          name: "cylinder",
          mesh: cylinderMesh(radius("cup_a") * 0.85, radius("cup_a"), 0, 0.1),
          color: PART.cup,
        },
      ],
    },
    {
      model: {
        id: "indicator",
        label: "indicator bottle",
        backend: "primitive",
        generator: null,
        model: "model-indicator.glb",
        cad: null,
        crops: [crop("indicator", 1, "projection")],
        size: [2 * radius("indicator"), 0.2, 2 * radius("indicator")],
        sizeSource: "radius",
        placement: {
          offset: [0, -lift("indicator"), 0],
          rotation: yaw(Math.PI / 6),
          rotationSource: "view",
        },
        note: "Gemini CAD answered no parts; a primitive stands in",
      },
      nodes: [
        {
          name: "cylinder",
          mesh: cylinderMesh(radius("indicator"), radius("indicator"), 0, 0.2),
          color: PART.bottle,
        },
      ],
    },
  ];
  const stages: SceneStage[] = [
    { name: "keyframes", status: "ok", detail: "16 keyframes" },
    options.modelsFailed === undefined
      ? { name: "models", status: "ok", detail: `${models.length} models` }
      : { name: "models", status: "failed", detail: options.modelsFailed },
  ];
  const backend: ModelBackend = "gemini-cad";
  const doc: SceneDoc = {
    schema: SCENE_SCHEMA_ID,
    episodeId: episode.meta.episodeId,
    builtAt: options.builtAt ?? "2026-10-24T12:02:00.000Z",
    builder: { name: "clio-pipeline", version: "synthetic" },
    frame: "workspace",
    compiledAt: manifest.compiledAt,
    inputs: [
      { name: "derived/tracks.json", bytes: 1, sha256: FAKE_SHA },
      { name: "derived/shapes.json", bytes: 1, sha256: FAKE_SHA },
    ],
    options: { models: backend },
    stages,
    keyframes: 16,
    objects: models.map(({ model }) => model),
  };
  const files: Record<string, Uint8Array> = {
    "scene.json": new TextEncoder().encode(JSON.stringify(doc)),
  };
  for (const { model, nodes } of models) {
    if (model.model) files[model.model] = encodeGlb(nodes);
  }
  const crops: Record<string, string> = {};
  for (const { model, nodes } of models) {
    const [r, g, b] = (nodes[0].color ?? [0.5, 0.5, 0.5, 1]).map((c) =>
      Math.round(Math.min(1, Math.max(0, c)) ** (1 / 2.2) * 255),
    );
    for (const c of model.crops) {
      crops[c.file] =
        "data:image/svg+xml," +
        encodeURIComponent(
          `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120"><rect width="160" height="120" fill="#8d8a84"/><rect y="78" width="160" height="42" fill="#b9b4aa"/><rect x="58" y="34" width="44" height="56" rx="6" fill="rgb(${r},${g},${b})"/></svg>`,
        );
    }
  }
  return { doc, files, crops };
}

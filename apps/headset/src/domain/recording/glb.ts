import type { Quat, Vec3 } from '../../core/math';

// A small binary glTF 2.0 (GLB) writer for the room scan (docs/room-scene.md): one root node per
// mesh, each with its own triangle primitive (POSITION as float32 with min/max, uint32 indices).
// It writes what pipeline/src/clio_pipeline/glb.py reads: a JSON chunk padded with spaces, a BIN
// chunk padded with zeros, and every bufferView 4-byte aligned. Typed arrays are copied as they
// are, so the bytes are little-endian on every platform the headset runs on.

const MAGIC = 0x46546c67; // "glTF"
const JSON_CHUNK = 0x4e4f534a; // "JSON"
const BIN_CHUNK = 0x004e4942; // "BIN\0"
const FLOAT = 5126;
const UNSIGNED_INT = 5125;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;
const TRIANGLES = 4;

/** One root node with a triangle mesh in its own frame. */
export interface GlbMeshNode {
  name: string;
  translation: Readonly<Vec3>;
  /** [x, y, z, w], unit length. */
  rotation: Readonly<Quat>;
  /** xyz per vertex, meters in the node's frame. */
  positions: Float32Array;
  /** Three per triangle; a trailing partial triangle is left out. */
  indices: Uint32Array;
  extras?: Record<string, unknown>;
}

interface View {
  data: Uint8Array;
  offset: number;
}

/** The GLB bytes for these nodes, all roots of one scene. A node without vertices has no mesh. */
export function writeGlb(
  nodes: readonly GlbMeshNode[],
  generator = 'clio-headset',
): Uint8Array<ArrayBuffer> {
  const views: View[] = [];
  const bufferViews: Record<string, number>[] = [];
  const accessors: Record<string, unknown>[] = [];
  const meshes: Record<string, unknown>[] = [];
  let binLength = 0;

  const addView = (array: Float32Array | Uint32Array, target: number): number => {
    // float32 and uint32 are 4 bytes each, so every view starts 4-byte aligned.
    const data = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    views.push({ data, offset: binLength });
    bufferViews.push({ buffer: 0, byteOffset: binLength, byteLength: data.byteLength, target });
    binLength += data.byteLength;
    return bufferViews.length - 1;
  };

  const glNodes = nodes.map((node) => {
    const gl: Record<string, unknown> = {
      name: node.name,
      translation: [...node.translation],
      rotation: [...node.rotation],
    };
    if (node.extras) gl.extras = node.extras;
    const count = Math.floor(node.positions.length / 3);
    const indices = node.indices.subarray(0, node.indices.length - (node.indices.length % 3));
    // Without triangles there is nothing to draw: a primitive without indices would be read as a
    // triangle list of its vertices, triangles the runtime never reported.
    if (count === 0 || indices.length === 0) return gl;
    const positions = node.positions.subarray(0, count * 3);
    const { min, max } = bounds(positions);
    accessors.push({
      bufferView: addView(positions, ARRAY_BUFFER),
      componentType: FLOAT,
      count,
      type: 'VEC3',
      min,
      max,
    });
    const primitive: Record<string, unknown> = {
      attributes: { POSITION: accessors.length - 1 },
      mode: TRIANGLES,
    };
    accessors.push({
      bufferView: addView(indices, ELEMENT_ARRAY_BUFFER),
      componentType: UNSIGNED_INT,
      count: indices.length,
      type: 'SCALAR',
    });
    primitive.indices = accessors.length - 1;
    gl.mesh = meshes.length;
    meshes.push({ name: node.name, primitives: [primitive] });
    return gl;
  });

  const doc: Record<string, unknown> = {
    asset: { version: '2.0', generator },
    scene: 0,
    scenes: [{ nodes: glNodes.map((_, i) => i) }],
    nodes: glNodes,
  };
  if (meshes.length > 0) {
    doc.meshes = meshes;
    doc.accessors = accessors;
    doc.bufferViews = bufferViews;
    doc.buffers = [{ byteLength: binLength }];
  }
  return pack(new TextEncoder().encode(JSON.stringify(doc)), views, binLength);
}

/** Per-axis min and max of xyz positions, as glTF wants them on a POSITION accessor. */
function bounds(positions: Float32Array): { min: Vec3; max: Vec3 } {
  let [x0, y0, z0] = [Infinity, Infinity, Infinity];
  let [x1, y1, z1] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i] ?? 0;
    const y = positions[i + 1] ?? 0;
    const z = positions[i + 2] ?? 0;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
    if (z < z0) z0 = z;
    if (z > z1) z1 = z;
  }
  return { min: [x0, y0, z0], max: [x1, y1, z1] };
}

const pad4 = (n: number) => (4 - (n % 4)) % 4;

function pack(
  json: Uint8Array,
  views: readonly View[],
  binLength: number,
): Uint8Array<ArrayBuffer> {
  const jsonLength = json.byteLength + pad4(json.byteLength);
  const binPadded = binLength + pad4(binLength);
  const total = 12 + 8 + jsonLength + (binLength > 0 ? 8 + binPadded : 0);
  const out = new Uint8Array(total);
  const header = new DataView(out.buffer);
  header.setUint32(0, MAGIC, true);
  header.setUint32(4, 2, true);
  header.setUint32(8, total, true);
  header.setUint32(12, jsonLength, true);
  header.setUint32(16, JSON_CHUNK, true);
  out.set(json, 20);
  out.fill(0x20, 20 + json.byteLength, 20 + jsonLength);
  if (binLength > 0) {
    const bin = 20 + jsonLength;
    header.setUint32(bin, binPadded, true);
    header.setUint32(bin + 4, BIN_CHUNK, true);
    // The rest of the chunk is already zero: that is its padding.
    for (const view of views) out.set(view.data, bin + 8 + view.offset);
  }
  return out;
}

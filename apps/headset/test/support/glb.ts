// Reads a GLB back the way pipeline/src/clio_pipeline/glb.py does: header, then chunks, then
// accessors through their bufferViews into the binary chunk.

interface Chunk {
  type: number;
  bytes: Uint8Array;
}

export interface GlbDoc {
  asset: { version: string };
  scene: number;
  scenes: { nodes: number[] }[];
  nodes: {
    name: string;
    mesh?: number;
    translation?: number[];
    rotation?: number[];
    extras?: unknown;
  }[];
  meshes?: { primitives: { attributes: { POSITION: number }; indices?: number; mode: number }[] }[];
  accessors?: {
    bufferView: number;
    componentType: number;
    count: number;
    type: string;
    min?: number[];
    max?: number[];
  }[];
  bufferViews?: { buffer: number; byteOffset: number; byteLength: number; target?: number }[];
  buffers?: { byteLength: number }[];
}

/** A GLB as its header, chunks, JSON document and accessor data. */
export function parseGlb(glb: Uint8Array) {
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  const header = [view.getUint32(0, true), view.getUint32(4, true), view.getUint32(8, true)];
  const chunks: Chunk[] = [];
  for (let offset = 12; offset + 8 <= glb.byteLength; ) {
    const length = view.getUint32(offset, true);
    chunks.push({
      type: view.getUint32(offset + 4, true),
      bytes: glb.subarray(offset + 8, offset + 8 + length),
    });
    offset += 8 + length;
  }
  const [json, bin] = chunks;
  const doc = JSON.parse(new TextDecoder().decode(json?.bytes)) as GlbDoc;
  const accessor = (i: number) => {
    const acc = doc.accessors?.[i];
    const bv = acc && doc.bufferViews?.[acc.bufferView];
    if (!acc || !bv || !bin) throw new Error(`no accessor ${i}`);
    const data = bin.bytes.slice(bv.byteOffset, bv.byteOffset + bv.byteLength).buffer;
    return acc.componentType === 5126 ? new Float32Array(data) : new Uint32Array(data);
  };
  return { header, chunks, doc, accessor };
}

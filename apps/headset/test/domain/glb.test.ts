import { describe, expect, it } from 'vitest';
import { type GlbMeshNode, writeGlb } from '../../src/domain/recording/glb';
import { parseGlb as parse } from '../support/glb';

const cube = (): GlbMeshNode => ({
  name: 'mesh-2',
  translation: [0.4, 0, -0.3],
  rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2],
  positions: new Float32Array([-0.5, 0, -0.25, 0.5, 0, -0.25, 0.5, 0.8, 0.25, -0.5, 0.8, 0.25]),
  indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  extras: { kind: 'table', label: 'table', global: false },
});

// Three vertices make the JSON and BIN lengths awkward, so both chunks need padding.
const floor = (): GlbMeshNode => ({
  name: 'mesh-1',
  translation: [0, -0.75, 0.5],
  rotation: [0, 0, 0, 1],
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]),
  indices: new Uint32Array([0, 2, 1, 0]),
  extras: { kind: 'other', label: 'global mesh', global: true },
});

describe('writeGlb', () => {
  it('writes a glTF 2.0 binary: header, a space-padded JSON chunk, a zero-padded BIN chunk', () => {
    const glb = writeGlb([floor(), cube()]);
    const { header, chunks, doc } = parse(glb);
    expect(header).toEqual([0x46546c67, 2, glb.byteLength]);
    expect(chunks.map((c) => c.type)).toEqual([0x4e4f534a, 0x004e4942]);
    for (const chunk of chunks) expect(chunk.bytes.byteLength % 4).toBe(0);
    const json = chunks[0]?.bytes ?? new Uint8Array();
    const text = new TextDecoder().decode(json);
    expect(text.trimEnd()).toBe(JSON.stringify(doc));
    expect(text.length - text.trimEnd().length).toBeLessThan(4);
    const bin = chunks[1]?.bytes ?? new Uint8Array();
    expect(doc.buffers).toEqual([{ byteLength: expect.any(Number) }]);
    const used = doc.buffers?.[0]?.byteLength ?? 0;
    expect(bin.byteLength - used).toBeLessThan(4);
    expect([...bin.subarray(used)].every((b) => b === 0)).toBe(true);
    expect(doc.asset.version).toBe('2.0');
  });

  it('makes every node a root of the scene with its name, TRS and extras', () => {
    const { doc } = parse(writeGlb([floor(), cube()]));
    expect(doc.scene).toBe(0);
    expect(doc.scenes).toEqual([{ nodes: [0, 1] }]);
    expect(doc.nodes.map((n) => n.name)).toEqual(['mesh-1', 'mesh-2']);
    expect(doc.nodes[1]?.translation).toEqual([0.4, 0, -0.3]);
    expect(doc.nodes[1]?.rotation).toEqual([0, Math.SQRT1_2, 0, Math.SQRT1_2]);
    expect(doc.nodes[0]?.extras).toEqual({ kind: 'other', label: 'global mesh', global: true });
  });

  it('stores positions as float32 VEC3 with min and max, and indices as uint32 triangles', () => {
    const { doc, accessor } = parse(writeGlb([floor(), cube()]));
    const prim = doc.meshes?.[doc.nodes[1]?.mesh ?? -1]?.primitives[0];
    expect(prim?.mode).toBe(4);
    const position = doc.accessors?.[prim?.attributes.POSITION ?? -1];
    expect(position).toMatchObject({ componentType: 5126, count: 4, type: 'VEC3' });
    expect(position?.min).toEqual([-0.5, 0, Math.fround(-0.25)]);
    expect(position?.max).toEqual([0.5, Math.fround(0.8), 0.25]);
    expect([...accessor(prim?.attributes.POSITION ?? -1)]).toEqual([...cube().positions]);
    const index = doc.accessors?.[prim?.indices ?? -1];
    expect(index).toMatchObject({ componentType: 5125, count: 6, type: 'SCALAR' });
    expect([...accessor(prim?.indices ?? -1)]).toEqual([0, 1, 2, 0, 2, 3]);
    // The floor's trailing partial triangle is left out.
    const floorPrim = doc.meshes?.[doc.nodes[0]?.mesh ?? -1]?.primitives[0];
    expect(doc.accessors?.[floorPrim?.indices ?? -1]?.count).toBe(3);
  });

  it('aligns every bufferView to 4 bytes inside the binary chunk', () => {
    const { doc } = parse(writeGlb([floor(), cube()]));
    const views = doc.bufferViews ?? [];
    expect(views).toHaveLength(4);
    for (const v of views) {
      expect(v.buffer).toBe(0);
      expect(v.byteOffset % 4).toBe(0);
    }
    expect(views.map((v) => v.target)).toEqual([34962, 34963, 34962, 34963]);
    const end = views.at(-1);
    expect((end?.byteOffset ?? 0) + (end?.byteLength ?? 0)).toBe(doc.buffers?.[0]?.byteLength);
  });

  it('reads arrays that are views into a larger buffer, as XRMesh hands them out', () => {
    const backing = new Float32Array(32).fill(9);
    backing.set(cube().positions, 5);
    const node = { ...cube(), positions: backing.subarray(5, 17) };
    const { doc, accessor } = parse(writeGlb([node]));
    expect([...accessor(0)]).toEqual([...cube().positions]);
    expect(doc.accessors?.[0]?.max).toEqual([0.5, Math.fround(0.8), 0.25]);
  });

  it('keeps a node without vertices, without a mesh, and writes no BIN chunk for none', () => {
    const empty = { ...cube(), positions: new Float32Array(), indices: new Uint32Array() };
    const { doc, chunks } = parse(writeGlb([empty]));
    expect(doc.nodes).toEqual([
      {
        name: 'mesh-2',
        translation: [0.4, 0, -0.3],
        rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2],
        extras: { kind: 'table', label: 'table', global: false },
      },
    ]);
    expect(doc.meshes).toBeUndefined();
    expect(chunks).toHaveLength(1);
  });
});

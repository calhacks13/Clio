import { describe, expect, it } from 'vitest';
import { XrMeshReader } from '../../src/adapters/xr/meshes';

// A fake XRFrame: detectedMeshes and getPose are all the reader uses. A mesh's pose is a
// translation only, as a column-major 4x4 matrix.

interface FakeMesh {
  semanticLabel?: string;
  lastChangedTime: number;
  vertices: Float32Array;
  indices: Uint32Array;
  meshSpace: { at: [number, number, number] | null };
}

const fakeMesh = (over: Partial<FakeMesh> = {}): FakeMesh => ({
  semanticLabel: 'global mesh',
  lastChangedTime: 100,
  vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]),
  indices: new Uint32Array([0, 2, 1]),
  meshSpace: { at: [0.2, 0, -0.6] },
  ...over,
});

const translation = ([x, y, z]: [number, number, number]) =>
  new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);

function fakeFrame(meshes: FakeMesh[] | (() => never) | undefined): XRFrame {
  const frame = {
    getPose: (space: FakeMesh['meshSpace']) =>
      space.at ? { transform: { matrix: translation(space.at) } } : null,
  };
  if (typeof meshes === 'function') Object.defineProperty(frame, 'detectedMeshes', { get: meshes });
  else if (meshes) Object.assign(frame, { detectedMeshes: new Set(meshes) });
  return frame as unknown as XRFrame;
}

const space = {} as XRReferenceSpace;

describe('XrMeshReader', () => {
  it('reads each mesh with its pose, label, change time and the runtime arrays themselves', () => {
    const room = fakeMesh();
    const couch = fakeMesh({
      semanticLabel: undefined,
      lastChangedTime: 250,
      meshSpace: { at: [1, 0.4, -2] },
    });
    const meshes = new XrMeshReader().read(fakeFrame([room, couch]), space);
    expect(meshes).toHaveLength(2);
    const [first, second] = meshes;
    expect(first).toMatchObject({ key: 'mesh-1', label: 'global mesh', changedAt: 100 });
    expect(first?.pose?.p.map((v) => Math.round(v * 1e4) / 1e4)).toEqual([0.2, 0, -0.6]);
    expect(first?.pose?.q).toEqual([0, 0, 0, 1]);
    // Not copied: the recorder copies them only into a snapshot.
    expect(first?.vertices).toBe(room.vertices);
    expect(first?.indices).toBe(room.indices);
    expect(second).toMatchObject({ key: 'mesh-2', label: null, changedAt: 250 });
  });

  it('keeps each mesh its key across frames, numbering new meshes as they are first seen', () => {
    const reader = new XrMeshReader();
    const room = fakeMesh();
    const table = fakeMesh({ semanticLabel: 'table' });
    const shelf = fakeMesh({ semanticLabel: 'storage' });
    const keys = (meshes: FakeMesh[]) => reader.read(fakeFrame(meshes), space).map((m) => m.key);
    expect(keys([room, table])).toEqual(['mesh-1', 'mesh-2']);
    expect(keys([table, shelf])).toEqual(['mesh-2', 'mesh-3']);
    expect(keys([shelf, room, table])).toEqual(['mesh-3', 'mesh-1', 'mesh-2']);
  });

  it('keeps a mesh it cannot locate this frame, without a pose', () => {
    const meshes = new XrMeshReader().read(
      fakeFrame([fakeMesh({ meshSpace: { at: null } })]),
      space,
    );
    expect(meshes).toHaveLength(1);
    expect(meshes[0]?.pose).toBeNull();
  });

  it('reads nothing from a frame without mesh detection', () => {
    expect(new XrMeshReader().read(fakeFrame(undefined), space)).toEqual([]);
  });

  it('turns itself off once reading the meshes throws, and says so once', () => {
    const errors: unknown[] = [];
    const reader = new XrMeshReader((err) => errors.push(err));
    let reads = 0;
    const throwing = () => {
      reads++;
      throw new Error('mesh-detection is not enabled');
    };
    expect(reader.read(fakeFrame(throwing), space)).toEqual([]);
    expect(reader.read(fakeFrame([fakeMesh()]), space)).toEqual([]);
    expect(reader.read(fakeFrame(throwing), space)).toEqual([]);
    expect(reads).toBe(1);
    expect(errors).toHaveLength(1);
  });
});

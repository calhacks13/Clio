// pipeline/tests/assets/headset-room-scan.glb, written by the headset's own GLB writer the way
// RoomScanRecorder fills it, so test_room.py reads what a Quest uploads. From the repository root:
//   pnpm exec tsx pipeline/tests/assets/headset-room-scan.ts pipeline/tests/assets/headset-room-scan.glb
import { writeFileSync } from 'node:fs';
import { writeGlb } from '../../../apps/headset/src/domain/recording/glb';

const s = Math.SQRT1_2;
const box = (x: number, y: number, z: number) =>
  new Float32Array([0, 0, 0, x, 0, 0, 0, y, 0, x, y, 0, 0, 0, z, x, 0, z, 0, y, z, x, y, z]);
const sides = new Uint32Array([0, 2, 3, 0, 3, 1, 4, 5, 7, 4, 7, 6, 0, 1, 5, 0, 5, 4, 2, 6, 7, 2, 7, 3, 0, 4, 6, 0, 6, 2, 1, 3, 7, 1, 7, 5]);
const bytes = writeGlb([
  {
    name: 'mesh-1',
    translation: [0.5, -0.74, -0.3],
    rotation: [0, s, 0, s],
    positions: new Float32Array([-2, 0, -2, 2, 0, -2, 2, 0, 2, -2, 0, 2]),
    indices: new Uint32Array([0, 2, 1, 0, 3, 2]),
    extras: { kind: 'other', label: 'global mesh', global: true },
  },
  {
    name: 'mesh-2',
    translation: [0, -0.74, -0.6],
    rotation: [0, 0, 0, 1],
    positions: box(1, 0.74, 0.6),
    indices: sides,
    extras: { kind: 'table', label: null, global: false },
  },
  {
    name: 'mesh-3',
    translation: [1, 0, 0],
    rotation: [0, 0, 0, 1],
    positions: new Float32Array([0, 0, 0, 1, 0, 0]),
    indices: new Uint32Array([]),
    extras: { kind: 'other', label: null, global: false },
  },
  {
    name: 'mesh-4',
    translation: [0, 0, 0],
    rotation: [0, 0, 0, 1],
    positions: new Float32Array([]),
    indices: new Uint32Array([]),
    extras: { kind: 'couch', label: 'couch', global: false },
  },
]);
writeFileSync(process.argv[2], bytes);

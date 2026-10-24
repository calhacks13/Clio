// The test compile doesn't include src/, so the XRFrame batch APIs FrameSampler uses come from here.
/// <reference path="../../src/adapters/xr/webxr-ext.d.ts" />
import { describe, expect, it } from 'vitest';
import { XrPlaneReader } from '../../src/adapters/xr/environment';

// A fake XRFrame: detectedPlanes and getPose are all the reader uses. A plane's pose is a
// translation only, as a column-major 4x4 matrix.

interface FakePlane {
  orientation: string;
  semanticLabel?: string;
  lastChangedTime: number;
  polygon: DOMPointReadOnly[];
  planeSpace: { at: [number, number, number] | null };
}

const point = (x: number, z: number) => ({ x, y: 0, z, w: 1 }) as DOMPointReadOnly;
const outline = [point(-0.5, -0.3), point(0.5, -0.3), point(0.5, 0.3), point(-0.5, 0.3)];

const fakePlane = (over: Partial<FakePlane> = {}): FakePlane => ({
  orientation: 'horizontal',
  semanticLabel: 'table',
  lastChangedTime: 100,
  polygon: outline,
  planeSpace: { at: [0.2, 0.75, -0.6] },
  ...over,
});

const translation = ([x, y, z]: [number, number, number]) =>
  new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);

function fakeFrame(planes: FakePlane[] | (() => never) | undefined): XRFrame {
  const frame = {
    getPose: (space: FakePlane['planeSpace']) =>
      space.at ? { transform: { matrix: translation(space.at) } } : null,
  };
  if (typeof planes === 'function') Object.defineProperty(frame, 'detectedPlanes', { get: planes });
  else if (planes) Object.assign(frame, { detectedPlanes: new Set(planes) });
  return frame as unknown as XRFrame;
}

const space = {} as XRReferenceSpace;

describe('XrPlaneReader', () => {
  it('reads horizontal and vertical planes with their pose, outline, label and change time', () => {
    const wall = fakePlane({
      orientation: 'vertical',
      semanticLabel: undefined,
      lastChangedTime: 250,
      planeSpace: { at: [0, 1.3, -2] },
    });
    const planes = new XrPlaneReader().read(fakeFrame([fakePlane(), wall]), space);
    expect(planes).toHaveLength(2);
    const [table, other] = planes;
    expect(table).toMatchObject({
      key: 'plane-1',
      orientation: 'horizontal',
      label: 'table',
      polygon: [
        [-0.5, -0.3],
        [0.5, -0.3],
        [0.5, 0.3],
        [-0.5, 0.3],
      ],
      changedAt: 100,
    });
    expect(table?.pose.p.map((v) => Math.round(v * 1e4) / 1e4)).toEqual([0.2, 0.75, -0.6]);
    expect(table?.pose.q).toEqual([0, 0, 0, 1]);
    expect(other).toMatchObject({ key: 'plane-2', orientation: 'vertical', label: null });
    expect(other?.changedAt).toBe(250);
  });

  it('keeps each plane its key across frames, numbering new planes as they are first seen', () => {
    const reader = new XrPlaneReader();
    const floor = fakePlane({ semanticLabel: 'floor' });
    const table = fakePlane();
    const wall = fakePlane({ orientation: 'vertical', semanticLabel: 'wall' });
    const keys = (planes: FakePlane[]) => reader.read(fakeFrame(planes), space).map((p) => p.key);
    expect(keys([floor, table])).toEqual(['plane-1', 'plane-2']);
    expect(keys([table, wall])).toEqual(['plane-2', 'plane-3']);
    expect(keys([wall, floor, table])).toEqual(['plane-3', 'plane-1', 'plane-2']);
  });

  it('skips planes without a pose this frame or without a known orientation', () => {
    const planes = new XrPlaneReader().read(
      fakeFrame([
        fakePlane({ planeSpace: { at: null } }),
        fakePlane({ orientation: 'slanted' }),
        fakePlane({ semanticLabel: 'desk' }),
      ]),
      space,
    );
    expect(planes.map((p) => p.label)).toEqual(['desk']);
  });

  it('reads nothing from a frame without plane detection', () => {
    expect(new XrPlaneReader().read(fakeFrame(undefined), space)).toEqual([]);
  });

  it('turns itself off once reading the planes throws, and says so once', () => {
    const errors: unknown[] = [];
    const reader = new XrPlaneReader((err) => errors.push(err));
    let reads = 0;
    const throwing = () => {
      reads++;
      throw new Error('plane-detection is not enabled');
    };
    expect(reader.read(fakeFrame(throwing), space)).toEqual([]);
    expect(reader.read(fakeFrame([fakePlane()]), space)).toEqual([]);
    expect(reader.read(fakeFrame(throwing), space)).toEqual([]);
    expect(reads).toBe(1);
    expect(errors).toHaveLength(1);
  });
});

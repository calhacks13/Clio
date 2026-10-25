import { HAND_JOINTS } from '@clio/protocol';
import { type Mesh, type MeshBasicMaterial, type MeshStandardMaterial, Quaternion } from 'three';
import { describe, expect, it } from 'vitest';
import { HandsView } from '../../src/tracking/hands';
import { surfaceKind, surfaceTitle } from '../../src/tracking/palette';
import { PinchLatch } from '../../src/tracking/pinch-latch';
import { type Point2, polygonCentroid, polygonGrid } from '../../src/tracking/polygon';

const square = (half: number): Point2[] => [
  [-half, -half],
  [half, -half],
  [half, half],
  [-half, half],
];

describe('surfaceKind', () => {
  it('groups semantic labels into the colors the page draws', () => {
    expect(surfaceKind('table')).toBe('table');
    expect(surfaceKind('desk')).toBe('table');
    expect(surfaceKind('Floor')).toBe('floor');
    expect(surfaceKind('window frame')).toBe('wall');
    expect(surfaceKind('ceiling')).toBe('ceiling');
    expect(surfaceKind('couch')).toBe('couch');
    expect(surfaceKind('global mesh')).toBe('other');
    expect(surfaceKind(undefined)).toBe('other');
  });

  it('titles a plane with its own label', () => {
    expect(surfaceTitle('wall art')).toBe('Wall art');
    expect(surfaceTitle(undefined)).toBe('Other');
  });
});

describe('polygonCentroid', () => {
  it('finds the area center, not the vertex mean', () => {
    // An L: a 2 x 1 bar plus a 1 x 1 block on its left end. Extra vertices along the bar's top
    // would pull a vertex mean right; the area center stays put.
    const l: Point2[] = [
      [0, 0],
      [2, 0],
      [2, 1],
      [1.5, 1],
      [1, 1],
      [1, 2],
      [0, 2],
    ];
    const [x, y] = polygonCentroid(l);
    expect(x).toBeCloseTo(5 / 6);
    expect(y).toBeCloseTo(5 / 6);
  });

  it('falls back to the vertex mean for a degenerate polygon', () => {
    expect(
      polygonCentroid([
        [0, 0],
        [2, 0],
        [4, 0],
      ] as Point2[]),
    ).toEqual([2, 0]);
  });
});

describe('polygonGrid', () => {
  it('draws interior lines only, clipped to the outline', () => {
    const segments = polygonGrid(square(0.5), 0.25);
    // x = -0.25, 0, 0.25 and z the same: the lines on the outline are left out.
    expect(segments).toHaveLength(6);
    for (const [a, b] of segments) {
      for (const p of [a, b]) {
        expect(Math.abs(p[0])).toBeLessThanOrEqual(0.5 + 1e-9);
        expect(Math.abs(p[1])).toBeLessThanOrEqual(0.5 + 1e-9);
      }
    }
    expect(segments[1]).toEqual([
      [0, -0.5],
      [0, 0.5],
    ]);
  });

  it('splits a line that crosses a concave notch', () => {
    // A U: the line x = 0 passes through the notch and must not be drawn across it.
    const u: Point2[] = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [0.5, 1],
      [0.5, -0.5],
      [-0.5, -0.5],
      [-0.5, 1],
      [-1, 1],
    ];
    const atZeroX = polygonGrid(u, 1).filter(([a, b]) => a[0] === 0 && b[0] === 0);
    expect(atZeroX).toEqual([
      [
        [0, -1],
        [0, -0.5],
      ],
    ]);
    const atZeroZ = polygonGrid(u, 1).filter(([a, b]) => a[1] === 0 && b[1] === 0);
    expect(atZeroZ).toEqual([
      [
        [-1, 0],
        [-0.5, 0],
      ],
      [
        [0.5, 0],
        [1, 0],
      ],
    ]);
  });

  it('returns nothing for a patch between grid lines or a bad spacing', () => {
    const patch: Point2[] = [
      [0.05, 0.05],
      [0.2, 0.05],
      [0.2, 0.2],
      [0.05, 0.2],
    ];
    expect(polygonGrid(patch, 0.25)).toEqual([]);
    expect(polygonGrid(square(1), 0)).toEqual([]);
  });
});

describe('PinchLatch', () => {
  it('starts and ends with hysteresis', () => {
    const latch = new PinchLatch();
    expect(latch.update(0.03, 0)).toBe(false);
    expect(latch.update(0.019, 10)).toBe(true);
    // Between the start (2 cm) and end (3.5 cm) distances it holds.
    expect(latch.update(0.03, 20)).toBe(true);
    expect(latch.update(0.036, 30)).toBe(false);
    expect(latch.update(0.03, 40)).toBe(false);
  });

  it('rides out a short tracking dropout, then lets go', () => {
    const latch = new PinchLatch();
    latch.update(0.01, 0);
    expect(latch.update(null, 100)).toBe(true);
    expect(latch.update(null, 200)).toBe(false);
  });
});

describe('HandsView', () => {
  /** A frame with only a left hand, every joint at the origin: the tips touch, so it pinches. */
  const leftHandFrame = (): XRFrame => {
    const joints = new Map<string, object>(HAND_JOINTS.map((name) => [name, { jointName: name }]));
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    return {
      session: {
        inputSources: [{ handedness: 'left', hand: { get: (name: string) => joints.get(name) } }],
      },
      fillPoses: (spaces: unknown[], _space: unknown, out: Float32Array) => {
        for (let i = 0; i < spaces.length; i++) out.set(identity, i * 16);
        return true;
      },
      fillJointRadii: (_spaces: unknown[], out: Float32Array) => {
        out.fill(0.01);
        return true;
      },
    } as unknown as XRFrame;
  };

  it('draws a tracked hand in its given colors and lights the pinch ring', () => {
    const view = new HandsView({ left: 0x9aa7b8, right: 0x9aa7b8, pinch: 0xd7dfe8 });
    view.update(leftHandFrame(), {} as XRReferenceSpace, 0, new Quaternion());
    expect(view.tracked).toEqual({ left: true, right: false });
    const parts = view.object.children[0]?.children ?? [];
    const joints = parts[0] as Mesh;
    const ring = parts[2] as Mesh;
    expect((joints.material as MeshStandardMaterial).color.getHex()).toBe(0x9aa7b8);
    expect((ring.material as MeshBasicMaterial).color.getHex()).toBe(0xd7dfe8);
    expect(view.object.children[1]?.visible).toBe(false);
  });
});

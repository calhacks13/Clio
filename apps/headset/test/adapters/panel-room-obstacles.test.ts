import { describe, expect, it } from 'vitest';
import { panelRoomObstacles } from '../../src/adapters/render/panel-room-obstacles';
import { type Pose, quatFromAxisAngle, transformPoint, type Vec3 } from '../../src/core/math';
import type { DetectedPlane } from '../../src/domain/world/environment';

const HEAD: Pose = { p: [0, 1.6, 0], q: [0, 0, 0, 1] };
const table = (over: Partial<DetectedPlane> = {}): DetectedPlane => ({
  key: 'table',
  orientation: 'horizontal',
  label: 'table',
  pose: { p: [0, 0.75, -1], q: [0, 0, 0, 1] },
  polygon: [
    [-0.5, -0.3],
    [0.5, -0.3],
    [0.5, 0.3],
    [-0.5, 0.3],
  ],
  changedAt: 0,
  ...over,
});

describe('panelRoomObstacles', () => {
  it('reserves the measured table plus 18cm of presentation space above it before a lesson', () => {
    const detected = table();
    const before = structuredClone(detected);
    const points = panelRoomObstacles([detected], HEAD)[0];
    expect(points).toHaveLength(8);
    expect(points?.slice(0, 4)).toEqual([
      [-0.5, 0.75, -1.3],
      [0.5, 0.75, -1.3],
      [0.5, 0.75, -0.7],
      [-0.5, 0.75, -0.7],
    ]);
    for (let i = 0; i < 4; i++) {
      expect(points?.[i + 4]?.[0]).toBe(points?.[i]?.[0]);
      expect(points?.[i + 4]?.[1]).toBeCloseTo(0.93, 12);
      expect(points?.[i + 4]?.[2]).toBe(points?.[i]?.[2]);
    }
    expect(detected).toEqual(before);
  });

  it('keeps world transforms when a shifted learner looks down at a rotated desk', () => {
    const head: Pose = { p: [2, 1.65, 3], q: quatFromAxisAngle([1, 0, 0], -0.6) };
    const pose: Pose = { p: [2.2, 0.8, 2.1], q: quatFromAxisAngle([0, 1, 0], 0.8) };
    const detected = table({ label: 'desk', pose });
    const points = panelRoomObstacles([detected], head)[0];
    for (let i = 0; i < detected.polygon.length; i++) {
      const [x, z] = detected.polygon[i] ?? [0, 0];
      const world = transformPoint(pose, [x, 0, z]);
      expect(points?.[i]).toEqual(world);
      expect(points?.[i + 4]).toEqual([world[0], world[1] + 0.18, world[2]]);
    }
    // Looking around changes the view projection, never the measured obstacle coordinates.
    expect(panelRoomObstacles([detected], { ...head, q: [0, 0, 0, 1] })).toEqual([points]);
  });

  it('keeps a slightly tilted worktop and reserves world-up clearance', () => {
    const pose: Pose = { p: [0, 0.75, -1], q: quatFromAxisAngle([1, 0, 0], 0.15) };
    const points = panelRoomObstacles([table({ pose })], HEAD)[0];
    const first = transformPoint(pose, [-0.5, 0, -0.3]);
    expect(points?.[0]).toEqual(first);
    expect(points?.[4]).toEqual([first[0], first[1] + 0.18, first[2]]);
  });

  it('excludes room structure even when it is nearby or mislabeled horizontal', () => {
    const labels = [
      'floor',
      'wall',
      'ceiling',
      'door',
      'door frame',
      'window',
      'window frame',
      'wall art',
      'invisible wall face',
      'room',
      'global mesh',
    ];
    expect(
      panelRoomObstacles(
        labels.map((label) => table({ label })),
        HEAD,
      ),
    ).toEqual([]);
  });

  it('keeps known furniture including vertical couch backs without inventing a worktop', () => {
    const labels = ['couch', 'sofa', 'chair', 'bed', 'cabinet', 'shelf'];
    const pose: Pose = { p: [0, 0.9, -1], q: quatFromAxisAngle([1, 0, 0], Math.PI / 2) };
    const groups = panelRoomObstacles(
      labels.map((label) => table({ label, orientation: 'vertical', pose })),
      HEAD,
    );
    expect(groups).toHaveLength(labels.length);
    for (const points of groups) {
      expect(points).toHaveLength(4);
      expect(points[0]).toEqual(transformPoint(pose, [-0.5, 0, -0.3]));
    }
  });

  it('accepts a bounded unlabeled worktop but excludes floors, overhead and whole-room planes', () => {
    expect(panelRoomObstacles([table({ label: null })], HEAD)[0]).toHaveLength(8);
    const shifted = (y: number) => table({ label: null, pose: { p: [0, y, -1], q: HEAD.q } });
    const large = table({
      label: null,
      polygon: [
        [-3, -3],
        [3, -3],
        [3, 3],
        [-3, 3],
      ],
    });
    expect(panelRoomObstacles([shifted(0), shifted(1.8), large], HEAD)).toEqual([]);
    expect(panelRoomObstacles([table({ label: null, orientation: 'vertical' })], HEAD)).toEqual([]);
  });

  it('ignores distant furniture while keeping the near end of a bounded surface', () => {
    const far = table({ pose: { p: [0, 0.75, -5], q: HEAD.q } });
    const nearEdge = table({ pose: { p: [0, 0.75, -3.1], q: HEAD.q } });
    expect(panelRoomObstacles([far], HEAD)).toEqual([]);
    expect(panelRoomObstacles([nearEdge], HEAD)).toHaveLength(1);
  });

  it('discards invalid and degenerate planes without poisoning valid obstacles', () => {
    const invalid: DetectedPlane[] = [
      table({
        polygon: [
          [0, 0],
          [1, 0],
        ],
      }),
      table({
        polygon: [
          [0, 0],
          [0, 0],
          [0, 0],
        ],
      }),
      table({
        polygon: [
          [0, 0],
          [1, Number.NaN],
          [1, 1],
        ],
      }),
      table({ pose: { p: [Infinity, 0, 0], q: HEAD.q } }),
      table({ pose: { p: [0, 0.75, -1], q: [0, 0, 0, 0] } }),
      table({ pose: { p: [0, 0.75, -1], q: [Number.NaN, 0, 0, 1] } }),
      table({
        polygon: [
          [1e308, 0],
          [0, 1e308],
          [-1e308, 0],
        ],
      }),
    ];
    expect(panelRoomObstacles(invalid, HEAD)).toEqual([]);
    const groups = panelRoomObstacles([...invalid, table()], HEAD);
    expect(groups).toHaveLength(1);
    expect(groups.flat().every((p: Vec3) => p.every(Number.isFinite))).toBe(true);
    expect(panelRoomObstacles([table()], { ...HEAD, p: [NaN, 0, 0] })).toEqual([]);
  });
});

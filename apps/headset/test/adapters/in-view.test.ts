import { describe, expect, it } from 'vitest';
import {
  facingEye,
  gazeHeading,
  gazePitch,
  IN_VIEW_RAD,
  keepInView,
  panelPlace,
} from '../../src/adapters/render/in-view';
import {
  dot,
  normalize,
  type Quat,
  quatFromAxisAngle,
  quatMultiply,
  rotateVec,
  sub,
  type Vec3,
} from '../../src/core/math';

const DEG = Math.PI / 180;
/** A head turned `yaw` degrees left, then pitched `pitch` degrees up (negative: down). */
const look = (yaw: number, pitch: number): Quat =>
  quatMultiply(quatFromAxisAngle([0, 1, 0], yaw * DEG), quatFromAxisAngle([1, 0, 0], pitch * DEG));

/** The angle (rad) between the gaze and the direction from the eye to `point`. */
function offGaze(q: Quat, eye: Vec3, point: Vec3): number {
  const gaze = rotateVec(q, [0, 0, -1]);
  return Math.acos(Math.min(1, dot(gaze, normalize(sub(point, eye)))));
}

// The instruction card's rest: 0.65 m ahead, 0.17 m below the eyes.
const AHEAD = 0.65;
const DROP = 0.17;
const eye: Vec3 = [0.2, 1.4, -0.3];

describe('panelPlace', () => {
  it('rests where the heading-only placement did while the learner looks ahead', () => {
    const q = look(30, 0);
    const place = panelPlace({ p: eye, q }, AHEAD, DROP);
    const ahead = rotateVec(look(30, 0), [0, 0, -AHEAD]);
    expect(place.point[0]).toBeCloseTo(eye[0] + ahead[0], 9);
    expect(place.point[1]).toBeCloseTo(eye[1] - DROP, 9);
    expect(place.point[2]).toBeCloseTo(eye[2] + ahead[2], 9);
  });

  it('stays in view, just above the gaze, when the learner leans over the table and looks down', () => {
    for (const pitch of [-50, -65, -80, -90]) {
      const q = look(-20, pitch);
      const place = panelPlace({ p: eye, q }, AHEAD, DROP);
      expect(offGaze(q, eye, place.point)).toBeCloseTo(IN_VIEW_RAD, 6);
      // Above the gaze, never over the work, and as far from the eyes as at rest.
      expect(place.elevation).toBeGreaterThan(gazePitch(q));
      expect(Math.hypot(...sub(place.point, eye))).toBeCloseTo(Math.hypot(AHEAD, DROP), 9);
      // The heading-only card would sit at eye height minus 17 cm: far outside Quest 3's
      // 96-degree vertical view (48 degrees either side of the gaze).
      const old: Vec3 = [
        eye[0] + rotateVec(look(-20, 0), [0, 0, -AHEAD])[0],
        eye[1] - DROP,
        eye[2] + rotateVec(look(-20, 0), [0, 0, -AHEAD])[2],
      ];
      if (pitch <= -65) expect(offGaze(q, eye, old)).toBeGreaterThan(48 * DEG);
    }
  });

  it('stays in view looking up as well', () => {
    const q = look(0, 50);
    const place = panelPlace({ p: eye, q }, AHEAD, DROP);
    expect(offGaze(q, eye, place.point)).toBeCloseTo(IN_VIEW_RAD, 6);
    expect(place.elevation).toBeLessThan(gazePitch(q));
  });

  it('keeps a steady heading looking straight down, where the forward vector has none', () => {
    const straight = gazeHeading(look(40, -90));
    const nearly = gazeHeading(look(40, -89.5));
    const yaw = rotateVec(look(40, 0), [0, 0, -1]);
    expect(straight?.[0]).toBeCloseTo(yaw[0], 6);
    expect(straight?.[1]).toBeCloseTo(yaw[2], 6);
    expect(nearly?.[0]).toBeCloseTo(yaw[0], 6);
    expect(nearly?.[1]).toBeCloseTo(yaw[2], 6);
    expect(gazeHeading(look(40, 89))?.[1]).toBeCloseTo(yaw[2], 6);
  });
});

describe('keepInView', () => {
  it('keeps the rest elevation within reach of the gaze, and only moves it as far as needed', () => {
    const rest = -15 * DEG;
    expect(keepInView(rest, 0)).toBe(rest);
    expect(keepInView(rest, -30 * DEG)).toBe(rest);
    expect(keepInView(rest, -60 * DEG)).toBeCloseTo(-60 * DEG + IN_VIEW_RAD, 12);
    expect(keepInView(rest, 40 * DEG)).toBeCloseTo(40 * DEG - IN_VIEW_RAD, 12);
  });
});

describe('facingEye', () => {
  it('turns the panel (+z) toward the eye and keeps its x axis level', () => {
    for (const [yaw, pitch] of [
      [0, 0],
      [30, -70],
      [-120, -90],
      [75, 45],
    ] as const) {
      const q = look(yaw, pitch);
      const place = panelPlace({ p: eye, q }, AHEAD, DROP);
      const facing = facingEye(place.heading, place.elevation);
      const normal = rotateVec(facing, [0, 0, 1]);
      const toEye = normalize(sub(eye, place.point));
      expect(dot(normal, toEye)).toBeCloseTo(1, 9);
      expect(rotateVec(facing, [1, 0, 0])[1]).toBeCloseTo(0, 9);
      expect(rotateVec(facing, [0, 1, 0])[1]).toBeGreaterThan(0);
    }
  });
});

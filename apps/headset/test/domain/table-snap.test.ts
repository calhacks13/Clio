import { describe, expect, it } from 'vitest';
import {
  type Pose,
  quatFromAxisAngle,
  rotateVec,
  transformPoint,
  type Vec3,
} from '../../src/core/math';
import { chooseTablePlane, fitTable, type TablePlane } from '../../src/domain/world/table-snap';
import { Workspace } from '../../src/domain/world/workspace';

const near = (a: readonly number[], b: readonly number[], eps = 1e-6) =>
  a.every((v, i) => Math.abs(v - (b[i] ?? Number.NaN)) < eps);

const yaw = (angle: number) => quatFromAxisAngle([0, 1, 0], angle);

/** A head 1.6 m up, turned `angle` from -z toward -x (WebXR yaw). */
const headAt = (p: Vec3 = [0, 1.6, 0], angle = 0): Pose => ({ p: [...p], q: yaw(angle) });

/** A w × d rectangle centered on `center`, turned `angle` about +y. */
function plane(
  label: string | null,
  center: Vec3,
  [w, d]: [number, number],
  angle = 0,
): TablePlane {
  return {
    label,
    pose: { p: center, q: yaw(angle) },
    polygon: [
      [-w / 2, -d / 2],
      [w / 2, -d / 2],
      [w / 2, d / 2],
      [-w / 2, d / 2],
    ],
  };
}

const floor = plane('floor', [0, 0, 0], [6, 6]);
const ceiling = plane('ceiling', [0, 2.6, 0], [6, 6]);

describe('chooseTablePlane', () => {
  it('prefers a plane labeled table or desk over a larger unlabeled surface', () => {
    const table = plane('table', [0, 0.75, -0.6], [0.8, 0.5]);
    const counter = plane('other', [0.4, 0.9, -0.9], [2, 1]);
    expect(chooseTablePlane([floor, counter, table], headAt())).toEqual({
      plane: table,
      by: 'label',
    });
    const desk = plane('DESK', [0, 0.72, -0.6], [1.2, 0.6]);
    expect(chooseTablePlane([counter, desk], headAt())?.plane).toBe(desk);
  });

  it('takes the nearest labeled table in front and within reach', () => {
    const close = plane('table', [0, 0.75, -0.7], [0.6, 0.4]);
    const further = plane('table', [0.3, 0.75, -1.3], [1.5, 0.6]);
    const behind = plane('table', [0, 0.75, 0.6], [0.8, 0.5]);
    const beside = plane('desk', [0.9, 0.75, 0], [0.6, 0.6]);
    const outOfReach = plane('table', [0, 0.75, -2.5], [1, 1]);
    expect(chooseTablePlane([further, behind, close], headAt())?.plane).toBe(close);
    expect(chooseTablePlane([behind, beside, outOfReach], headAt())).toBeNull();
    // A step or two away still counts: the user may start before walking up to the table.
    const coffeeTable = plane('table', [0, 0.42, -1.95], [1.15, 0.6]);
    expect(chooseTablePlane([floor, coffeeTable, outOfReach], headAt())?.plane).toBe(coffeeTable);
    // Turn around and the table behind is the one in front.
    expect(chooseTablePlane([behind, close], headAt([0, 1.6, 0], Math.PI))?.plane).toBe(behind);
  });

  it('falls back to the largest surface at table height in front of the user', () => {
    const coffeeTable = plane('other', [0, 0.4, -0.8], [1.2, 0.6]);
    const small = plane(null, [-0.3, 0.74, -0.6], [0.5, 0.4]);
    const large = plane('other', [0.2, 0.92, -0.7], [1.2, 0.6]);
    const shelf = plane(null, [0, 1.4, -0.5], [1.5, 0.4]);
    const couch = plane('couch', [0, 0.5, -0.6], [2, 0.9]);
    const tiny = plane(null, [0, 0.8, -0.4], [0.2, 0.2]);
    const all = [floor, ceiling, coffeeTable, small, large, shelf, couch, tiny];
    expect(chooseTablePlane(all, headAt())).toEqual({ plane: large, by: 'size' });
    expect(chooseTablePlane([floor, coffeeTable, small, shelf], headAt())?.plane).toBe(small);
  });

  it('returns null when nothing qualifies', () => {
    expect(chooseTablePlane([], headAt())).toBeNull();
    const stool = plane(null, [0, 0.6, -0.5], [0.25, 0.25]);
    const sideboard = plane(null, [-1.6, 0.9, -0.2], [1.5, 0.5]);
    expect(chooseTablePlane([floor, ceiling, stool, sideboard], headAt())).toBeNull();
  });
});

describe('fitTable', () => {
  it('puts the origin at the near-left corner with +x along the near edge and the table at z < 0', () => {
    const table = plane('table', [0.1, 0.74, -0.6], [0.5, 0.4]);
    const fit = fitTable(table, headAt());
    expect(near(fit.pose.p, [-0.15, 0.74, -0.4])).toBe(true);
    expect(near(fit.size, [0.5, 0.4])).toBe(true);
    const ws = new Workspace(fit.pose);
    expect(near(ws.toWorkspacePoint([0.35, 0.74, -0.8]), [0.5, 0, -0.4])).toBe(true);
  });

  it('centers the work area on the user along a wide table without leaving the table', () => {
    const table = plane('table', [0, 0.75, -0.7], [1.6, 0.8]);
    expect(near(fitTable(table, headAt()).pose.p, [-0.3, 0.75, -0.3])).toBe(true);
    expect(near(fitTable(table, headAt([0.4, 1.6, 0])).pose.p, [0.1, 0.75, -0.3])).toBe(true);
    // Near either end, the work area stops at the table's corner.
    expect(near(fitTable(table, headAt([-0.7, 1.6, 0])).pose.p, [-0.8, 0.75, -0.3])).toBe(true);
    expect(near(fitTable(table, headAt([0.75, 1.6, 0])).pose.p, [0.2, 0.75, -0.3])).toBe(true);
  });

  it('follows a rotated table and takes the side the user stands at', () => {
    const angle = Math.PI / 6;
    const table = plane('table', [0.5, 0.75, -0.8], [0.5, 0.4], angle);
    // Stand 0.3 m from the middle of the table's local +z side; then look 50° off to the left.
    const standing = transformPoint(table.pose, [0, 0.85, 0.5]);
    for (const look of [angle, angle + 0.87]) {
      const fit = fitTable(table, headAt(standing, look));
      expect(near(fit.pose.p, transformPoint(table.pose, [-0.25, 0, 0.2]))).toBe(true);
      expect(near(rotateVec(fit.pose.q, [1, 0, 0]), rotateVec(table.pose.q, [1, 0, 0]))).toBe(true);
      expect(near(fit.size, [0.5, 0.4])).toBe(true);
    }
    // From the table's short side, that side is the near edge.
    const fromEnd = fitTable(
      table,
      headAt(transformPoint(table.pose, [0.6, 0.85, 0]), angle + Math.PI / 2),
    );
    expect(near(fromEnd.pose.p, transformPoint(table.pose, [0.25, 0, 0.2]))).toBe(true);
    expect(near(fromEnd.size, [0.4, 0.5])).toBe(true);
  });

  it('squares the frame to the edges of a concave, rotated outline', () => {
    // An L-shaped desk: a 1.6 m near edge, 0.6 m deep, with a return 0.6 m wide running back on
    // the left to 1.3 m deep. Turned 40° and seen from 0.5 m in front of the near edge.
    const angle = -0.7;
    const desk: TablePlane = {
      label: 'desk',
      pose: { p: [0.2, 0.75, -0.9], q: yaw(angle) },
      polygon: [
        [-0.8, 0.3],
        [0.8, 0.3],
        [0.8, -0.3],
        [-0.2, -0.3],
        [-0.2, -1],
        [-0.8, -1],
      ],
    };
    const head = headAt(transformPoint(desk.pose, [0, 0.85, 0.8]), angle);
    expect(chooseTablePlane([floor, desk], head)?.plane).toBe(desk);
    const fit = fitTable(desk, head);
    expect(near(fit.pose.p, transformPoint(desk.pose, [-0.3, 0, 0.3]))).toBe(true);
    expect(near(rotateVec(fit.pose.q, [1, 0, 0]), rotateVec(desk.pose.q, [1, 0, 0]))).toBe(true);
    expect(near(fit.size, [1.6, 1.3])).toBe(true);
  });

  it("aligns a round table with the user's heading", () => {
    const look = 0.5;
    const center: Vec3 = [-Math.sin(look) * 0.8, 0.75, -Math.cos(look) * 0.8];
    const sides = 16;
    const round: TablePlane = {
      label: 'table',
      pose: { p: center, q: [0, 0, 0, 1] },
      polygon: Array.from({ length: sides }, (_, i) => {
        const a = (i / sides) * 2 * Math.PI;
        return [0.4 * Math.cos(a), 0.4 * Math.sin(a)] as const;
      }),
    };
    const fit = fitTable(round, headAt([0, 1.6, 0], look));
    expect(near(rotateVec(fit.pose.q, [1, 0, 0]), rotateVec(yaw(look), [1, 0, 0]))).toBe(true);
    const local = new Workspace(fit.pose).toWorkspacePoint(center);
    expect(near(local.slice(0, 2), [0.3, 0])).toBe(true);
    expect(local[2]).toBeLessThan(-0.35);
  });
});

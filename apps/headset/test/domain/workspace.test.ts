import { describe, expect, it } from 'vitest';
import { quatFromAxisAngle } from '../../src/core/math';
import { jointPosition } from '../../src/domain/hands/features';
import {
  Workspace,
  workspaceFromCorners,
  workspaceInFrontOf,
} from '../../src/domain/world/workspace';
import { makeHand } from '../support/hands';

const near = (a: readonly number[], b: readonly number[], eps = 1e-6) =>
  a.every((v, i) => Math.abs(v - (b[i] ?? Number.NaN)) < eps);

describe('workspace calibration', () => {
  it('puts the origin at the first corner with +x toward the second and the table at z < 0', () => {
    const ws = new Workspace(workspaceFromCorners([-0.4, 0.75, -0.5], [0.4, 0.75, -0.5]));
    expect(near(ws.toWorkspacePoint([0, 0.75, -0.9]), [0.4, 0, -0.4])).toBe(true);
  });

  it('levels the frame using the mean corner height', () => {
    const pose = workspaceFromCorners([-0.4, 0.74, -0.5], [0.4, 0.76, -0.5]);
    expect(pose.p[1]).toBeCloseTo(0.75);
    const ws = new Workspace(pose);
    expect(ws.toWorkspacePoint([0.4, 0.75, -0.5])[1]).toBeCloseTo(0);
  });

  it('follows a table edge that is not aligned with the world axes', () => {
    const ws = new Workspace(workspaceFromCorners([0, 0.75, 0], [0, 0.75, -1]));
    // Second corner straight ahead: workspace +x is world -z, so world +x is workspace +z.
    expect(near(ws.toWorkspacePoint([0, 0.75, -0.5]), [0.5, 0, 0])).toBe(true);
    expect(near(ws.toWorkspacePoint([0.2, 0.75, 0]), [0, 0, 0.2])).toBe(true);
  });

  it('rejects corners too close together to define an edge', () => {
    expect(() => workspaceFromCorners([0, 0.75, -0.5], [0.05, 0.75, -0.5])).toThrow(/too close/);
  });

  it('can place a default workspace in front of the user', () => {
    const pose = workspaceInFrontOf(
      { p: [0, 1.6, 0], q: [0, 0, 0, 1] },
      { forward: 0.45, below: 0.45, width: 0.6 },
    );
    expect(near(pose.p, [-0.3, 1.15, -0.45])).toBe(true);
  });

  it('ignores head pitch when placing the default workspace', () => {
    const lookingDown = quatFromAxisAngle([1, 0, 0], -0.6);
    const pose = workspaceInFrontOf(
      { p: [0, 1.6, 0], q: lookingDown },
      { forward: 0.45, below: 0.45, width: 0.6 },
    );
    expect(near(pose.p, [-0.3, 1.15, -0.45])).toBe(true);
  });
});

describe('workspace transforms', () => {
  it('moves every hand joint into the workspace frame and keeps the aperture', () => {
    const ws = new Workspace({ p: [1, 0.8, -1], q: [0, 0, 0, 1] });
    const hand = makeHand({ 'index-finger-tip': [1.1, 0.8, -1.2], 'thumb-tip': [1.1, 0.8, -1.18] });
    const local = ws.toWorkspaceHand(hand);
    expect(near(jointPosition(local, 'index-finger-tip'), [0.1, 0, -0.2])).toBe(true);
    expect(local.pinch).toBeCloseTo(0.02);
  });
});

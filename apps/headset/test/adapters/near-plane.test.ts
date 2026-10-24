import { Matrix4 } from 'three';
import { describe, expect, it, vi } from 'vitest';
import {
  clampNear,
  keepNearPlane,
  NEAR_PLANE_M,
  projectionNear,
} from '../../src/adapters/xr/near-plane';

describe('clampNear', () => {
  it("holds three's depth-map near plane (Quest: 0.1 m) at the cameras' own", () => {
    expect(clampNear({ depthNear: 0.1, depthFar: 50 }, NEAR_PLANE_M)).toEqual({
      depthNear: NEAR_PLANE_M,
      depthFar: 50,
    });
  });

  it('leaves a nearer plane, and every other field, as asked', () => {
    expect(clampNear({ depthNear: 0.005 }, 0.01)).toEqual({ depthNear: 0.005 });
    const baseLayer = {} as XRWebGLLayer;
    expect(clampNear({ baseLayer }, 0.01)).toEqual({ baseLayer });
    expect(clampNear(undefined, 0.01)).toEqual({});
  });
});

describe('keepNearPlane', () => {
  it('wraps the session so later render states keep the near plane, until restored', () => {
    const update = vi.fn();
    const session = { updateRenderState: update };
    const restore = keepNearPlane(session);
    // What three's WebXRManager.updateCamera sends once the depth map reports depthNear 0.1.
    session.updateRenderState({ depthNear: 0.1, depthFar: 50 });
    expect(update).toHaveBeenLastCalledWith({ depthNear: NEAR_PLANE_M, depthFar: 50 });
    expect(update.mock.contexts[0]).toBe(session);
    restore();
    expect(session.updateRenderState).toBe(update);
  });
});

describe('projectionNear', () => {
  it('reads the near plane of a finite or infinite perspective projection', () => {
    const finite = new Matrix4().makePerspective(-0.1, 0.1, 0.1, -0.1, 0.1, 50);
    expect(projectionNear(finite.elements)).toBeCloseTo(0.1, 9);
    const infinite = new Matrix4().makePerspective(-0.01, 0.01, 0.01, -0.01, 0.01, 50).elements;
    // An infinite far plane (WebXR may hand those out): m[10] = -1, m[14] = -2 near.
    infinite[10] = -1;
    infinite[14] = -0.02;
    expect(projectionNear(infinite)).toBeCloseTo(0.01, 9);
    expect(projectionNear(new Matrix4().elements)).toBeNull();
  });
});

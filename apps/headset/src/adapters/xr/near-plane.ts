// The XR views' near clipping plane. three.js (0.186) moves it to the depth map's depthNear
// whenever the session has a gpu-optimized depth texture (WebXRManager.updateCamera: Quest
// Browser reports 0.1 m), so it can draw its own occlusion straight into the depth buffer. Clio
// keeps that occlusion off (disableXrDepthOcclusion) and decodes depth with each map's own
// depthNear (depth-sensing.ts, glow/depth-occlusion.ts), never the render state's, so the move
// only clips content within 10 cm of the eyes: a label or a glow when a learner leans right over
// the table, a hand skeleton near the face. keepNearPlane holds the session's render state at the
// pages' own camera near instead.

/** The near plane Clio's cameras ask for (m). */
export const NEAR_PLANE_M = 0.01;

interface RenderStateSession {
  updateRenderState(state?: XRRenderStateInit): void;
}

/** `state` with its depthNear no further than `near` (m); other fields as given. */
export function clampNear(state: XRRenderStateInit | undefined, near: number): XRRenderStateInit {
  if (!state || typeof state.depthNear !== 'number' || !(state.depthNear > near)) {
    return { ...state };
  }
  return { ...state, depthNear: near };
}

/**
 * Every later updateRenderState on `session` keeps depthNear at most `near` (m). Call before
 * handing the session to three.js. Returns a function that restores the original method.
 */
export function keepNearPlane(session: RenderStateSession, near = NEAR_PLANE_M): () => void {
  const original = session.updateRenderState;
  session.updateRenderState = function (this: RenderStateSession, state?: XRRenderStateInit) {
    original.call(this, clampNear(state, near));
  };
  return () => {
    session.updateRenderState = original;
  };
}

/**
 * The near plane (m) of a perspective projection (column-major, as WebXR and three.js hand them
 * out), finite or infinite far; null when the matrix is not one.
 */
export function projectionNear(m: ArrayLike<number>): number | null {
  const a = m[10] ?? 0;
  const b = m[14] ?? 0;
  if (!(Math.abs(a - 1) > 1e-9)) return null;
  const near = b / (a - 1);
  return Number.isFinite(near) && near > 0 ? near : null;
}

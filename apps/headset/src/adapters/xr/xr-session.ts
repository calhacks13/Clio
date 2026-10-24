import type { WebGLRenderer } from 'three';
import { depthSensingInit, disableXrDepthOcclusion } from './depth-sensing';
import { installNearPlaneDebug, keepNearPlane } from './near-plane';

// Starts an immersive-ar (passthrough) session and hands it to three.js. Every feature beyond
// local-floor is optional, so the app degrades instead of refusing to start. The near plane stays
// at 1 cm (near-plane.ts): three would move it to the depth map's 10 cm, clipping what a learner
// leaning over the table sees up close.

export interface XrSessionOptions {
  /**
   * The headset's depth map, to measure how far tracked objects are (depth-sensing.ts); off by
   * default, as it costs. three.js's own depth occlusion stays off, so the map never hides ghost
   * hands, panels or outlines (the live glow fades behind real surfaces by itself).
   */
  depthSensing?: boolean;
}

export interface XrRuntime {
  session: XRSession;
  space: XRReferenceSpace;
  features: string[];
}

export async function isArSupported(): Promise<boolean> {
  try {
    return (await navigator.xr?.isSessionSupported('immersive-ar')) ?? false;
  } catch {
    return false;
  }
}

export async function startArSession(
  renderer: WebGLRenderer,
  { depthSensing = false }: XrSessionOptions = {},
): Promise<XrRuntime> {
  const xr = navigator.xr;
  if (!xr) throw new Error('WebXR is not available in this browser.');
  const optionalFeatures = [
    'hand-tracking',
    'anchors',
    'hit-test',
    'plane-detection',
    'mesh-detection',
    'layers',
  ];
  const depth = depthSensing ? depthSensingInit() : null;
  if (depth) {
    optionalFeatures.push(...depth.optionalFeatures);
    disableXrDepthOcclusion(renderer);
  }
  const session = await xr.requestSession('immersive-ar', {
    requiredFeatures: ['local-floor'],
    optionalFeatures,
    ...(depth ? { depthSensing: depth.depthSensing } : {}),
  } as XRSessionInit);
  renderer.xr.setReferenceSpaceType('local-floor');
  installNearPlaneDebug(keepNearPlane(session));
  await renderer.xr.setSession(session);
  const space = renderer.xr.getReferenceSpace();
  if (!space) throw new Error('No local-floor reference space.');
  return { session, space, features: [...(session.enabledFeatures ?? [])] };
}

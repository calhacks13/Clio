import type { WebGLRenderer } from 'three';

// Starts an immersive-ar (passthrough) session and hands it to three.js. Every feature beyond
// local-floor is optional, so the app degrades instead of refusing to start.

export interface XrSessionOptions {
  /** GPU depth for occlusion; off by default (cost, and ghost hands should stay visible). */
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
  if (depthSensing) optionalFeatures.push('depth-sensing');
  const session = await xr.requestSession('immersive-ar', {
    requiredFeatures: ['local-floor'],
    optionalFeatures,
    ...(depthSensing
      ? { depthSensing: { usagePreference: ['gpu-optimized'], dataFormatPreference: [] } }
      : {}),
  } as XRSessionInit);
  renderer.xr.setReferenceSpaceType('local-floor');
  await renderer.xr.setSession(session);
  const space = renderer.xr.getReferenceSpace();
  if (!space) throw new Error('No local-floor reference space.');
  return { session, space, features: [...(session.enabledFeatures ?? [])] };
}

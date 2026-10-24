// Batch joint APIs from the WebXR Hand Input spec, implemented by Quest Browser and IWER but not
// declared by @types/webxr.
declare global {
  interface XRFrame {
    fillPoses?(spaces: Iterable<XRSpace>, baseSpace: XRSpace, transforms: Float32Array): boolean;
    fillJointRadii?(jointSpaces: Iterable<XRJointSpace>, radii: Float32Array): boolean;
  }
}

export {};

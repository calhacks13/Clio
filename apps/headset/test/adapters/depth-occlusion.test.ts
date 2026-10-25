import { type Camera, Matrix4, PerspectiveCamera, Vector4, type WebGLRenderer } from 'three';
import { describe, expect, it, vi } from 'vitest';
import {
  DEPTH_MIN_RELIABLE_M,
  DepthVariant,
  decodeDepth,
  depthPlanes,
  depthUniforms,
  glowOcclusion,
  installOcclusionDebug,
  nearFade,
  normView,
  OCCLUSION_FALLOFF_M,
  OCCLUSION_MARGIN_M,
  OCCLUSION_NEAR_OFF_M,
  OCCLUSION_NEAR_ON_M,
  objectFront,
  occlusionSettings,
  reliableDepth,
  XrDepthOcclusion,
} from '../../src/adapters/render/glow/depth-occlusion';

describe('up close (a learner leaning over the table)', () => {
  it("takes reads nearer than the sensor's reliable range as unknown", () => {
    // Meta: the Quest 3 depth estimate is unreliable nearer than about 20 cm.
    expect(DEPTH_MIN_RELIABLE_M).toBe(0.2);
    expect(reliableDepth(0.12)).toBeNull();
    expect(reliableDepth(0.2)).toBe(0.2);
    expect(reliableDepth(0.8)).toBe(0.8);
    expect(reliableDepth(null)).toBeNull();
    expect(reliableDepth(Number.NaN)).toBeNull();
    expect(reliableDepth(Number.POSITIVE_INFINITY)).toBeNull();
    // A texel that decodes to just past Quest's 0.1 m near plane is no surface in front.
    const phantom = decodeDepth(0.05, 0.1, 0, 1);
    expect(phantom).toBeCloseTo(0.105, 3);
    expect(reliableDepth(phantom)).toBeNull();
  });

  it('fades the test out as the glow comes within reach of that range', () => {
    // Off where a surface hiding the glow would have to be nearer than the reliable range...
    expect(OCCLUSION_NEAR_OFF_M).toBeCloseTo(
      DEPTH_MIN_RELIABLE_M + OCCLUSION_MARGIN_M + OCCLUSION_FALLOFF_M,
      12,
    );
    expect(OCCLUSION_NEAR_ON_M).toBeCloseTo(0.4, 12);
    expect(nearFade(0.1)).toBe(0);
    expect(nearFade(OCCLUSION_NEAR_OFF_M)).toBe(0);
    expect(nearFade((OCCLUSION_NEAR_OFF_M + OCCLUSION_NEAR_ON_M) / 2)).toBeCloseTo(0.5);
    expect(nearFade(OCCLUSION_NEAR_ON_M)).toBe(1);
    expect(nearFade(0.6)).toBe(1);
    let last = 0;
    for (let d = 0.1; d <= 0.6; d += 0.005) {
      expect(nearFade(d)).toBeGreaterThanOrEqual(last);
      last = nearFade(d);
    }
  });

  it('never hides a glow 10 to 30 cm away, whatever the map reads', () => {
    for (const glow of [0.1, 0.15, 0.2, 0.25, 0.28]) {
      for (const real of [0, 0.05, 0.101, 0.15, 0.199, 0.21, glow - 0.08]) {
        expect(glowOcclusion(glow, real)).toBe(0);
      }
    }
    // A phantom read in front of a farther glow hides nothing either.
    expect(glowOcclusion(0.6, 0.15)).toBe(0);
    // Only partly between the two, and fully again from arm's length.
    const between = glowOcclusion(0.34, 0.22);
    expect(between).toBeGreaterThan(0);
    expect(between).toBeLessThan(1);
    expect(glowOcclusion(0.45, 0.25)).toBe(1);
  });
});

describe('glowOcclusion', () => {
  it('never lets the object hide its own glow, nor a surface behind it', () => {
    // The object's front is a few centimetres nearer than the glow's plane through it.
    expect(glowOcclusion(0.6, 0.57)).toBe(0);
    expect(glowOcclusion(0.6, 0.6 - OCCLUSION_MARGIN_M)).toBeCloseTo(0, 9);
    // A hand-held object over a table: the table is behind.
    expect(glowOcclusion(0.45, 0.8)).toBe(0);
    expect(glowOcclusion(0.6, null)).toBe(0);
    expect(glowOcclusion(0.6, 0)).toBe(0);
  });

  it('hides it behind a real surface in front, with a soft transition', () => {
    expect(glowOcclusion(0.8, 0.5)).toBe(1);
    expect(glowOcclusion(0.6, 0.6 - OCCLUSION_MARGIN_M - OCCLUSION_FALLOFF_M)).toBeCloseTo(1);
    const half = glowOcclusion(0.6, 0.6 - OCCLUSION_MARGIN_M - OCCLUSION_FALLOFF_M / 2);
    expect(half).toBeCloseTo(0.5);
    // Monotone and continuous across the falloff.
    let last = 0;
    for (let i = 0; i <= 40; i++) {
      const v = glowOcclusion(0.6, 0.6 - OCCLUSION_MARGIN_M - (i / 40) * OCCLUSION_FALLOFF_M);
      expect(v).toBeGreaterThanOrEqual(last);
      expect(v - last).toBeLessThan(0.06);
      last = v;
    }
  });
});

describe('depthPlanes', () => {
  it('decodes Quest window depth with no far plane, IWER as infinite, and raw maps by scale', () => {
    const quest = depthPlanes(
      { depthNear: 0.1, depthFar: null, rawValueToMeters: 0.001 },
      'reported',
    );
    expect(quest).toEqual({ near: 0.1, far: 0, rawToMeters: 0.001 });
    const finite = { depthNear: 0.1, depthFar: 50, rawValueToMeters: 1 };
    expect(depthPlanes(finite, 'infinite').far).toBe(0);
    expect(depthPlanes(finite, 'reported').far).toBe(50);
    expect(depthPlanes({ rawValueToMeters: 0.001 }, 'reported')).toEqual({
      near: 0,
      far: 0,
      rawToMeters: 0.001,
    });
  });
});

/** A fake XR renderer: one frame, two eyes, a texture-array depth map per eye. */
function xrRenderer(depthUsage: XRDepthUsage = 'gpu-optimized') {
  const left = new PerspectiveCamera();
  const right = new PerspectiveCamera();
  const identity = new Float32Array(new Matrix4().elements);
  const projection = new Float32Array(
    new Matrix4().makePerspective(-0.1, 0.1, 0.1, -0.1, 0.1, 100).elements,
  );
  const placed = new Matrix4().makeTranslation(0, 1.6, 0);
  const transform = {
    matrix: new Float32Array(placed.elements),
    inverse: { matrix: new Float32Array(placed.clone().invert().elements) },
  };
  const views = ['left', 'right'].map((eye) => ({ eye, transform, projectionMatrix: projection }));
  const texture = {};
  const getDepthInformation = vi.fn((view: { eye: string }) => ({
    texture,
    textureType: 'texture-array',
    imageIndex: view.eye === 'right' ? 1 : 0,
    isValid: true,
    depthNear: 0.1,
    depthFar: null,
    rawValueToMeters: 1,
    normDepthBufferFromNormView: { matrix: identity },
  }));
  let frame: unknown = { getViewerPose: vi.fn(() => ({ views })) };
  const gl = {
    TEXTURE_2D: 1,
    TEXTURE_2D_ARRAY: 2,
    TEXTURE_COMPARE_MODE: 3,
    NONE: 4,
    TEXTURE_MIN_FILTER: 5,
    TEXTURE_MAG_FILTER: 6,
    NEAREST: 7,
    texParameteri: vi.fn(),
  };
  const xr = {
    isPresenting: true,
    getSession: () => ({ depthUsage }),
    getFrame: () => frame,
    getReferenceSpace: () => ({}),
    getCamera: () => ({ cameras: [left, right] }),
    getBinding: () => ({ getDepthInformation }),
  };
  const info = { render: { frame: 0 } };
  const renderer = {
    xr,
    info,
    getContext: () => gl,
    state: { bindTexture: vi.fn() },
  } as unknown as WebGLRenderer;
  /** The next frame; `reuse` hands out the same XRFrame object again, as Quest Browser does. */
  const nextFrame = (reuse = false) => {
    if (!reuse) frame = { getViewerPose: vi.fn(() => ({ views })) };
    info.render.frame++;
  };
  return { renderer, xr, left, right, frame, nextFrame, getDepthInformation, gl, texture };
}

describe('XrDepthOcclusion', () => {
  it("binds each eye's own layer and depth view, reading the map once per frame and eye", () => {
    const { renderer, left, right, frame, getDepthInformation, gl, texture } = xrRenderer();
    const occlusion = new XrDepthOcclusion('reported');
    const u = depthUniforms();
    expect(occlusion.bind(renderer, left, u)).toBe(DepthVariant.Array);
    expect(u.depthLayer.value).toBe(0);
    expect(u.depthOn.value).toBe(1);
    expect(u.depthMap.value.sourceTexture).toBe(texture);
    expect(occlusion.bind(renderer, right, u)).toBe(DepthVariant.Array);
    expect(u.depthLayer.value).toBe(1);
    occlusion.bind(renderer, left, u);
    const pose = (frame as { getViewerPose: () => unknown }).getViewerPose;
    expect(pose).toHaveBeenCalledOnce();
    expect(getDepthInformation).toHaveBeenCalledTimes(2);
    // Sampled as plain values (no comparison, nearest), configured once for the texture.
    expect(gl.texParameteri).toHaveBeenCalledWith(2, 3, 4);
    expect(gl.texParameteri).toHaveBeenCalledTimes(3);
    // A point 1 m in front of the eye (at y = 1.6) is at planar depth 1, mid-view.
    const clip = new Vector4(0, 1.6, -1, 1).applyMatrix4(u.depthFromWorld.value);
    expect(clip.w).toBeCloseTo(1);
    expect(clip.x / clip.w).toBeCloseTo(0);
    expect(u.depthNear.value).toBe(0.1);
    expect(u.depthFar.value).toBe(0);
  });

  it('reads the views again every frame, even when the runtime reuses its XRFrame object', () => {
    const { renderer, left, frame, nextFrame, getDepthInformation } = xrRenderer();
    const occlusion = new XrDepthOcclusion();
    const u = depthUniforms();
    occlusion.bind(renderer, left, u);
    nextFrame(true);
    occlusion.bind(renderer, left, u);
    const pose = (frame as { getViewerPose: () => unknown }).getViewerPose;
    expect(pose).toHaveBeenCalledTimes(2);
    expect(getDepthInformation).toHaveBeenCalledTimes(2);
  });

  it('turns off outside a session, without gpu depth, or for a camera that is not an eye', () => {
    const occlusion = new XrDepthOcclusion();
    const u = depthUniforms();
    const cpu = xrRenderer('cpu-optimized');
    expect(occlusion.bind(cpu.renderer, cpu.left, u)).toBe(DepthVariant.None);
    const gpu = xrRenderer();
    const other = new PerspectiveCamera() as Camera;
    expect(occlusion.bind(gpu.renderer, other, u)).toBe(DepthVariant.None);
    expect(u.depthOn.value).toBe(0);
    gpu.xr.isPresenting = false;
    expect(occlusion.bind(gpu.renderer, gpu.left, u)).toBe(DepthVariant.None);
  });

  it('never throws on a session without depth sensing, where depthUsage itself throws', () => {
    const { renderer, xr, left } = xrRenderer();
    const session = {
      enabledFeatures: ['local-floor', 'hand-tracking'],
      get depthUsage(): XRDepthUsage {
        throw new DOMException('Depth sensing is not enabled', 'InvalidStateError');
      },
    };
    xr.getSession = () => session as unknown as { depthUsage: XRDepthUsage };
    const occlusion = new XrDepthOcclusion();
    const u = depthUniforms();
    expect(occlusion.bind(renderer, left, u)).toBe(DepthVariant.None);
    expect(occlusion.stats.render.eyes[0]).toBe('no gpu depth');
    // And a runtime that lists no features but throws all the same.
    xr.getSession = () => ({
      get depthUsage(): XRDepthUsage {
        throw new DOMException('Depth sensing is not enabled', 'InvalidStateError');
      },
    });
    expect(occlusion.bind(renderer, left, u)).toBe(DepthVariant.None);
  });

  it("never leaves last frame's map bound, and reports the near plane and why a map is missing", () => {
    const { renderer, left, nextFrame, getDepthInformation, texture } = xrRenderer();
    const occlusion = new XrDepthOcclusion();
    const u = depthUniforms();
    occlusion.bind(renderer, left, u);
    expect(u.depthMap.value.sourceTexture).toBe(texture);
    expect(occlusion.stats.render.eyes[0]).toBe('bound');
    // PerspectiveCamera's default near plane, read back from its projection.
    expect(occlusion.stats.render.nearPlaneM).toBeCloseTo(0.1, 6);
    getDepthInformation.mockImplementation(() => ({ isValid: false }) as never);
    nextFrame();
    expect(occlusion.bind(renderer, left, u)).toBe(DepthVariant.None);
    expect(u.depthMap.value.sourceTexture).toBeNull();
    expect(u.depthOn.value).toBe(0);
    expect(occlusion.stats.render.eyes[0]).toBe('invalid');
  });

  it('hands the near range to the shader', () => {
    const before = { ...occlusionSettings };
    const { renderer, left } = xrRenderer();
    const occlusion = new XrDepthOcclusion();
    const u = depthUniforms();
    expect(u.depthMinM.value).toBe(DEPTH_MIN_RELIABLE_M);
    expect(u.occlusionNearOff.value).toBe(OCCLUSION_NEAR_OFF_M);
    expect(u.occlusionNearOn.value).toBe(OCCLUSION_NEAR_ON_M);
    Object.assign(occlusionSettings, { minDepth: 0.15, nearOff: 0.2, nearOn: 0.3 });
    occlusion.bind(renderer, left, u);
    expect(u.depthMinM.value).toBe(0.15);
    expect(u.occlusionNearOff.value).toBe(0.2);
    expect(u.occlusionNearOn.value).toBe(0.3);
    Object.assign(occlusionSettings, before);
  });

  it('gives up quietly after repeated errors', () => {
    const { renderer, left, nextFrame, getDepthInformation } = xrRenderer();
    getDepthInformation.mockImplementation(() => {
      throw new Error('no depth');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const occlusion = new XrDepthOcclusion();
    const u = depthUniforms();
    for (let i = 0; i < 5; i++) {
      nextFrame();
      expect(occlusion.bind(renderer, left, u)).toBe(DepthVariant.None);
    }
    expect(getDepthInformation).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});

describe('the object-relative reference', () => {
  it('takes the object front from the second-nearest interior point, so it never hides itself', () => {
    // A can whose glow plane is at its contact line: its front is 6 cm nearer than the plane.
    const can = [0.06, 0.055, 0.058, 0.06, 0.05, null, 0.057];
    const front = objectFront(can, 0.3);
    expect(front).toBeCloseTo(0.06);
    // The can's own front, 6 cm in front of the plane, does not hide it...
    expect(glowOcclusion(0.6, 0.54, front)).toBe(0);
    // ...though compared with the plane alone it would have.
    expect(glowOcclusion(0.6, 0.54)).toBeGreaterThan(0.2);
    // A hand 20 cm in front of the plane still does.
    expect(glowOcclusion(0.6, 0.4, front)).toBe(1);
  });

  it('ignores one stray read, never puts the front behind the plane, and caps it', () => {
    expect(objectFront([0.02, 0.5, 0.02, 0.01], 1)).toBeCloseTo(0.02);
    expect(objectFront([-0.1, -0.2, null], 1)).toBe(0);
    expect(objectFront([0.3, 0.3, 0.3], 0.1)).toBe(0.1);
    expect(objectFront([0.04], 1)).toBeCloseTo(0.04);
    expect(objectFront([null, null], 1)).toBe(0);
  });
});

describe('depth buffer addressing', () => {
  it('maps NDC bottom-left first, or top-first when flipped', () => {
    expect(normView([-1, -1], false)).toEqual([0, 0]);
    expect(normView([1, 1], false)).toEqual([1, 1]);
    expect(normView([-1, -1], true)).toEqual([0, 1]);
    expect(normView([0, 0.5], true)).toEqual([0.5, 0.25]);
  });

  it('decodes texels as the shaders do', () => {
    // Quest: depthNear 0.1, no far plane; 0.926 is 1.36 m (measured).
    expect(decodeDepth(0.926, 0.1, 0, 1)).toBeCloseTo(1.35, 1);
    expect(decodeDepth(0, 0.1, 0, 1)).toBeNull();
    expect(decodeDepth(1, 0.1, 0, 1)).toBeNull();
    expect(decodeDepth(1500, 0, 0, 0.001)).toBeCloseTo(1.5);
  });
});

describe('window.__occlusion', () => {
  it('switches the test, hands, flip, margin and views live, and the binder follows', () => {
    const before = { ...occlusionSettings };
    (globalThis as unknown as { window: unknown }).window = globalThis;
    const { renderer, left } = xrRenderer();
    const occlusion = new XrDepthOcclusion();
    installOcclusionDebug(occlusion);
    const api = (globalThis as unknown as { __occlusion: Record<string, (v?: unknown) => unknown> })
      .__occlusion;
    api.setFlipY?.(true);
    api.setMargin?.(0.08);
    api.setDepth?.(false);
    api.setViz?.('diff');
    const u = depthUniforms();
    expect(occlusion.bind(renderer, left, u)).toBe(DepthVariant.Array);
    expect(u.depthFlipY.value).toBe(1);
    expect(u.occlusionMargin.value).toBe(0.08);
    // The map stays bound (for the views) while the test itself is off.
    expect(u.depthOn.value).toBe(1);
    expect(u.occlusionOn.value).toBe(0);
    expect(u.vizMode.value).toBe(2);
    expect(api.probe?.()).toContain('next frame');
    expect(occlusion.probeEyes).toBe(3);
    // The near range, live.
    const near = (globalThis as unknown as { __occlusion: Record<string, unknown> }).__occlusion;
    (near.setNearRange as (off: number, on: number) => unknown)(0.25, 0.2);
    (near.setMinDepth as (m: number) => unknown)(0.18);
    expect(occlusionSettings.nearOff).toBe(0.25);
    expect(occlusionSettings.nearOn).toBe(0.25);
    occlusion.bind(renderer, left, u);
    expect(u.depthMinM.value).toBe(0.18);
    const stats = near.stats as { render: { nearPlaneM: number }; frames: { frames: number } };
    expect(stats.render.nearPlaneM).toBeCloseTo(0.1, 6);
    expect(typeof stats.frames.frames).toBe('number');
    Object.assign(occlusionSettings, before);
    delete (globalThis as unknown as { __occlusion?: unknown }).__occlusion;
    delete (globalThis as unknown as { window?: unknown }).window;
  });
});

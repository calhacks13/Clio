import { describe, expect, it, vi } from 'vitest';
import type { DepthHit, DepthSource } from '../../src/adapters/xr/depth';
import {
  applyNormTransform,
  createDepthSampler,
  type DepthImage,
  type DepthLookup,
  type DepthView,
  decodeFarPlane,
  depthLayer,
  disableXrDepthOcclusion,
  imageLookup,
  marchRay,
  median,
  ndcToNormView,
  preferDepthSensing,
  projectToView,
  unpackMillimeters,
  unprojectFromView,
  windowDepthToMeters,
} from '../../src/adapters/xr/depth-sensing';
import {
  dot,
  madd,
  normalize,
  type Pose,
  quatFromAxisAngle,
  sub,
  transformPoint,
  type Vec3,
} from '../../src/core/math';
import type { Ray } from '../../src/domain/world/camera-model';

// The ray/view math behind depth sensing, against analytic scenes: a depth map is what the view
// would see of a few planes and boxes, and a ray from the passthrough camera (a few cm from the
// view) must land where it really meets them.

function perspective(fovDeg: number, near: number, far: number, skewX = 0, skewY = 0): number[] {
  const f = 1 / Math.tan((fovDeg * Math.PI) / 360);
  return [
    f,
    0,
    0,
    0,
    0,
    f,
    0,
    0,
    skewX,
    skewY,
    (far + near) / (near - far),
    -1,
    0,
    0,
    (2 * far * near) / (near - far),
    0,
  ];
}

const EYE: Pose = { p: [0.03, 1.6, 0], q: quatFromAxisAngle([1, 0, 0], (-20 * Math.PI) / 180) };
const VIEW: DepthView = { worldFromView: EYE, projection: perspective(90, 0.05, 100) };
/** The passthrough camera: ~3 cm right, 2 cm up and 2.5 cm ahead of the head, pitched down. */
const CAMERA_ORIGIN = transformPoint(EYE, [0.002, 0.02, -0.025]);

type Hit = (o: Vec3, d: Vec3) => number | null;

/** Plane through `p` with normal `n`. */
const plane =
  (p: Vec3, n: Vec3): Hit =>
  (o, d) => {
    const denom = dot(d, n);
    if (Math.abs(denom) < 1e-9) return null;
    const t = dot(sub(p, o), n) / denom;
    return t > 0 ? t : null;
  };

/** Axis-aligned box. */
const box =
  (min: Vec3, max: Vec3): Hit =>
  (o, d) => {
    let t0 = 0;
    let t1 = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 3; i++) {
      const oi = o[i] as number;
      const di = d[i] as number;
      const lo = min[i] as number;
      const hi = max[i] as number;
      if (Math.abs(di) < 1e-12) {
        if (oi < lo || oi > hi) return null;
        continue;
      }
      const a = (lo - oi) / di;
      const b = (hi - oi) / di;
      t0 = Math.max(t0, Math.min(a, b));
      t1 = Math.min(t1, Math.max(a, b));
    }
    return t0 <= t1 && t0 > 0 ? t0 : null;
  };

/** What `view` sees of `scene`: planar depth along each pixel's ray. */
function sceneLookup(view: DepthView, scene: Hit[]): DepthLookup {
  return (ndc) => {
    const far = unprojectFromView(view, ndc, 1);
    if (!far) return null;
    const o = view.worldFromView.p;
    const d = normalize(sub(far, o));
    const ts = scene.map((h) => h(o, d)).filter((t): t is number => t !== null);
    if (ts.length === 0) return null;
    const p = madd(o, d, Math.min(...ts));
    return projectToView(view, p)?.depth ?? null;
  };
}

/** A ray from the camera through world point `p`. */
const rayTo = (p: Vec3, origin: Vec3 = CAMERA_ORIGIN): Ray => ({
  origin,
  direction: normalize(sub(p, origin)),
});

const near = (a: Readonly<Vec3>, b: Readonly<Vec3>, eps: number) => Math.hypot(...sub(a, b)) <= eps;

describe('projectToView / unprojectFromView', () => {
  for (const [name, projection] of [
    ['symmetric', perspective(90, 0.05, 100)],
    ['off-axis', perspective(80, 0.1, 20, 0.12, -0.06)],
  ] as const) {
    it(`round-trips world points (${name})`, () => {
      const view: DepthView = { worldFromView: EYE, projection };
      for (const p of [
        [0.2, 1.3, -0.8],
        [-0.3, 1.0, -1.5],
        [0.03, 1.6, -0.3],
      ] as Vec3[]) {
        const seen = projectToView(view, p);
        expect(seen).not.toBeNull();
        if (!seen) continue;
        const back = unprojectFromView(view, seen.ndc, seen.depth);
        expect(back && near(back, p, 1e-6)).toBe(true);
      }
    });
  }

  it('reports planar depth, not range', () => {
    const view: DepthView = {
      worldFromView: { p: [0, 0, 0], q: [0, 0, 0, 1] },
      projection: perspective(90, 0.05, 100),
    };
    expect(projectToView(view, [0.5, 0, -1])?.depth).toBeCloseTo(1, 9);
    expect(projectToView(view, [0, 0, 1])).toBeNull(); // behind
    expect(projectToView(view, [5, 0, -1])).toBeNull(); // outside the frustum
  });
});

describe('coordinate helpers', () => {
  it('maps NDC to normalized view coordinates for either origin', () => {
    expect(ndcToNormView([-1, 1], true)).toEqual([0, 0]);
    expect(ndcToNormView([-1, 1], false)).toEqual([0, 1]);
    expect(ndcToNormView([1, -1], true)).toEqual([1, 1]);
  });

  it('applies normDepthBufferFromNormView (identity when absent)', () => {
    expect(applyNormTransform(null, [0.2, 0.7])).toEqual([0.2, 0.7]);
    // u' = u, v' = 1 - v (a vertical flip as a 4x4, column-major).
    const flip = [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1, 0, 0, 1, 0, 1];
    const [u, v] = applyNormTransform(flip, [0.2, 0.7]);
    expect(u).toBeCloseTo(0.2, 9);
    expect(v).toBeCloseTo(0.3, 9);
  });

  it('linearizes window depth (finite and infinite far plane)', () => {
    // IWER's (and an infinite projection's) encoding: w = 1 - near / d.
    expect(windowDepthToMeters(1 - 0.1 / 0.8, 0.1, Number.POSITIVE_INFINITY)).toBeCloseTo(0.8, 9);
    // A standard projection's encoding of 1.7 m.
    const P = perspective(90, 0.1, 50);
    const z = -1.7;
    const ndc = ((P[10] as number) * z + (P[14] as number)) / -z;
    expect(windowDepthToMeters((ndc + 1) / 2, 0.1, 50)).toBeCloseTo(1.7, 6);
    expect(windowDepthToMeters(0, 0.1, 50)).toBeNull();
    expect(windowDepthToMeters(1, 0.1, 50)).toBeNull();
  });

  it('takes the median of valid values', () => {
    expect(median([1, 9, 2, 0, Number.NaN])).toBe(2);
    expect(median([1, 9, 2, 4])).toBe(3);
    expect(median([0, Number.NaN])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
  });

  it('unpacks millimeters from RGBA8, into a reused buffer when given one', () => {
    const mm = 123_456;
    const px = new Uint8Array([mm & 255, (mm >> 8) & 255, mm >> 16, 255, 7, 0, 0, 0]);
    const m = unpackMillimeters(px, 2);
    expect(m[0]).toBeCloseTo(123.456, 4);
    expect(m[1]).toBe(0);
    const out = new Float32Array([9, 9]);
    expect(unpackMillimeters(px, 2, out)).toBe(out);
    expect(out[1]).toBe(0); // stale values are cleared
  });

  it('decodes with a reported finite far plane unless told otherwise', () => {
    expect(decodeFarPlane('reported', 20)).toBe(20);
    expect(decodeFarPlane('reported', Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
    expect(decodeFarPlane('reported', null)).toBe(Number.POSITIVE_INFINITY);
    expect(decodeFarPlane('infinite', 20)).toBe(Number.POSITIVE_INFINITY);
    // Quest Browser reports no far plane: none either way.
    expect(decodeFarPlane('reported', undefined)).toBe(Number.POSITIVE_INFINITY);
    expect(decodeFarPlane('infinite', null)).toBe(Number.POSITIVE_INFINITY);
    expect(windowDepthToMeters(0.926, 0.1, decodeFarPlane('reported', null))).toBeCloseTo(1.351, 3);
  });

  it("reads the eye's layer of a texture array when imageIndex is missing", () => {
    expect(depthLayer({ textureType: 'texture-array', imageIndex: 0 }, 'right')).toBe(0);
    expect(depthLayer({ textureType: 'texture-array' }, 'right')).toBe(1);
    expect(depthLayer({ textureType: 'texture-array' }, 'left')).toBe(0);
    expect(depthLayer({ textureType: 'texture', imageIndex: 1 }, 'right')).toBe(0);
  });

  it("stops three.js's depth occlusion mesh", () => {
    const renderer = { xr: { getDepthSensingMesh: (): unknown => ({ mesh: true }) } };
    disableXrDepthOcclusion(renderer);
    expect(renderer.xr.getDepthSensingMesh()).toBeNull();
  });
});

describe('imageLookup', () => {
  // 8x8, rows in memory order. `rows` and `cols` say which leading rows / columns are 1 m; the
  // rest is 5 m. A 3x3 median near an edge then reads 1 m only from the right edge of memory.
  const image = (
    originTop: boolean,
    { rows = 0, cols = 0 }: { rows?: number; cols?: number },
    normTransform: number[] | null = null,
  ): DepthImage => {
    const meters = new Float32Array(64).fill(5);
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) if (y < rows || x < cols) meters[y * 8 + x] = 1;
    }
    return { width: 8, height: 8, meters, originTop, normTransform };
  };
  const TOP: [number, number] = [0, 0.95];
  const BOTTOM: [number, number] = [0, -0.95];

  it('reads memory row 0 at the top of the view for CPU maps', () => {
    const cpu = imageLookup(image(true, { rows: 2 }));
    expect(cpu(TOP)).toBe(1);
    expect(cpu(BOTTOM)).toBe(5);
  });

  it('reads memory row 0 at the bottom of the view for GL textures', () => {
    const gl = imageLookup(image(false, { rows: 2 }));
    expect(gl(BOTTOM)).toBe(1);
    expect(gl(TOP)).toBe(5);
  });

  it('reads memory column 0 at the left of the view either way', () => {
    for (const originTop of [true, false]) {
      const lookup = imageLookup(image(originTop, { cols: 2 }));
      expect(lookup([-0.95, 0])).toBe(1);
      expect(lookup([0.95, 0])).toBe(5);
    }
  });

  it('applies normDepthBufferFromNormView after the origin convention', () => {
    // A vertical flip turns a GL texture's lookup into a CPU map's.
    const flip = [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1, 0, 0, 1, 0, 1];
    const flipped = imageLookup(image(false, { rows: 2 }, flip));
    expect(flipped(TOP)).toBe(1);
    expect(flipped(BOTTOM)).toBe(5);
  });

  it('ignores a single outlier in the 3x3 block', () => {
    const img = image(true, {});
    img.meters[3 * 8 + 4] = 1; // one texel of the block around (4, 4)
    expect(imageLookup(img)([0.05, -0.05])).toBe(5);
  });
});

describe('marchRay', () => {
  const wall = plane([0, 0, -2], [0, 0, 1]);
  const table = plane([0, 0.75, 0], [0, 1, 0]);

  it('finds a wall along a camera ray offset from the view', () => {
    const target: Vec3 = [0.1, 1.5, -2];
    const hit = marchRay(rayTo(target), VIEW, sceneLookup(VIEW, [wall]));
    expect(hit).not.toBeNull();
    if (!hit) return;
    expect(near(hit.point, target, 0.003)).toBe(true);
    expect(hit.distance).toBeCloseTo(Math.hypot(...sub(target, CAMERA_ORIGIN)), 2);
    expect(hit.normal[2]).toBeGreaterThan(0.95);
  });

  it('finds the table with an upward normal', () => {
    const target: Vec3 = [-0.1, 0.75, -0.7];
    const hit = marchRay(rayTo(target), VIEW, sceneLookup(VIEW, [wall, table]));
    expect(hit && near(hit.point, target, 0.003)).toBe(true);
    expect(hit?.normal[1]).toBeGreaterThan(0.95);
  });

  it('stops at a hand-held object in front of the wall, not behind it', () => {
    // A 6 cm cube held 45 cm ahead, well above the table.
    const object = box([0.0, 1.27, -0.53], [0.06, 1.33, -0.47]);
    const front: Vec3 = [0.03, 1.3, -0.47];
    const hit = marchRay(rayTo(front), VIEW, sceneLookup(VIEW, [wall, table, object]));
    expect(hit && near(hit.point, front, 0.004)).toBe(true);
    // Just beside it, the same ray family reaches the wall.
    const beside = marchRay(rayTo([0.2, 1.3, -2]), VIEW, sceneLookup(VIEW, [wall, object]));
    expect(beside?.point[2]).toBeCloseTo(-2, 2);
  });

  it('is null where the map has nothing, or nothing within range', () => {
    expect(marchRay(rayTo([0, 1.5, -2]), VIEW, () => null)).toBeNull();
    const farWall = plane([0, 0, -9], [0, 0, 1]);
    expect(marchRay(rayTo([0, 1.5, -9]), VIEW, sceneLookup(VIEW, [farWall]))).toBeNull();
  });

  it('is null for a ray that leaves the view', () => {
    const sideways: Ray = { origin: CAMERA_ORIGIN, direction: [1, 0, 0] };
    expect(marchRay(sideways, VIEW, sceneLookup(VIEW, [wall]))).toBeNull();
  });
});

// ---- the sampler against a fake session ------------------------------------------------------

const rigid = (pose: Pose) =>
  ({
    position: { x: pose.p[0], y: pose.p[1], z: pose.p[2], w: 1 },
    orientation: { x: pose.q[0], y: pose.q[1], z: pose.q[2], w: pose.q[3] },
  }) as unknown as XRRigidTransform;

function fakeSession(features: string[], usage: XRDepthUsage = 'cpu-optimized') {
  return {
    enabledFeatures: features,
    depthUsage: usage,
    depthDataFormat: 'float32',
    addEventListener: () => {},
  } as unknown as XRSession;
}

/** A frame whose right eye is VIEW and whose CPU depth map sees `scene` (or nothing). */
function fakeFrame(scene: Hit[] | null): XRFrame {
  const view = { eye: 'right', transform: rigid(EYE), projectionMatrix: VIEW.projection };
  const lookup = sceneLookup(VIEW, scene ?? []);
  const info = {
    width: 64,
    height: 64,
    rawValueToMeters: 1,
    normDepthBufferFromNormView: { matrix: null },
    getDepthInMeters: (x: number, y: number) => lookup([x * 2 - 1, 1 - y * 2]) ?? 0,
  };
  return {
    getViewerPose: () => ({ views: [{ ...view, eye: 'left' }, view] }),
    getDepthInformation: () => (scene ? info : null),
  } as unknown as XRFrame;
}

describe('DepthSampler', () => {
  const space = {} as XRReferenceSpace;
  const wall = plane([0, 0, -2], [0, 0, 1]);

  it('is not created when depth sensing is not enabled', () => {
    expect(createDepthSampler(fakeSession(['hit-test']), { space })).toBeNull();
    expect(
      createDepthSampler(fakeSession(['depth-sensing'], 'gpu-optimized'), { space }),
    ).toBeNull();
  });

  it('samples a ray inside the frame, and answers measure() on the next update', async () => {
    const sampler = createDepthSampler(fakeSession(['depth-sensing']), { space });
    expect(sampler).not.toBeNull();
    if (!sampler) return;
    const frame = fakeFrame([wall]);
    const ray = rayTo([0, 1.5, -2]);
    expect(sampler.sample(frame, ray)?.point[2]).toBeCloseTo(-2, 2);
    expect(sampler.info).toMatchObject({ mode: 'cpu', width: 64, ownView: false });

    const answer = sampler.measure([ray, rayTo([0, 3.5, -2])]);
    sampler.update(fakeFrame([wall]));
    const [a, b] = await answer;
    expect(a?.point[2]).toBeCloseTo(-2, 2);
    expect(b).toBeNull(); // above the view
  });

  it('answers null after a few frames without a map', async () => {
    const sampler = createDepthSampler(fakeSession(['depth-sensing']), { space, maxFrames: 2 });
    if (!sampler) throw new Error('no sampler');
    const answer = sampler.measure([rayTo([0, 1.5, -2])]);
    sampler.update(fakeFrame(null));
    sampler.update(fakeFrame(null));
    expect(await answer).toEqual([null]);
  });
});

/**
 * Just enough WebGL2 for the GPU readback: every map texel is `mm` millimeters, and the fence
 * passes only once `signaled` is set. Records the uniforms and the calls.
 */
function fakeGl(mm: number) {
  const constants = new Map<string, number>();
  const uniforms = new Map<string, number>();
  const calls: string[] = [];
  /** texParameteri calls (target, parameter, value), as constant names. */
  const params: [string, string, string][] = [];
  const state = { signaled: false };
  let texels = () => mm;
  /** The value the next readPixels "renders" (read back by getBufferSubData). */
  let rendered = mm;
  const constant = (name: string) => {
    if (!constants.has(name)) constants.set(name, constants.size + 1);
    return constants.get(name) as number;
  };
  const nameOf = (value: number) =>
    [...constants].find(([, v]) => v === value)?.[0] ?? String(value);
  const overrides: Record<string, unknown> = {
    getParameter: (p: number) =>
      p === constant('VIEWPORT')
        ? new Int32Array([0, 0, 4, 4])
        : p === constant('COLOR_WRITEMASK')
          ? [true, true, true, true]
          : p === constant('ACTIVE_TEXTURE')
            ? constant('TEXTURE0')
            : null,
    isEnabled: () => false,
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    checkFramebufferStatus: () => constant('FRAMEBUFFER_COMPLETE'),
    getUniformLocation: (_: unknown, name: string) => name,
    uniform1i: (name: string, v: number) => uniforms.set(name, v),
    uniform1f: (name: string, v: number) => uniforms.set(name, v),
    fenceSync: () => ({ fence: true }),
    getSyncParameter: () => (state.signaled ? constant('SIGNALED') : constant('UNSIGNALED')),
    getBufferSubData: (_t: number, _o: number, dst: Uint8Array) => {
      calls.push('getBufferSubData');
      const v = rendered;
      for (let i = 0; i < dst.length; i += 4) dst.set([v & 255, (v >> 8) & 255, v >> 16, 255], i);
    },
    flush: () => calls.push('flush'),
    readPixels: () => {
      calls.push('readPixels');
      rendered = texels();
    },
    texParameteri: (t: number, p: number, v: number) =>
      params.push([nameOf(t), nameOf(p), nameOf(v)]),
  };
  const gl = new Proxy(
    {},
    {
      get: (_, prop: string) =>
        prop in overrides
          ? overrides[prop]
          : /^[A-Z0-9_]+$/.test(prop)
            ? constant(prop)
            : () => ({}),
    },
  ) as WebGL2RenderingContext;
  const setTexels = (f: () => number) => {
    texels = f;
  };
  return { gl, uniforms, calls, params, state, setTexels };
}

describe('DepthSampler on a GPU map', () => {
  const space = {} as XRReferenceSpace;
  const binding = {
    getDepthInformation: () => ({
      texture: {},
      width: 16,
      height: 16,
      textureType: 'texture-array', // no imageIndex
      depthNear: 0.1,
      depthFar: 20,
      rawValueToMeters: 1,
      normDepthBufferFromNormView: { matrix: null },
    }),
  } as unknown as XRWebGLBinding;
  // The map sees a plane 2 m ahead of the view (planar depth 2 everywhere).
  const target = unprojectFromView(VIEW, [0.2, -0.3], 2) as Vec3;

  it('reads back without waiting, answering once the fence has passed', async () => {
    const { gl, uniforms, calls, state } = fakeGl(2000);
    const sampler = createDepthSampler(fakeSession(['depth-sensing'], 'gpu-optimized'), {
      space,
      gl,
      binding,
    });
    if (!sampler) throw new Error('no sampler');
    let answered: (DepthHit | null)[] | null = null;
    void sampler.measure([rayTo(target)]).then((hits) => {
      answered = hits;
    });
    const flush = () => new Promise((r) => setTimeout(r, 0));

    sampler.update(fakeFrame(null));
    sampler.update(fakeFrame(null));
    await flush();
    expect(calls).toEqual(['readPixels']); // one read in flight, not collected
    expect(answered).toBeNull();

    state.signaled = true;
    sampler.update(fakeFrame(null));
    await flush();
    const hit = (answered as (DepthHit | null)[] | null)?.[0];
    expect(hit && near(hit.point, target, 0.004)).toBe(true);
    // The right eye's layer of the array, decoded with the reported far plane.
    expect(uniforms.get('layer')).toBe(1);
    expect(uniforms.get('far')).toBe(20);
    expect(sampler.info).toMatchObject({ mode: 'gpu', layer: 1, decodeFar: 20 });
  });

  it('answers later rays only from a map read after they were asked', async () => {
    const { gl, calls, state } = fakeGl(2000);
    const sampler = createDepthSampler(fakeSession(['depth-sensing'], 'gpu-optimized'), {
      space,
      gl,
      binding,
      windowFar: 'infinite',
    });
    if (!sampler) throw new Error('no sampler');
    state.signaled = true;
    const first = sampler.measure([rayTo(target)]);
    sampler.update(fakeFrame(null)); // starts a read
    sampler.update(fakeFrame(null)); // collects it
    expect((await first)[0]).not.toBeNull();
    expect(sampler.info?.decodeFar).toBe(Number.POSITIVE_INFINITY);

    state.signaled = false;
    let second: (DepthHit | null)[] | null = null;
    void sampler.measure([rayTo(target)]).then((hits) => {
      second = hits;
    });
    sampler.update(fakeFrame(null));
    await new Promise((r) => setTimeout(r, 0));
    expect(second).toBeNull(); // the old map is not reused
    state.signaled = true;
    sampler.update(fakeFrame(null));
    await new Promise((r) => setTimeout(r, 0));
    expect(second).not.toBeNull();
    expect(calls.filter((c) => c === 'readPixels')).toHaveLength(2);
  });
});

// ---- Quest Browser 154, as measured on a Quest 3 ---------------------------------------------
// XRWebGLBinding.getDepthInformation(view): 320x320 'texture-array', imageIndex 0 (left) / 1
// (right), depthNear 0.1, depthFar null, rawValueToMeters 1, isValid, its own projection and
// transform (the depth camera, not the eye). Texels are window depth for a projection with no far
// plane: 0.926 is 1.35 m, 0.8445 is 0.643 m.

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
/** The depth camera: 4 cm left of and 1 cm below the right eye, same heading. */
const DEPTH_POSE: Pose = { p: [EYE.p[0] - 0.04, EYE.p[1] - 0.01, EYE.p[2]], q: EYE.q };
const DEPTH_PROJECTION = perspective(100, 0.1, 1000, 0.05, -0.03);
const RAW = { left: 0.8445, right: 0.926 } as const;

function questInfo(eye: XREye) {
  return {
    texture: { eye },
    width: 320,
    height: 320,
    textureType: 'texture-array',
    imageIndex: eye === 'left' ? 0 : 1,
    depthNear: 0.1,
    depthFar: null,
    rawValueToMeters: 1,
    isValid: true,
    normDepthBufferFromNormView: { matrix: new Float32Array(IDENTITY) },
    projectionMatrix: new Float32Array(DEPTH_PROJECTION),
    transform: rigid(DEPTH_POSE),
  };
}

function questBinding() {
  const calls: XREye[] = [];
  const binding = {
    getDepthInformation: (view: XRView) => {
      calls.push(view.eye);
      return questInfo(view.eye);
    },
  } as unknown as XRWebGLBinding;
  return { binding, calls };
}

/** A Quest frame: both eyes, the right one at EYE. A new object per frame unless `reuse`. */
function questFrame(): XRFrame {
  const right = { eye: 'right', transform: rigid(EYE), projectionMatrix: VIEW.projection };
  const left = { ...right, eye: 'left' };
  return {
    getViewerPose: () => ({ views: [left, right] }),
    getDepthInformation: () => {
      throw new DOMException('gpu-optimized session', 'InvalidStateError');
    },
  } as unknown as XRFrame;
}

/**
 * WebGL2 that runs the readback shader on a constant texture: every texel of layer L is
 * `raw[L]`, decoded with the near/far/rawToMeters uniforms as the fragment shader does.
 */
function questGl(raw: readonly number[]) {
  const fake = fakeGl(0);
  const { uniforms } = fake;
  const decoded = () => {
    const v = raw[uniforms.get('layer') ?? 0] ?? 0;
    const nearU = uniforms.get('near') ?? 0;
    const farU = uniforms.get('far') ?? 0;
    if (nearU <= 0) return v * (uniforms.get('rawToMeters') ?? 1);
    return windowDepthToMeters(v, nearU, farU > 0 ? farU : Number.POSITIVE_INFINITY) ?? 0;
  };
  fake.setTexels(() => Math.round(decoded() * 1000));
  return fake;
}

describe('DepthSampler on Quest Browser', () => {
  const space = {} as XRReferenceSpace;
  const session = () => {
    const s = fakeSession(['depth-sensing', 'hit-test', 'hand-tracking'], 'gpu-optimized');
    (s as unknown as { depthDataFormat: string }).depthDataFormat = 'unsigned-short';
    return s;
  };
  /** Straight ahead of the depth camera. */
  const ahead: Ray = {
    origin: transformPoint(DEPTH_POSE, [0, 0, 0]),
    direction: normalize(sub(transformPoint(DEPTH_POSE, [0, 0, -1]), DEPTH_POSE.p)),
  };

  it("reads the right eye's layer with no far plane: 0.926 is 1.35 m", () => {
    const { gl, uniforms, state, params } = questGl([RAW.left, RAW.right]);
    const { binding, calls } = questBinding();
    // 'reported' (the headset default) still decodes with no far plane: none is reported.
    const sampler = createDepthSampler(session(), { space, gl, binding, windowFar: 'reported' });
    if (!sampler) throw new Error('no sampler');
    state.signaled = true;
    expect(sampler.sample(questFrame(), ahead)).toBeNull(); // starts the first read
    expect(calls).toEqual(['right']);
    const hit = sampler.sample(questFrame(), ahead); // collects it, answers from it
    expect(hit?.distance).toBeCloseTo(0.1 / (1 - RAW.right), 2);
    expect(uniforms.get('layer')).toBe(1);
    expect(uniforms.get('near')).toBeCloseTo(0.1, 6);
    expect(uniforms.get('far')).toBe(0);
    expect(sampler.info).toMatchObject({
      mode: 'gpu',
      format: 'unsigned-short',
      width: 320,
      height: 320,
      ownView: true,
      near: 0.1,
      far: null,
      decodeFar: Number.POSITIVE_INFINITY,
      layer: 1,
    });
    // The depth map is sampled as plain values: no comparison, no filtering.
    expect(params).toEqual(
      expect.arrayContaining([
        ['TEXTURE_2D_ARRAY', 'TEXTURE_COMPARE_MODE', 'NONE'],
        ['TEXTURE_2D_ARRAY', 'TEXTURE_MIN_FILTER', 'NEAREST'],
        ['TEXTURE_2D_ARRAY', 'TEXTURE_MAG_FILTER', 'NEAREST'],
      ]),
    );
    expect(sampler.stats).toMatchObject({ infoCalls: 2, readsStarted: 2, readsCompleted: 1 });
    expect(sampler.stats.mapCenterM).toBeCloseTo(1.351, 3);
  });

  it('reads the left layer for the left eye (0.8445 is 0.643 m)', () => {
    const { gl, state } = questGl([RAW.left, RAW.right]);
    const { binding } = questBinding();
    const sampler = createDepthSampler(session(), { space, gl, binding, eye: 'left' });
    if (!sampler) throw new Error('no sampler');
    state.signaled = true;
    sampler.sample(questFrame(), ahead);
    expect(sampler.sample(questFrame(), ahead)?.distance).toBeCloseTo(0.643, 2);
    expect(sampler.info?.layer).toBe(0);
  });

  it('keeps reading when the runtime hands out the same XRFrame every frame', () => {
    const { gl, state } = questGl([RAW.left, RAW.right]);
    const { binding, calls } = questBinding();
    const sampler = createDepthSampler(session(), { space, gl, binding });
    if (!sampler) throw new Error('no sampler');
    const frame = questFrame();
    sampler.sample(frame, ahead);
    state.signaled = true;
    for (let i = 0; i < 3; i++) sampler.sample(frame, ahead);
    expect(sampler.sample(frame, ahead)?.distance).toBeCloseTo(1.351, 2);
    expect(calls.length).toBeGreaterThan(1);
  });

  it('keeps trying after a burst of errors at session start', () => {
    const { gl, state } = questGl([RAW.left, RAW.right]);
    let failures = 12;
    const { binding: quest } = questBinding();
    const binding = {
      getDepthInformation: (view: XRView) => {
        if (failures-- > 0) throw new DOMException('Depth not ready', 'InvalidStateError');
        return quest.getDepthInformation(view);
      },
    } as unknown as XRWebGLBinding;
    let t = 0;
    const sampler = createDepthSampler(session(), { space, gl, binding, now: () => t });
    if (!sampler) throw new Error('no sampler');
    state.signaled = true;
    for (let i = 0; i < 12; i++, t += 14) sampler.sample(questFrame(), ahead);
    expect(sampler.stats.lastError).toContain('Depth not ready');
    let hit: DepthHit | null = null;
    for (let i = 0; i < 400 && !hit; i++, t += 14) hit = sampler.sample(questFrame(), ahead);
    expect(hit?.distance).toBeCloseTo(1.351, 2);
  });

  it('answers measure() on the primary page path (update() only, from the first frame)', async () => {
    const { gl, state } = questGl([RAW.left, RAW.right]);
    const { binding, calls } = questBinding();
    const sampler = createDepthSampler(session(), { space, gl, binding, windowFar: 'reported' });
    if (!sampler) throw new Error('no sampler');
    const answer = sampler.measure([ahead]);
    sampler.update(questFrame());
    expect(calls).toEqual(['right']); // asked for the map on the first frame
    state.signaled = true;
    sampler.update(questFrame());
    const [hit] = await answer;
    expect(hit?.distance).toBeCloseTo(1.351, 2);
  });

  it("copies the info's matrices: the runtime may reuse them after the frame", () => {
    const { gl, state } = questGl([RAW.left, RAW.right]);
    const infos: ReturnType<typeof questInfo>[] = [];
    const binding = {
      getDepthInformation: (view: XRView) => {
        const info = questInfo(view.eye);
        infos.push(info);
        return info;
      },
    } as unknown as XRWebGLBinding;
    const sampler = createDepthSampler(session(), { space, gl, binding });
    if (!sampler) throw new Error('no sampler');
    state.signaled = true;
    sampler.sample(questFrame(), ahead);
    for (const info of infos) info.projectionMatrix.fill(0);
    expect(sampler.sample(questFrame(), ahead)?.distance).toBeCloseTo(1.351, 2);
  });

  it('drops a read whose fence never passes, and flushes after later fences', () => {
    const { gl, calls } = questGl([RAW.left, RAW.right]);
    const { binding } = questBinding();
    let t = 0;
    const sampler = createDepthSampler(session(), { space, gl, binding, now: () => t });
    if (!sampler) throw new Error('no sampler');
    sampler.sample(questFrame(), ahead);
    t = 500;
    sampler.sample(questFrame(), ahead);
    expect(sampler.stats).toMatchObject({ readsStarted: 1, readsDropped: 0 });
    expect(sampler.stats.skipped['read in flight']).toBe(1);
    t = 1100;
    sampler.sample(questFrame(), ahead); // drops the lost read, starts a new one
    expect(sampler.stats).toMatchObject({ readsStarted: 2, readsDropped: 1, errors: 1 });
    expect(sampler.stats.lastError).toContain('not finished');
    expect(calls.filter((c) => c === 'flush')).toHaveLength(1);
  });

  it('says why it read nothing', () => {
    const { gl } = questGl([RAW.left, RAW.right]);
    let info: object | null = null;
    const binding = { getDepthInformation: () => info } as unknown as XRWebGLBinding;
    const sampler = createDepthSampler(session(), { space, gl, binding });
    if (!sampler) throw new Error('no sampler');
    sampler.sample(questFrame(), ahead);
    info = { ...questInfo('right'), isValid: false };
    sampler.sample(questFrame(), ahead);
    info = { ...questInfo('right'), texture: null };
    sampler.sample(questFrame(), ahead);
    const noPose = { getViewerPose: () => null } as unknown as XRFrame;
    sampler.sample(noPose, ahead);
    expect(sampler.stats.skipped).toEqual({
      'no info': 1,
      invalid: 1,
      'no texture': 1,
      'no viewer pose': 1,
    });
    expect(sampler.stats).toMatchObject({ infoCalls: 3, readsStarted: 0, calls: 4, frames: 4 });
    expect(sampler.stats.lastSkip).toBe('no viewer pose');
  });

  it('makes its own binding when the one it was given throws', () => {
    const { gl, state } = questGl([RAW.left, RAW.right]);
    const { binding: own, calls } = questBinding();
    vi.stubGlobal(
      'XRWebGLBinding',
      class {
        getDepthInformation(view: XRView) {
          return own.getDepthInformation(view);
        }
      },
    );
    try {
      const broken = {
        getDepthInformation: () => {
          throw new DOMException('binding from another session', 'InvalidStateError');
        },
      } as unknown as XRWebGLBinding;
      const sampler = createDepthSampler(session(), { space, gl, binding: broken });
      if (!sampler) throw new Error('no sampler');
      state.signaled = true;
      sampler.sample(questFrame(), ahead);
      expect(sampler.sample(questFrame(), ahead)?.distance).toBeCloseTo(1.351, 2);
      expect(sampler.stats.ownBinding).toBe(true);
      expect(calls).toHaveLength(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reports normDepthBufferFromNormView only when it is not the identity', () => {
    const { gl, state } = questGl([RAW.left, RAW.right]);
    const flip = [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1, 0, 0, 1, 0, 1];
    let matrix: number[] = IDENTITY;
    const binding = {
      getDepthInformation: (view: XRView) => ({
        ...questInfo(view.eye),
        normDepthBufferFromNormView: { matrix: new Float32Array(matrix) },
      }),
    } as unknown as XRWebGLBinding;
    const sampler = createDepthSampler(session(), { space, gl, binding });
    if (!sampler) throw new Error('no sampler');
    state.signaled = true;
    sampler.sample(questFrame(), ahead);
    sampler.sample(questFrame(), ahead);
    expect(sampler.info?.normTransform).toBeNull();
    matrix = flip;
    sampler.sample(questFrame(), ahead); // starts a read of the flipped map
    sampler.sample(questFrame(), ahead); // collects it
    expect(sampler.info?.normTransform).toEqual(flip);
  });
});

describe('preferDepthSensing', () => {
  const hit = (z: number): DepthHit => ({ point: [0, 0, z], normal: [0, 0, 1], distance: -z });
  const source = (answers: (DepthHit | null)[]): DepthSource & { asked: number[] } => {
    const asked: number[] = [];
    return {
      asked,
      async measure(rays) {
        asked.push(rays.length);
        return rays.map((_, i) => answers[i] ?? null);
      },
    };
  };
  const rays = [rayTo([0, 1, -1]), rayTo([0, 1.2, -1])];

  it('falls back per ray, only for the rays depth sensing missed', async () => {
    const sensing = source([hit(-0.5), null]);
    const hitTest = source([hit(-1.9)]);
    const both = preferDepthSensing(sensing, hitTest);
    expect(await both?.measure(rays)).toEqual([hit(-0.5), hit(-1.9)]);
    expect(hitTest.asked).toEqual([1]);
  });

  it('uses whichever exists', () => {
    const only = source([]);
    expect(preferDepthSensing(null, only)).toBe(only);
    expect(preferDepthSensing(only, null)).toBe(only);
    expect(preferDepthSensing(null, null)).toBeNull();
  });
});

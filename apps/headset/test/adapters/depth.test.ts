import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDepthProbe, XrDepthProbe } from '../../src/adapters/xr/depth';
import { quatFromAxisAngle, type Vec3 } from '../../src/core/math';
import type { Ray } from '../../src/domain/world/camera-model';

// XrDepthProbe against a fake session: each hit-test source is fixed in the reference space, its
// results come on later frames, and it is cancelled once answered.

class FakeRay {
  constructor(
    readonly origin: DOMPointInit,
    readonly direction: DOMPointInit,
  ) {}
}

interface FakeSource {
  init: XRHitTestOptionsInit;
  cancelled: boolean;
  cancel(): void;
}

/** A session whose world is the plane y = `tableY` (hits face up), or nothing when null. */
function fakeSession(tableY: number | null, options: { refuseEntityTypes?: boolean } = {}) {
  const sources: FakeSource[] = [];
  const listeners: (() => void)[] = [];
  const session = {
    enabledFeatures: ['hit-test'],
    addEventListener: (_type: string, fn: () => void) => listeners.push(fn),
    requestHitTestSource: vi.fn(async (init: XRHitTestOptionsInit) => {
      if (options.refuseEntityTypes && init.entityTypes) throw new Error('NotSupportedError');
      const source: FakeSource = {
        init,
        cancelled: false,
        cancel() {
          this.cancelled = true;
        },
      };
      sources.push(source);
      return source;
    }),
  };
  const results = (source: FakeSource) => {
    const ray = source.init.offsetRay as unknown as FakeRay;
    const o = ray.origin as Required<DOMPointInit>;
    const d = ray.direction as Required<DOMPointInit>;
    if (tableY === null || source.cancelled) return [];
    const s = (tableY - o.y) / d.y;
    if (s <= 0) return [];
    const q = quatFromAxisAngle([0, 1, 0], 0);
    return [
      {
        getPose: () => ({
          transform: {
            position: { x: o.x + d.x * s, y: tableY, z: o.z + d.z * s, w: 1 },
            orientation: { x: q[0], y: q[1], z: q[2], w: q[3] },
          },
        }),
      },
    ];
  };
  const frame = {
    getHitTestResults: (source: FakeSource) => results(source),
  } as unknown as XRFrame;
  return {
    session: session as unknown as XRSession,
    request: session.requestHitTestSource,
    sources,
    frame,
    end: () => {
      for (const fn of listeners) fn();
    },
  };
}

const space = {} as XRReferenceSpace;
const down = (x = 0): Ray => {
  const d: Vec3 = [x, -0.6, -0.8];
  const n = Math.hypot(...d);
  return { origin: [0, 1.2, 0], direction: [d[0] / n, d[1] / n, d[2] / n] };
};
/** Let pending promises (source creation) settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => vi.stubGlobal('XRRay', FakeRay));
afterEach(() => vi.unstubAllGlobals());

describe('XrDepthProbe', () => {
  it('hit-tests a world-space ray in the reference space and cancels the source after', async () => {
    const xr = fakeSession(0.7);
    const probe = new XrDepthProbe(xr.session, space);
    const answer = probe.measure([down()]);
    await settle();
    expect(xr.sources).toHaveLength(1);
    const init = xr.sources[0]?.init;
    expect(init?.space).toBe(space);
    expect(init?.entityTypes).toEqual(['plane', 'mesh']);
    const ray = init?.offsetRay as unknown as FakeRay;
    expect(ray.origin).toEqual({ x: 0, y: 1.2, z: 0, w: 1 });
    expect(ray.direction.w).toBe(0);
    probe.update(xr.frame);
    const [hit] = await answer;
    // 0.5 m down at a 0.6/0.8 slope: 0.833 m along the ray.
    expect(hit?.distance).toBeCloseTo(0.5 / 0.6, 6);
    expect(hit?.point[1]).toBeCloseTo(0.7, 6);
    expect(hit?.normal[1]).toBeCloseTo(1, 6);
    expect(xr.sources[0]?.cancelled).toBe(true);
  });

  it('calls a ray that hits nothing for a few frames a miss', async () => {
    const xr = fakeSession(null);
    const probe = new XrDepthProbe(xr.session, space, { maxFrames: 3 });
    const answer = probe.measure([down()]);
    await settle();
    probe.update(xr.frame);
    probe.update(xr.frame);
    probe.update(xr.frame);
    expect(await answer).toEqual([null]);
    expect(xr.sources[0]?.cancelled).toBe(true);
  });

  it('reuses a recent hit for a ray through the same spot, and measures again later', async () => {
    const xr = fakeSession(0.7);
    let now = 0;
    const probe = new XrDepthProbe(xr.session, space, { now: () => now, reuseMs: 300 });
    const first = probe.measure([down()]);
    await settle();
    probe.update(xr.frame);
    const [hit] = await first;
    // The head moved 5 mm: a new ray through the same table spot is answered at once.
    const target = hit?.point ?? [0, 0, 0];
    const origin: Vec3 = [0.005, 1.2, 0];
    const to: Vec3 = [target[0] - origin[0], target[1] - origin[1], target[2] - origin[2]];
    const n = Math.hypot(...to);
    const moved: Ray = { origin, direction: [to[0] / n, to[1] / n, to[2] / n] };
    now = 100;
    const [again] = await probe.measure([moved]);
    expect(xr.request).toHaveBeenCalledTimes(1);
    expect(again?.distance).toBeCloseTo(n, 6);
    // A different spot needs a new measurement; so does the same spot once the answer is old.
    now = 150;
    void probe.measure([down(0.2)]);
    now = 500;
    void probe.measure([moved]);
    await settle();
    expect(xr.request).toHaveBeenCalledTimes(3);
  });

  it('measures alike rays once while the first is in flight', async () => {
    const xr = fakeSession(0.7);
    const probe = new XrDepthProbe(xr.session, space);
    const a = probe.measure([down()]);
    const b = probe.measure([down(0.001)]);
    await settle();
    probe.update(xr.frame);
    const [[hitA], [hitB]] = await Promise.all([a, b]);
    expect(xr.request).toHaveBeenCalledTimes(1);
    expect(hitA?.distance).toBeCloseTo(hitB?.distance ?? 0, 2);
  });

  it('asks for planes only when the runtime refuses the mesh', async () => {
    const xr = fakeSession(0.7, { refuseEntityTypes: true });
    const probe = new XrDepthProbe(xr.session, space);
    const answer = probe.measure([down()]);
    await settle();
    expect(xr.sources[0]?.init.entityTypes).toBeUndefined();
    probe.update(xr.frame);
    expect((await answer)[0]).not.toBeNull();
  });

  it('answers null beyond the rays it may measure at once', async () => {
    const xr = fakeSession(0.7);
    const probe = new XrDepthProbe(xr.session, space, { maxInFlight: 1 });
    const answer = probe.measure([down(), down(0.3)]);
    await settle();
    probe.update(xr.frame);
    const [first, second] = await answer;
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it('answers nothing from the depth map alone, and takes no rays in flight for it', async () => {
    const xr = fakeSession(0.7);
    const probe = new XrDepthProbe(xr.session, space, { maxInFlight: 1 });
    expect(await probe.measure([down(), down(0.3)], { mapOnly: true })).toEqual([null, null]);
    await settle();
    expect(xr.sources).toHaveLength(0);
    const answer = probe.measure([down()]);
    await settle();
    probe.update(xr.frame);
    expect((await answer)[0]).not.toBeNull();
  });

  it('answers rays in flight with null when the session ends', async () => {
    const xr = fakeSession(0.7);
    const probe = new XrDepthProbe(xr.session, space);
    const answer = probe.measure([down()]);
    await settle();
    xr.end();
    expect(await answer).toEqual([null]);
    expect(xr.sources[0]?.cancelled).toBe(true);
    expect(await probe.measure([down(0.5)])).toEqual([null]);
  });
});

describe('createDepthProbe', () => {
  it('is null without hit-test', () => {
    const xr = fakeSession(0.7);
    const noFeature = { ...xr.session, enabledFeatures: ['local-floor'] } as unknown as XRSession;
    expect(createDepthProbe(noFeature, space)).toBeNull();
    vi.unstubAllGlobals();
    expect(createDepthProbe(xr.session, space)).toBeNull();
  });

  it('makes a probe when the session has hit-test', () => {
    expect(createDepthProbe(fakeSession(0.7).session, space)).toBeInstanceOf(XrDepthProbe);
  });
});

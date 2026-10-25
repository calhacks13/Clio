import { describe, expect, test } from "bun:test";
import {
  type CompiledObjectShape,
  type CompiledObjectTrack,
  DERIVED_SCHEMA_ID,
  type TracksDoc,
} from "@clio/protocol";
import {
  buildCaptureFromClio,
  rosFromW,
  wFromRos,
} from "@clio-viewer/capture/from-clio";
import {
  Capture,
  HAND_JOINTS,
  type Handedness,
  ORIENTATION_VALID,
  POSITION_VALID,
  type Quat,
  type Vec3,
} from "@clio-viewer/capture/model";
import {
  SYNTHETIC_TIMES,
  syntheticEpisode,
} from "../__fixtures__/synthetic-episode";
import { objectAt } from "../object-display";
import {
  compiledRestTrack,
  objectRest,
  objectVolume,
  REST_RULE,
  rawRestTrack,
  restAt,
  restedPose,
  restedTrail,
  restPlan,
  restRow,
  type RestTrack,
} from "../object-rest";

// Objects no hand could be touching are drawn still (object-rest.ts): the
// timeline split into reach and rest stretches, each rest stretch's one pose,
// the eases between them, and the trail and inspector note that follow.

const S = 1_000_000;
const FRAME_US = 1_000_000 / 30;
const HEAD: Vec3 = [0, 0, 1.5];
/** Where the hands idle: in front of the learner, well away from the objects below. */
const IDLE: Record<Handedness, Vec3> = {
  left: [0.25, 0.25, 1.0],
  right: [0.25, -0.25, 1.0],
};

const dist = (a: readonly number[], b: readonly number[]) =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** A tiny noise that repeats: ±`size` on each axis, from the sample index. */
const jitter = (i: number, size: number): Vec3 => [
  size * Math.sin(i * 2.1),
  size * Math.sin(i * 3.7 + 1),
  size * Math.sin(i * 5.3 + 2),
];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

type HandAt = (tUs: number) => Vec3 | null;

interface Body {
  durationUs: number;
  /** Each hand's wrist at a time, or null where the hand is not tracked. */
  left?: HandAt;
  right?: HandAt;
  /** Frames are missing in [start, end). */
  gap?: readonly [number, number];
}

/** A capture with a head and both hands every 1/30 s, and no objects yet. */
function bodyCapture(body: Body): Capture {
  const capture = new Capture("test");
  capture.addEntity({
    id: "headset",
    name: "Headset",
    role: "headset",
    motion: "tracked",
    geometry: { type: "none" },
    pose: null,
  });
  const at: Record<Handedness, HandAt> = {
    left: body.left ?? (() => IDLE.left),
    right: body.right ?? (() => IDLE.right),
  };
  let sequence = 0;
  for (let t = 0; t <= body.durationUs; t += FRAME_US) {
    const tUs = Math.round(t);
    if (body.gap && tUs >= body.gap[0] && tUs < body.gap[1]) continue;
    capture.addPose({
      kind: "pose",
      t_us: tUs,
      sequence: sequence++,
      source_id: "clio-xr",
      estimate_type: "runtime_estimate",
      entity_id: "headset",
      location: {
        translation: HEAD,
        rotation: [0, 0, 0, 1],
        location_flags: POSITION_VALID | ORIENTATION_VALID,
      },
      confidence: null,
    });
    for (const side of ["left", "right"] as const) {
      const wrist = at[side](tUs);
      const positions = new Float32Array(HAND_JOINTS * 3).fill(Number.NaN);
      if (wrist) {
        // Joint 1 is the wrist; the fingers reach 12 cm forward of it.
        for (let j = 1; j < HAND_JOINTS; j++) {
          const reach = ((j % 5) / 4) * 0.12;
          positions.set([wrist[0] + reach, wrist[1], wrist[2]], j * 3);
        }
      }
      capture.addHand({
        kind: "hand",
        t_us: tUs,
        sequence: sequence++,
        source_id: "clio-xr",
        estimate_type: "runtime_estimate",
        entity_id: `${side}_hand`,
        handedness: side,
        active: wrist !== null,
        positions,
        radii: new Float32Array(HAND_JOINTS).fill(0.01),
        flags: new Uint8Array(HAND_JOINTS).fill(POSITION_VALID),
        pinch_m: wrist ? 0.05 : null,
      });
    }
  }
  return capture;
}

interface Estimate {
  tUs: number;
  position: Vec3;
  rotation?: Quat | null;
  /** Position not valid: the object is lost. */
  lost?: boolean;
}

function addObject(capture: Capture, id: string, estimates: Estimate[]): void {
  capture.addEntity({
    id,
    name: id,
    role: "object",
    motion: "tracked",
    geometry: { type: "none" },
    pose: null,
    extensions: { radius_m: 0.03, kind: "item" },
  });
  estimates.forEach((e, sequence) => {
    const rotation = e.rotation ?? null;
    capture.addPose({
      kind: "pose",
      t_us: e.tUs,
      sequence,
      source_id: "clio-detector",
      estimate_type: "vision_estimate",
      entity_id: id,
      location: {
        translation: e.position,
        rotation,
        location_flags:
          (e.lost ? 0 : POSITION_VALID) | (rotation ? ORIENTATION_VALID : 0),
      },
      confidence: 0.5,
    });
  });
}

/** Detector estimates five times a second over [fromUs, toUs). */
function every200ms(
  fromUs: number,
  toUs: number,
  at: (tUs: number, i: number) => Vec3,
): Estimate[] {
  const out: Estimate[] = [];
  for (let t = fromUs, i = 0; t < toUs; t += 200_000, i++) {
    out.push({ tUs: t, position: at(t, i) });
  }
  return out;
}

function rest(capture: Capture, id: string) {
  const r = objectRest(capture, 0, id);
  if (!r) throw new Error(`no rest for ${id}`);
  return r;
}

/** What the scene draws at `tUs`: the raw position, held still where it rests. */
function drawnAt(capture: Capture, id: string, tUs: number): Vec3 | null {
  const raw = objectAt(capture, id, tUs, { trailUs: 0 });
  if (!raw?.position) return null;
  return restedPose(rest(capture, id).plan, tUs, raw.position, raw.rotation)
    .position;
}

const FAR: Vec3 = [3, 0, 0.8];

describe("an object no hand could reach", () => {
  const capture = bodyCapture({ durationUs: 10 * S });
  // Mostly within 3 cm of FAR, with a stray estimate a meter off every so often.
  const estimates = every200ms(0, 10 * S, (_, i) =>
    i % 7 === 3 ? add(FAR, [-1.2, 0.3, 0]) : add(FAR, jitter(i, 0.03)),
  );
  addObject(capture, "door", estimates);

  test("rests for the whole recording, from its first estimate", () => {
    const { stretches } = rest(capture, "door").plan;
    expect(stretches).toHaveLength(1);
    expect(stretches[0].startUs).toBe(0);
    expect(stretches[0].endUs).toBe(Infinity);
    expect(stretches[0].easeIn).toBe(false);
    expect(stretches[0].easeOut).toBe(false);
  });

  test("is drawn at one recorded position near the cluster, never a stray", () => {
    const { position } = rest(capture, "door").plan.stretches[0];
    expect(estimates.some((e) => e.position === position)).toBe(true);
    expect(dist(position, FAR)).toBeLessThan(0.03);
    for (let t = 0; t < 10 * S; t += 50_000) {
      expect(drawnAt(capture, "door", t)).toEqual(position);
    }
  });

  test("leaves no trail", () => {
    const { track, plan } = rest(capture, "door");
    const lines = restedTrail(track, plan, 6 * S, 3 * S, 120);
    for (const line of lines) {
      for (const p of line) expect(p).toEqual(plan.stretches[0].position);
    }
  });

  test("the inspector says it is drawn still, in the inferred look", () => {
    const row = restRow(rest(capture, "door").plan, 5 * S);
    expect(row?.label).toBe("Shown");
    expect(row?.value).toBe("Still, out of reach");
    expect(row?.basis).toBe("inferred");
    expect(row?.title).toContain("from 0:00.0 on");
  });
});

describe("a hand moving the object", () => {
  const START: Vec3 = [0.5, 0, 0.8];
  const END: Vec3 = [0.5, -0.4, 0.8];
  // The right hand comes to the object at 2 s, carries it from 3 s to 5 s, and goes back at 6 s.
  const wrist = (tUs: number): Vec3 => {
    const k = (from: number, to: number) =>
      Math.min(1, Math.max(0, (tUs - from) / (to - from)));
    const grasp = add(START, [-0.08, 0, 0]);
    const putDown = add(END, [-0.08, 0, 0]);
    if (tUs < 3 * S) return lerp(IDLE.right, grasp, k(2 * S, 2.5 * S));
    if (tUs < 5 * S) return lerp(grasp, putDown, k(3 * S, 5 * S));
    return lerp(putDown, IDLE.right, k(5.5 * S, 6 * S));
  };
  const objectAtT = (tUs: number): Vec3 => {
    const k = Math.min(1, Math.max(0, (tUs - 3 * S) / (2 * S)));
    return lerp(START, END, k);
  };
  const capture = bodyCapture({ durationUs: 10 * S, right: wrist });
  const estimates = every200ms(0, 10 * S, (t, i) =>
    add(objectAtT(t), jitter(i, 0.01)),
  );
  addObject(capture, "cup", estimates);
  const plan = rest(capture, "cup").plan;

  test("rests before the hand comes and after it leaves, and is tracked between", () => {
    expect(plan.stretches).toHaveLength(2);
    const [before, after] = plan.stretches;
    expect(before.startUs).toBe(0);
    expect(before.endUs).toBeGreaterThan(1.8 * S);
    expect(before.endUs).toBeLessThan(2.5 * S);
    expect(after.startUs).toBeGreaterThan(5 * S);
    expect(after.startUs).toBeLessThan(6 * S);
    expect(after.endUs).toBe(Infinity);
    expect(dist(before.position, START)).toBeLessThan(0.02);
    expect(dist(after.position, END)).toBeLessThan(0.02);
  });

  test("the carried motion is drawn exactly as tracked", () => {
    for (let t = 2.6 * S; t < 5 * S; t += 20_000) {
      const raw = objectAt(capture, "cup", t, { trailUs: 0 })?.position;
      expect(drawnAt(capture, "cup", t)).toEqual(raw ?? null);
      expect(restAt(plan, t)).toBeNull();
    }
  });

  test("entering and leaving a rest stretch does not jump", () => {
    const [before, after] = plan.stretches;
    for (const edge of [before.endUs, after.startUs]) {
      // Frame by frame at 90 Hz across the edge: nothing moves more than the tracked jitter does.
      let previous = drawnAt(capture, "cup", edge - 0.5 * S);
      for (let t = edge - 0.5 * S; t < edge + 0.5 * S; t += S / 90) {
        const now = drawnAt(capture, "cup", t);
        if (previous && now) expect(dist(previous, now)).toBeLessThan(0.04);
        previous = now;
      }
    }
    // At the eased edge the drawn position is the tracked one; inside, the rest pose.
    const raw = objectAt(capture, "cup", after.startUs, { trailUs: 0 });
    expect(drawnAt(capture, "cup", after.startUs)).toEqual(
      raw?.position ?? null,
    );
    expect(drawnAt(capture, "cup", after.startUs + REST_RULE.easeUs)).toEqual(
      after.position,
    );
  });

  test("the trail follows the carry and stops once the object rests", () => {
    const { track } = rest(capture, "cup");
    const moving = restedTrail(track, plan, 4.5 * S, 1 * S, 60).flat();
    expect(dist(moving[0], moving[moving.length - 1])).toBeGreaterThan(0.1);
    const still = restedTrail(track, plan, 9 * S, 2 * S, 60).flat();
    for (const p of still) expect(p).toEqual(plan.stretches[1].position);
  });
});

function lerp(a: Vec3, b: Vec3, k: number): Vec3 {
  return [
    a[0] + (b[0] - a[0]) * k,
    a[1] + (b[1] - a[1]) * k,
    a[2] + (b[2] - a[2]) * k,
  ];
}

describe("hysteresis", () => {
  const OBJECT: Vec3 = [0.6, 0, 0.8];
  const touching = add(OBJECT, [-0.05, 0, 0]);
  const still = every200ms(0, 8 * S, (_, i) => add(OBJECT, jitter(i, 0.01)));

  test("a reach of a frame or two does not end a rest stretch", () => {
    const capture = bodyCapture({
      durationUs: 8 * S,
      right: (t) =>
        t >= 4 * S && t < 4 * S + 2 * FRAME_US ? touching : IDLE.right,
    });
    addObject(capture, "jar", still);
    expect(rest(capture, "jar").plan.stretches).toHaveLength(1);
  });

  test("a real reach ends one and starts another", () => {
    const capture = bodyCapture({
      durationUs: 8 * S,
      right: (t) => (t >= 4 * S && t < 4.5 * S ? touching : IDLE.right),
    });
    addObject(capture, "jar", still);
    const { stretches } = rest(capture, "jar").plan;
    expect(stretches).toHaveLength(2);
    expect(stretches[0].endUs).toBeCloseTo(4 * S, -5);
    expect(stretches[1].startUs).toBeCloseTo(4.5 * S, -5);
    expect(stretches[0].easeOut && stretches[1].easeIn).toBe(true);
  });

  test("a short gap in reach while handling it stays tracked", () => {
    const capture = bodyCapture({
      durationUs: 8 * S,
      right: (t) =>
        t >= 2 * S && t < 6 * S && !(t >= 4 * S && t < 4.3 * S)
          ? touching
          : IDLE.right,
    });
    addObject(capture, "jar", still);
    const { stretches } = rest(capture, "jar").plan;
    expect(stretches).toHaveLength(2);
    expect(stretches[0].endUs).toBeCloseTo(2 * S, -5);
    expect(stretches[1].startUs).toBeCloseTo(6 * S, -5);
  });
});

describe("hands that are not tracked", () => {
  const NEAR_HEAD: Vec3 = [0.4, 0, 1.2]; // 0.5 m from the head
  const BEYOND: Vec3 = [1.5, 0, 0.8]; // 1.65 m from the head

  test("could be touching anything within an arm's reach of the head", () => {
    const capture = bodyCapture({
      durationUs: 4 * S,
      left: () => null,
      right: () => null,
    });
    addObject(
      capture,
      "near",
      every200ms(0, 4 * S, () => NEAR_HEAD),
    );
    addObject(
      capture,
      "far",
      every200ms(0, 4 * S, () => BEYOND),
    );
    expect(rest(capture, "near").plan.stretches).toHaveLength(0);
    expect(rest(capture, "far").plan.stretches).toHaveLength(1);
  });

  test("one tracked far away and the other untracked: the untracked one decides", () => {
    const capture = bodyCapture({ durationUs: 4 * S, left: () => null });
    addObject(
      capture,
      "near",
      every200ms(0, 4 * S, () => NEAR_HEAD),
    );
    expect(rest(capture, "near").plan.stretches).toHaveLength(0);
  });

  test("a hand lost for a moment cannot have got to the object yet", () => {
    // Both hands 0.9 m from the object, which is within arm's reach of the head.
    const away: Vec3 = [0.4, -0.9, 0.9];
    const lostFor = (us: number) =>
      bodyCapture({
        durationUs: 6 * S,
        left: () => away,
        right: (t) => (t >= 3 * S && t < 3 * S + us ? null : away),
      });
    const brief = lostFor(250_000);
    addObject(
      brief,
      "jar",
      every200ms(0, 6 * S, () => NEAR_HEAD),
    );
    expect(rest(brief, "jar").plan.stretches).toHaveLength(1);
    // Lost for a second it could have: the rest stretch ends.
    const long = lostFor(S);
    addObject(
      long,
      "jar",
      every200ms(0, 6 * S, () => NEAR_HEAD),
    );
    expect(rest(long, "jar").plan.stretches).toHaveLength(2);
  });

  test("in a frame gap a hand is only bounded by how far it could have moved", () => {
    // Frames every 1/30 s: the 90th (3 s itself) is the first one missing.
    const lastFrame = Math.round(89 * FRAME_US);
    // The idle hands' nearest joints are this far from the door's sphere.
    const apart = dist([0.37, -0.25, 1.0], FAR) - 0.03;
    const gapped = (endUs: number) => {
      const capture = bodyCapture({ durationUs: 8 * S, gap: [3 * S, endUs] });
      addObject(
        capture,
        "door",
        every200ms(0, 8 * S, () => FAR),
      );
      return rest(capture, "door").plan.stretches;
    };
    // 0.4 s without frames: neither hand could have crossed the room.
    expect(gapped(3.4 * S)).toHaveLength(1);
    // 2 s: they could have, from when they had time to.
    const stretches = gapped(5 * S);
    expect(stretches).toHaveLength(2);
    const could =
      lastFrame +
      ((apart - REST_RULE.contactMarginM) / REST_RULE.handSpeedMS) * S;
    expect(stretches[0].endUs).toBeGreaterThanOrEqual(could);
    expect(stretches[0].endUs).toBeLessThan(could + REST_RULE.stepUs);
    expect(stretches[1].startUs).toBeGreaterThanOrEqual(5 * S);
    expect(stretches[1].startUs).toBeLessThan(5 * S + REST_RULE.stepUs);
  });

  test("never tracked and no head pose: nothing rules a hand out", () => {
    const capture = bodyCapture({
      durationUs: 6 * S,
      left: () => null,
      right: () => null,
      gap: [2 * S, 4 * S],
    });
    addObject(
      capture,
      "door",
      every200ms(0, 6 * S, () => FAR),
    );
    const { stretches } = rest(capture, "door").plan;
    expect(stretches).toHaveLength(2);
    expect(stretches[0].endUs).toBeLessThanOrEqual(
      2 * S + REST_RULE.frameGapUs + REST_RULE.stepUs,
    );
  });
});

describe("held objects", () => {
  test("are within reach for their whole held span, wherever the hands are", () => {
    const capture = bodyCapture({ durationUs: 6 * S });
    addObject(
      capture,
      "jar",
      every200ms(0, 6 * S, () => FAR),
    );
    capture.setSampleHeldSpans("jar", [
      {
        entityId: "jar",
        hand: null,
        startUs: 2 * S,
        endUs: 3 * S,
        origin: "inferred",
        grip: null,
      },
    ]);
    const { stretches } = rest(capture, "jar").plan;
    expect(stretches).toHaveLength(2);
    // Steps are 1/30 s apart, so an edge lands on the first step at or after the span's.
    expect(stretches[0].startUs).toBe(0);
    expect(stretches[0].endUs).toBeGreaterThanOrEqual(2 * S);
    expect(stretches[0].endUs).toBeLessThan(2 * S + REST_RULE.stepUs);
    expect(stretches[1].startUs).toBeGreaterThanOrEqual(3 * S);
    expect(stretches[1].startUs).toBeLessThan(3 * S + REST_RULE.stepUs);
    expect(stretches[1].endUs).toBe(Infinity);
  });
});

describe("the rest pose", () => {
  test("is the recorded pose nearest the median, rotation and all", () => {
    const capture = bodyCapture({ durationUs: 4 * S });
    const turned: Quat = [0, 0, Math.sin(0.3), Math.cos(0.3)];
    // Five estimates within 2 cm and two strays a meter off either side.
    const estimates: Estimate[] = [
      ...[-2, -1, 0, 1, 2].map((d, i) => ({
        tUs: i * 400_000,
        position: add(FAR, [0.01 * d, 0, 0]),
        rotation: d === 0 ? turned : null,
      })),
      { tUs: 2_000_000, position: add(FAR, [1, 1, 0]) },
      { tUs: 2_400_000, position: add(FAR, [-1, -1, 0]) },
    ];
    addObject(capture, "box", estimates);
    const [stretch] = rest(capture, "box").plan.stretches;
    expect(stretch.position).toBe(estimates[2].position);
    expect(stretch.rotation).toEqual(turned);
  });

  test("skips lost estimates, and a stretch with none measured keeps the last drawn one", () => {
    const capture = bodyCapture({ durationUs: 4 * S });
    addObject(capture, "box", [
      { tUs: 0, position: FAR },
      { tUs: 200_000, position: add(FAR, [2, 0, 0]), lost: true },
    ]);
    const { stretches } = rest(capture, "box").plan;
    expect(stretches).toHaveLength(1);
    expect(stretches[0].position).toEqual(FAR);
  });
});

describe("compiled series", () => {
  const fps = 30;
  const n = 6 * fps;
  const t = Array.from({ length: n }, (_, i) => (i * 1000) / fps);
  // In W: the table at y = 0.8 ... ROS z. FAR in W.
  const farW = wFromRos(FAR);

  function compiled(
    positions: (Vec3 | null)[],
    over: Partial<CompiledObjectTrack> = {},
  ): { doc: TracksDoc; track: CompiledObjectTrack } {
    const track: CompiledObjectTrack = {
      id: "door",
      label: "door",
      kind: "item",
      radius: 0.03,
      hidden: false,
      extent: null,
      position: positions,
      orientation: positions.map(() => null),
      tracked: positions.map(() => false),
      interpolated: positions.map(() => false),
      held: positions.map(() => false),
      heldBy: positions.map(() => null),
      confidence: positions.map(() => null),
      source: positions.map((p) => (p ? "detector" : null)),
      heldSpans: [],
      ...over,
    };
    const doc: TracksDoc = {
      schema: DERIVED_SCHEMA_ID,
      episodeId: "ep-test",
      frame: "workspace",
      fps,
      t,
      kind: "tracks",
      policy: { maxInterpolateGapMs: 250, staleMs: 100, maxFrameGapMs: 100 },
      head: t.map(() => null),
      hands: [],
      objects: [track],
    };
    return { doc, track };
  }

  test("a lost stretch, with no position, does not split a rest stretch", () => {
    const capture = bodyCapture({ durationUs: 6 * S });
    addObject(capture, "door", [{ tUs: 0, position: FAR }]);
    const positions = t.map((_, i): Vec3 | null =>
      i >= 60 && i < 120 ? null : add(farW, i < 60 ? [0, 0, 0] : [0.02, 0, 0]),
    );
    const { doc } = compiled(positions);
    const r = objectRest(capture, 0, "door", doc);
    expect(r?.track.samples).toHaveLength(n);
    expect(r?.plan.stretches).toHaveLength(1);
    // Hidden where the compile has no position, still once it is back.
    const shown = r?.plan.stretches[0].position;
    const back = rosFromW(positions[150] as Vec3);
    expect(restedPose(r!.plan, 5 * S, back, null).position).toEqual(
      shown as Vec3,
    );
  });

  test("the compile's shape box widens what a hand can touch", () => {
    // The hand's nearest joint is 20 cm from the tracked point, beside a 30 cm shape box.
    const OBJECT: Vec3 = [0.6, 0, 0.8];
    const capture = bodyCapture({
      durationUs: 6 * S,
      right: (tUs) =>
        tUs >= 2 * S && tUs < 4 * S ? [0.48, 0, 0.8] : IDLE.right,
    });
    addObject(capture, "door", [{ tUs: 0, position: OBJECT }]);
    const positions = t.map(() => wFromRos(OBJECT));
    const { doc, track } = compiled(positions);
    const bare = compiledRestTrack(doc, track, objectVolume(0.03));
    if (!bare) throw new Error("no track");
    // The fingers reach 12 cm past the wrist: 0.48 + 0.12 = 0.60 is the point itself, so move it.
    const offset: RestTrack = {
      ...bare,
      samples: bare.samples.map((s) => ({
        ...s,
        position: s.position ? add(s.position, [0.32, 0, 0]) : null,
      })),
    };
    expect(restPlan(capture, offset).stretches).toHaveLength(1);
    const shape: CompiledObjectShape = {
      id: "door",
      points: [],
      // Offsets in W: 15 cm toward ROS -x (W +z) from the point, 30 cm across.
      box: {
        center: [0, 0, 0.15],
        rotation: [0, 0, 0, 1],
        size: [0.3, 0.3, 0.3],
      },
      samples: 0,
      frames: 0,
      firstT: null,
      lastT: null,
    };
    const boxed: RestTrack = {
      ...offset,
      volume: objectVolume(0.03, track, shape),
    };
    expect(restPlan(capture, boxed).stretches).toHaveLength(2);
  });

  test("held spans count as reach, and the pose comes from the raw estimates", () => {
    const capture = bodyCapture({ durationUs: 6 * S });
    // Raw: five estimates a second within 1 cm of FAR, and one stray 0.5 m off at 4 s.
    const raw = every200ms(0, 6 * S, (_, i) =>
      i === 20 ? add(FAR, [0.5, 0, 0]) : add(FAR, jitter(i, 0.01)),
    );
    addObject(capture, "door", raw);
    // The grid holds the stray from 4 s on (as a compile does when the next estimate is late).
    const positions = t.map((ms) =>
      wFromRos(ms >= 4000 ? add(FAR, [0.5, 0, 0]) : FAR),
    );
    const { doc } = compiled(positions, {
      heldSpans: [
        {
          hand: "right",
          startT: 1000,
          endT: 2000,
          origin: "recorded",
          grip: "pinch",
        },
      ],
    });
    const r = objectRest(capture, 0, "door", doc);
    const stretches = r?.plan.stretches ?? [];
    expect(stretches).toHaveLength(2);
    expect(stretches[0].endUs).toBeGreaterThanOrEqual(S);
    expect(stretches[0].endUs).toBeLessThan(S + REST_RULE.stepUs);
    // Chosen from the raw estimates, each counted once: never the held stray.
    const chosen = stretches[1].position;
    expect(raw.some((e) => e.position === chosen)).toBe(true);
    expect(dist(chosen, FAR)).toBeLessThan(0.02);
  });

  test("without raw estimates the grid frames are the estimates", () => {
    const capture = bodyCapture({ durationUs: 6 * S });
    const positions = t.map(() => farW);
    const { doc, track } = compiled(positions);
    const r = compiledRestTrack(doc, track, objectVolume(0.03));
    expect(r?.estimates).toHaveLength(n);
    expect(restPlan(capture, r!).stretches[0].position).toEqual(rosFromW(farW));
  });
});

describe("objectRest", () => {
  test("is worked out once per capture, revision and compiled documents", () => {
    const capture = bodyCapture({ durationUs: 2 * S });
    addObject(
      capture,
      "door",
      every200ms(0, 2 * S, () => FAR),
    );
    const a = objectRest(capture, 1, "door");
    expect(objectRest(capture, 1, "door")).toBe(a);
    expect(objectRest(capture, 2, "door")).not.toBe(a);
    expect(objectRest(capture, 2, "nothing")).toBeNull();
  });

  test("raw estimates hold a lost position, and the trail breaks there", () => {
    const capture = bodyCapture({ durationUs: 2 * S });
    addObject(capture, "door", [
      { tUs: 0, position: FAR },
      { tUs: 500_000, position: FAR, lost: true },
    ]);
    const track = rawRestTrack(capture, "door", objectVolume(0.03));
    expect(track?.samples.map((s) => [s.position, s.lost])).toEqual([
      [FAR, false],
      [FAR, true],
    ]);
    expect(track?.estimates).toHaveLength(1);
    // Every 50 ms over the second: the line ends where the position was lost.
    const lines = restedTrail(track!, { stretches: [] }, S, S, 21);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveLength(10);
  });
});

describe("the synthetic episode", () => {
  const capture = buildCaptureFromClio(syntheticEpisode());
  const ms = (t: number) => Math.round(t * 1000);

  test("the carried syringe is drawn as tracked through the carry", () => {
    const plan = rest(capture, "syringe").plan;
    for (let t = SYNTHETIC_TIMES.grasp; t < SYNTHETIC_TIMES.release; t += 50) {
      expect(restAt(plan, ms(t))).toBeNull();
    }
  });

  test("it rests where it was put down once the hand has gone", () => {
    const plan = rest(capture, "syringe").plan;
    const last = plan.stretches[plan.stretches.length - 1];
    expect(last.startUs).toBeGreaterThan(ms(SYNTHETIC_TIMES.release));
    expect(last.endUs).toBe(Infinity);
    const raw = objectAt(capture, "syringe", ms(11_000))?.position;
    expect(dist(last.position, raw ?? [0, 0, 0])).toBeLessThan(0.01);
  });

  test("cup A never moves, and is drawn where it was placed", () => {
    const placed = objectAt(capture, "cup_a", 0)?.position;
    for (let t = 0; t < 12_000; t += 250) {
      expect(drawnAt(capture, "cup_a", ms(t))).toEqual(placed ?? null);
    }
  });
});

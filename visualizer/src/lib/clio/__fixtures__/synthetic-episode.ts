import {
  type EpisodeEvent,
  type EpisodeFinish,
  type EpisodeMeta,
  type FrameRecord,
  HAND_LAYOUT,
  type HandSample,
  type Handedness,
  type ObjectState,
  type Pose7,
  type ProcedureInput,
  parseProcedure,
  type Quat,
  type Vec3,
} from "@clio/protocol";

// A synthetic Clio episode built in memory: the raw records the headset
// uploads (meta.json, the frames, events and objects NDJSON, finish.json), for
// tests and the dev harness pages. Pure and deterministic: no I/O, clock or
// randomness.
//
// A small pH lab on a 60 x 40 cm tray. The right hand picks up the syringe,
// carries it to the indicator bottle (step 1) and then to cup A (step 2), and
// puts it down; a detector then re-locates it. Along the way: a right-hand
// dropout mid-carry, a detector answer with latency, a found:false miss and a
// hidden region. Past the script both hands idle, so any duration works.

/** Script times in ms. Grasp, step 2 and release move to the next frame. */
export const SYNTHETIC_TIMES = {
  indicatorDetected: 1200,
  grasp: 2400,
  /** Right hand untracked in [start, end): within the 150 ms pinch grace. */
  dropout: { start: 3500, end: 3620 },
  step2: 5200,
  cupMissed: 6200,
  release: 8400,
  relocated: 9600,
  completed: 10500,
} as const;

/** Detector latencies in ms: an answer's frame was taken at t − latency. */
export const SYNTHETIC_LATENCY = {
  indicator: 850,
  cup: 1100,
  syringe: 700,
} as const;

export interface SyntheticEpisodeOptions {
  /** Default 12 s. */
  durationMs?: number;
  /** XR frame rate, default 72 Hz. */
  hz?: number;
  episodeId?: string;
  /** Wall-clock ms at t = 0. */
  startEpochMs?: number;
  /**
   * Add the recorded-grasp extension (plan section 3.4): meta.features, object
   * locationFlags, heldBy and observedT, and object.grasped / object.released.
   */
  recordedGrasps?: boolean;
}

/** The extension's object fields, optional in clio.episode/1. */
export interface ObjectStateExtension {
  locationFlags?: number;
  heldBy?: Handedness | null;
  observedT?: number;
}

export type SyntheticObjectState = ObjectState & ObjectStateExtension;

export interface SyntheticObjectRecord {
  t: number;
  objects: SyntheticObjectState[];
}

/** The extension's grasp events. */
export type SyntheticGraspEvent =
  | {
      t: number;
      type: "object.grasped";
      objectId: string;
      hand: Handedness;
      grip: "pinch" | "fist";
      position: Vec3;
    }
  | {
      t: number;
      type: "object.released";
      objectId: string;
      hand: Handedness;
      reason: "opened" | "hand_lost" | "plan_changed";
      position: Vec3;
    };

export type SyntheticEvent = EpisodeEvent | SyntheticGraspEvent;

export interface SyntheticEpisode {
  meta: EpisodeMeta & { features?: string[] };
  frames: FrameRecord[];
  events: SyntheticEvent[];
  objects: SyntheticObjectRecord[];
  finish: EpisodeFinish;
}

export interface SyntheticBatch {
  seq: number;
  frames: FrameRecord[];
  events: SyntheticEvent[];
  objects: SyntheticObjectRecord[];
}

const DEFAULTS = {
  durationMs: 12_000,
  hz: 72,
  episodeId: "ep-20261024-120000-synt",
  startEpochMs: Date.UTC(2026, 9, 24, 12),
  recordedGrasps: false,
};

const LAYOUT = {
  cup_a: [0.15, 0.07, -0.12],
  indicator: [0.12, 0.14, -0.28],
  syringe: [0.54, 0.01, -0.06],
  spill_zone: [0.3, 0, -0.04],
} satisfies Record<string, Vec3>;

const PLAN: ProcedureInput = {
  schema: "clio.procedure/1",
  id: "ph-lab-synthetic",
  version: 1,
  title: "Add indicator to a cup",
  summary: "Draw indicator into the syringe and squirt a little into cup A.",
  domain: "lab",
  workspace: { size: [0.6, 0.4] },
  objects: [
    {
      id: "cup_a",
      label: "cup A",
      kind: "container",
      radius: 0.04,
      placement: { method: "layout", position: LAYOUT.cup_a },
    },
    {
      id: "indicator",
      label: "indicator bottle",
      kind: "container",
      radius: 0.035,
      placement: { method: "layout", position: LAYOUT.indicator },
    },
    {
      id: "syringe",
      label: "syringe",
      kind: "tool",
      radius: 0.02,
      placement: { method: "layout", position: LAYOUT.syringe },
      tracking: { query: "plastic oral syringe", moves: true },
    },
    {
      id: "spill_zone",
      label: "front edge",
      kind: "region",
      radius: 0.06,
      hidden: true,
      placement: { method: "layout", position: LAYOUT.spill_zone },
    },
  ],
  steps: [
    {
      id: "draw-indicator",
      instruction:
        "Fill the syringe with purple indicator from the indicator bottle.",
      targets: ["indicator", "syringe"],
      success: { type: "object_near", object: "syringe", target: "indicator" },
    },
    {
      id: "dispense-a",
      instruction: "Squirt a little indicator into cup A.",
      targets: ["cup_a"],
      success: { type: "confirm", by: "either" },
      mistakes: [
        {
          kind: "syringe_on_edge",
          message: "Keep the syringe back from the edge.",
          when: {
            type: "object_near",
            object: "syringe",
            target: "spill_zone",
          },
        },
      ],
    },
  ],
};

/** The right hand's pinch point (workspace frame) and thumb-index aperture. */
const RIGHT_KEYS: readonly (readonly [t: number, p: Vec3, aperture: number])[] =
  [
    [0, [0.42, 0.06, 0.03], 0.07],
    [2000, [0.541, 0.04, -0.058], 0.07],
    [2400, [0.541, 0.018, -0.058], 0.008],
    [4600, [0.125, 0.19, -0.278], 0.008],
    [5600, [0.127, 0.19, -0.276], 0.008],
    [7000, [0.16, 0.17, -0.12], 0.008],
    [7600, [0.162, 0.17, -0.118], 0.008],
    [8400, [0.24, 0.028, -0.1], 0.008],
    [8800, [0.25, 0.05, -0.08], 0.07],
    [10400, [0.42, 0.06, 0.03], 0.07],
  ];

/** Where the detector puts the syringe once it is down: its lift error. */
const RELOCATE_ERROR: Vec3 = [0.005, 0, -0.004];

const round = (v: number, digits: number) => {
  const k = 10 ** digits;
  return Math.round(v * k) / k;
};
const roundT = (t: number) => round(t, 2);
const roundVec = <T extends number[]>(v: T): T =>
  v.map((x) => round(x, 4)) as T;
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (v: Vec3, k: number): Vec3 => [v[0] * k, v[1] * k, v[2] * k];
const lerp = (a: Vec3, b: Vec3, k: number): Vec3 => add(a, scale(sub(b, a), k));
const distance = (a: Vec3, b: Vec3) => Math.hypot(...sub(a, b));
const smoothstep = (k: number) => k * k * (3 - 2 * k);

function quatMultiply(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

/** The right hand at `t`: its pinch point and aperture, eased between keys. */
function rightHand(t: number): { p: Vec3; aperture: number } {
  const next = RIGHT_KEYS.findIndex(([kt]) => kt > t);
  const [t0, p0, a0] =
    RIGHT_KEYS[next === -1 ? RIGHT_KEYS.length - 1 : next - 1];
  const [t1, p1, a1] = RIGHT_KEYS[next === -1 ? RIGHT_KEYS.length - 1 : next];
  const k = t1 > t0 ? smoothstep((t - t0) / (t1 - t0)) : 0;
  return { p: add(lerp(p0, p1, k), idle(t)), aperture: a0 + (a1 - a0) * k };
}

function leftHand(t: number): { p: Vec3; aperture: number } {
  return { p: add([0.1, 0.05, 0], idle(t + 700)), aperture: 0.07 };
}

/** A few millimeters of drift, so an idle hand still moves. */
function idle(t: number): Vec3 {
  return [0.004 * Math.sin(t / 900), 0.002 * Math.sin(t / 1300), 0];
}

/**
 * A palm-down hand around its pinch point: fingers point away from the
 * learner (-z), the thumb on the inner side. Joint orientations are identity.
 */
function handSample(p: Vec3, aperture: number, side: Handedness): HandSample {
  const inner = side === "right" ? -1 : 1;
  const wrist = add(p, [-inner * 0.02, 0.03, 0.09]);
  const thumbTip = add(p, [(inner * aperture) / 2, 0, 0]);
  const indexTip = add(p, [(-inner * aperture) / 2, 0, 0]);
  const curled = (dx: number, dz: number) =>
    add(wrist, [-inner * dx, -0.015, dz]);
  // Each finger from its metacarpal to its tip: thumb 4 joints, the others 5.
  const fingers: [Vec3, Vec3, number][] = [
    [add(wrist, [inner * 0.025, -0.005, -0.02]), thumbTip, 4],
    [add(wrist, [inner * 0.01, 0, -0.035]), indexTip, 5],
    [add(wrist, [-inner * 0.005, 0, -0.035]), curled(0.01, -0.085), 5],
    [add(wrist, [-inner * 0.02, 0, -0.033]), curled(0.03, -0.08), 5],
    [add(wrist, [-inner * 0.035, 0, -0.03]), curled(0.045, -0.07), 5],
  ];
  const joints: number[] = [...roundVec(wrist), 0, 0, 0, 1, 0.012];
  for (const [base, tip, count] of fingers) {
    for (let i = 0; i < count; i++) {
      const at = lerp(base, tip, i / (count - 1));
      joints.push(...roundVec(at), 0, 0, 0, 1, i === count - 1 ? 0.007 : 0.008);
    }
  }
  return { joints, pinch: round(distance(thumbTip, indexTip), 4) };
}

/** Above the near edge, looking down at the tray (40°) with a slow sway. */
function headPose(t: number): Pose7 {
  const pitch = (-40 * Math.PI) / 180;
  const yaw = 0.05 * Math.sin(t / 2300);
  const q = quatMultiply(
    [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)],
    [Math.sin(pitch / 2), 0, 0, Math.cos(pitch / 2)],
  );
  return roundVec([0.3 + 0.01 * Math.sin(t / 1700), 0.45, 0.33, ...q]);
}

/** Frame times: every 1/hz up to and including the duration. */
function frameTimes(durationMs: number, hz: number): number[] {
  const times: number[] = [];
  for (let i = 0; i * (1000 / hz) <= durationMs; i++) {
    times.push(roundT(i * (1000 / hz)));
  }
  return times;
}

/** The first of `times` at or after `t`, or Infinity past the end. */
const atOrAfter = (times: readonly number[], t: number) =>
  times.find((ft) => ft >= t) ?? Infinity;

/**
 * Frames one at a time, so a long stream (minutes at 90 Hz) need not be held in
 * memory. The same times and poses as `syntheticEpisode(options).frames`.
 */
export function* syntheticFrames(
  options: SyntheticEpisodeOptions = {},
): Generator<FrameRecord> {
  const { durationMs, hz } = { ...DEFAULTS, ...options };
  const { start, end } = SYNTHETIC_TIMES.dropout;
  for (const t of frameTimes(durationMs, hz)) {
    const left = leftHand(t);
    const right = rightHand(t);
    yield {
      t,
      head: headPose(t),
      left: handSample(left.p, left.aperture, "left"),
      right:
        t >= start && t < end
          ? null
          : handSample(right.p, right.aperture, "right"),
    };
  }
}

/** A whole synthetic episode: meta, frames, events, objects and finish. */
export function syntheticEpisode(
  options: SyntheticEpisodeOptions = {},
): SyntheticEpisode {
  const o = { ...DEFAULTS, ...options };
  const times = frameTimes(o.durationMs, o.hz);
  const lastT = times[times.length - 1] ?? 0;
  const graspT = atOrAfter(times, SYNTHETIC_TIMES.grasp);
  const step2T = atOrAfter(times, SYNTHETIC_TIMES.step2);
  const releaseT = atOrAfter(times, SYNTHETIC_TIMES.release);
  const relocateT = atOrAfter(times, SYNTHETIC_TIMES.relocated);
  const { start: lostT, end: foundT } = SYNTHETIC_TIMES.dropout;
  const firstLostT = atOrAfter(times, lostT);
  const lastSeenT = times.filter((t) => t < lostT).at(-1) ?? 0;

  const plan = parseProcedure(PLAN);
  const meta: SyntheticEpisode["meta"] = {
    schema: "clio.episode/1",
    episodeId: o.episodeId,
    createdAt: new Date(o.startEpochMs).toISOString(),
    mode: "record_demo",
    procedure: { id: plan.id, version: plan.version, title: plan.title },
    plan,
    operator: { role: "expert" },
    clock: { timeline: "performance.now", startEpochMs: o.startEpochMs },
    space: {
      frame: "workspace",
      units: "m",
      upAxis: "+y",
      worldFromWorkspace: [-0.3, 0.75, -0.45, 0, 0, 0, 1],
      calibration: "pinch_two_corners",
      anchored: false,
    },
    hands: {
      joints: [...HAND_LAYOUT.joints],
      jointFields: [...HAND_LAYOUT.jointFields],
    },
    objects: plan.objects.map((spec) => ({
      id: spec.id,
      label: spec.label,
      position: [...LAYOUT[spec.id as keyof typeof LAYOUT]],
      radius: spec.radius,
      method: "layout" as const,
    })),
    coach: { kind: "none" },
    device: {
      userAgent: "clio-synthetic",
      emulated: true,
      xrFeatures: ["local-floor", "hand-tracking"],
    },
    app: { version: "synthetic" },
    ...(o.recordedGrasps && { features: ["object.flags", "object.grasp"] }),
  };

  const frames = [...syntheticFrames(o)];

  // The syringe rides with the right hand at the offset it had when grasped.
  const offset = sub(LAYOUT.syringe, rightHand(graspT).p);
  const carried = (t: number) => roundVec(add(rightHand(t).p, offset));
  const releasedAt = carried(releaseT);
  const relocated = roundVec(add(releasedAt, RELOCATE_ERROR));
  const ext = (fields: ObjectStateExtension) =>
    o.recordedGrasps ? fields : {};
  const syringe = (
    position: Vec3,
    source: ObjectState["source"],
    confidence: number,
    fields: ObjectStateExtension,
  ): SyntheticObjectState => ({
    id: "syringe",
    position,
    orientation: null,
    confidence,
    source,
    ...ext(fields),
  });

  const objects: SyntheticObjectRecord[] = [
    {
      t: 0,
      objects: meta.objects.map((placed) => ({
        id: placed.id,
        position: [...placed.position],
        orientation: null,
        confidence: 1,
        source: "layout" as const,
        ...ext({ locationFlags: 2, heldBy: null }),
      })),
    },
  ];
  // Held: one line per frame while the hand is tracked; a lost hand stops them.
  for (const t of times) {
    if (t < graspT || t > releaseT) continue;
    const held = t < releaseT;
    if (t >= lostT && t < foundT) {
      // The extension records the loss: position no longer valid, still held.
      if (o.recordedGrasps && t === firstLostT) {
        const last = carried(lastSeenT);
        const flags = { locationFlags: 0, heldBy: "right" } as const;
        objects.push({ t, objects: [syringe(last, "pinch", 1, flags)] });
      }
      continue;
    }
    objects.push({
      t,
      objects: [
        syringe(carried(t), "pinch", 1, {
          locationFlags: 2,
          heldBy: held ? "right" : null,
        }),
      ],
    });
  }
  objects.push({
    t: relocateT,
    objects: [
      syringe(relocated, "detector", 0.78, {
        locationFlags: 10,
        heldBy: null,
        observedT: SYNTHETIC_TIMES.relocated - SYNTHETIC_LATENCY.syringe,
      }),
    ],
  });

  const pinchPoint = (t: number) => roundVec(rightHand(t).p);
  const nearSyringe = (t: number, at: Vec3) => ({
    objectId: "syringe",
    distance: round(distance(pinchPoint(t), at), 4),
  });
  const events: SyntheticEvent[] = [
    {
      t: 0,
      type: "procedure.started",
      procedureId: plan.id,
      version: plan.version,
      stepCount: plan.steps.length,
    },
    stepEntered(plan, 0, 0),
    {
      t: SYNTHETIC_TIMES.indicatorDetected,
      type: "object.detected",
      objectId: "indicator",
      stepId: "draw-indicator",
      phrase: "indicator squeeze bottle",
      description: "Squeeze bottle of purple indicator at the back left",
      found: true,
      point: [0.38, 0.41],
      box: [0.33, 0.3, 0.43, 0.52],
      outline: [
        [0.34, 0.31],
        [0.42, 0.31],
        [0.43, 0.51],
        [0.33, 0.51],
      ],
      confidence: 0.86,
      position: roundVec(add(LAYOUT.indicator, [0.004, 0, 0.006])),
      source: "gemini",
      latencyMs: SYNTHETIC_LATENCY.indicator,
    },
    {
      t: graspT,
      type: "hand.pinch",
      hand: "right",
      phase: "start",
      point: pinchPoint(graspT),
      nearest: nearSyringe(graspT, LAYOUT.syringe),
    },
    {
      t: step2T,
      type: "step.completed",
      stepId: "draw-indicator",
      index: 0,
      by: "check",
      forced: false,
      durationMs: step2T,
    },
    stepEntered(plan, 1, step2T),
    {
      t: SYNTHETIC_TIMES.cupMissed,
      type: "object.detected",
      objectId: "cup_a",
      stepId: "dispense-a",
      phrase: "paper cup A",
      description: "White paper cup with a large letter A, front left",
      found: false,
      point: null,
      box: null,
      outline: null,
      confidence: 0,
      position: null,
      source: "gemini",
      latencyMs: SYNTHETIC_LATENCY.cup,
    },
    {
      t: releaseT,
      type: "hand.pinch",
      hand: "right",
      phase: "end",
      point: pinchPoint(releaseT),
      nearest: nearSyringe(releaseT, releasedAt),
    },
    {
      t: SYNTHETIC_TIMES.relocated,
      type: "object.detected",
      objectId: "syringe",
      stepId: "dispense-a",
      phrase: "oral syringe",
      description: "Clear plastic oral syringe lying beside cup A",
      found: true,
      point: [0.47, 0.62],
      box: [0.41, 0.58, 0.55, 0.66],
      outline: null,
      confidence: 0.78,
      position: relocated,
      source: "jev",
      latencyMs: SYNTHETIC_LATENCY.syringe,
    },
    {
      t: SYNTHETIC_TIMES.relocated,
      type: "object.registered",
      objectId: "syringe",
      position: relocated,
      method: "detector",
    },
    {
      t: SYNTHETIC_TIMES.completed,
      type: "step.completed",
      stepId: "dispense-a",
      index: 1,
      by: "user",
      forced: false,
      durationMs: roundT(SYNTHETIC_TIMES.completed - step2T),
    },
    {
      t: SYNTHETIC_TIMES.completed,
      type: "procedure.completed",
      durationMs: SYNTHETIC_TIMES.completed,
    },
  ];

  if (o.recordedGrasps) {
    events.push(
      {
        t: graspT,
        type: "object.grasped",
        objectId: "syringe",
        hand: "right",
        grip: "pinch",
        position: [...LAYOUT.syringe],
      },
      {
        t: releaseT,
        type: "object.released",
        objectId: "syringe",
        hand: "right",
        reason: "opened",
        position: releasedAt,
      },
    );
    // Stable: each lands after the pinch event at the same time.
    events.sort((a, b) => a.t - b.t);
  }

  const kept = {
    frames,
    events: events.filter((e) => e.t <= lastT),
    objects: objects.filter((r) => r.t <= lastT),
  };
  const completed = kept.events.filter((e) => e.type === "step.completed");
  return {
    meta,
    ...kept,
    finish: {
      durationMs: lastT,
      outcome: kept.events.some((e) => e.type === "procedure.completed")
        ? "completed"
        : "interrupted",
      stepsCompleted: completed.length,
      stepsTotal: plan.steps.length,
      batches: cutBatches(kept).length,
    },
  };
}

function stepEntered(
  plan: ReturnType<typeof parseProcedure>,
  index: number,
  t: number,
): EpisodeEvent {
  const step = plan.steps[index];
  return {
    t,
    type: "step.entered",
    stepId: step.id,
    index,
    instruction: step.instruction,
    targets: step.targets,
  };
}

/**
 * The records as the headset uploads them: a batch is cut after 90 frames or
 * once 1000 ms have passed since the last cut (recorder.ts), and carries the
 * events and object lines recorded up to its last frame.
 */
export function cutBatches(
  episode: Pick<SyntheticEpisode, "frames" | "events" | "objects">,
  { batchFrames = 90, batchIntervalMs = 1000 } = {},
): SyntheticBatch[] {
  const batches: SyntheticBatch[] = [];
  let frames: FrameRecord[] = [];
  let lastCut = 0;
  let e = 0;
  let r = 0;
  const cut = (t: number) => {
    const events: SyntheticEvent[] = [];
    const objects: SyntheticObjectRecord[] = [];
    while (e < episode.events.length && episode.events[e].t <= t) {
      events.push(episode.events[e++]);
    }
    while (r < episode.objects.length && episode.objects[r].t <= t) {
      objects.push(episode.objects[r++]);
    }
    lastCut = t;
    if (frames.length + events.length + objects.length === 0) return;
    batches.push({ seq: batches.length, frames, events, objects });
    frames = [];
  };
  for (const frame of episode.frames) {
    frames.push(frame);
    if (frames.length >= batchFrames || frame.t - lastCut >= batchIntervalMs) {
      cut(frame.t);
    }
  }
  cut(Infinity);
  return batches;
}

/** Records as an NDJSON file body, the way the server stores them. */
export function toNdjson(records: readonly unknown[]): string {
  return records.map((record) => `${JSON.stringify(record)}\n`).join("");
}

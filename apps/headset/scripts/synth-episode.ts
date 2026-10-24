// Generates synthetic, realistic episodes by driving the real domain code (LessonController,
// ProcedureRunner, pinch and grasp perception, the scripted coach, EpisodeRecorder) with hand
// motion built from the same kinematic hand shapes the ghost hands use. Output uses the server's
// on-disk layout, so the Python pipeline and the viewers can be built and tested before anyone
// records on a headset. Three scenarios:
//
//   shirt-fold  An expert folds a shirt: static dots only, with a planted mistake (pinching too
//               low) and its correction.
//   ph-syringe  A learner carries the pH lesson's syringe: grasp, carry, a 300 ms hand dropout
//               while it is in the indicator bottle (past the pinch grace, so the syringe is let go
//               and picked up again when the hand returns), squirts over cups A, B and C, lays it
//               down, then the camera re-locates it. The real ObjectGrounder lifts the answers of a
//               stand-in object finder that takes 1.1 to 1.5 s and misses what a hand covers.
//   tracked-objects  A free capture with the object tracker and no lesson: a stand-in
//               TrackedObjectSource follows a mug the right hand carries, a bottle the left hand
//               hides for a while (coasting, lost, found again) and a marker-tracked tape measure,
//               at 20 Hz with 60 to 120 ms of lag, while jev names them about once a second. The real
//               ObjectTrackRecorder and EnvironmentRecorder record the 2D observations, the 3D
//               states and the room's planes (the table plane grows halfway through); the mug's
//               grasp and release are recorded as events.
//
//   pnpm synth                                  → fixtures/episodes/synthetic-shirt-fold
//   pnpm synth -- --scenario ph-syringe         → fixtures/episodes/synthetic-ph-syringe
//   pnpm synth -- --scenario tracked-objects    → fixtures/episodes/synthetic-tracked-objects
//   pnpm synth -- --out /tmp/ep --hz 72

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  type Detection,
  EPISODE_FEATURE,
  EPISODE_SCHEMA_ID,
  type EpisodeBatchInput,
  type EpisodeCreate,
  type EpisodeFinish,
  type EpisodeMode,
  HAND_LAYOUT,
  type Handedness,
  type NormalizedPoint,
  type PlacedObject,
  parseProcedure,
} from '@clio/protocol';
import { defaultQuestCameraModel } from '../src/adapters/camera/calibration';
import { ScriptedAgent } from '../src/adapters/scripted/scripted-agent';
import { ManualClock } from '../src/core/clock';
import { Emitter } from '../src/core/emitter';
import {
  add,
  composePose,
  invertPose,
  lerp,
  type Pose,
  type Pose7,
  poseToTuple,
  type Quat,
  quatFromAxisAngle,
  quatMultiply,
  rotateVec,
  sub,
  transformPoint,
  type Vec3,
} from '../src/core/math';
import { CoachSession } from '../src/domain/coach/session';
import { CoachToolbox } from '../src/domain/coach/toolbox';
import { DemoLibrary } from '../src/domain/demo/demo-library';
import { gripPoint, type HandShapeId } from '../src/domain/demo/hand-shapes';
import { type Keyframe, sampleTrack } from '../src/domain/demo/keyframes';
import type { AppEvents } from '../src/domain/events';
import { palmPoint, pinchPoint } from '../src/domain/hands/features';
import { PinchDetector } from '../src/domain/hands/pinch-detector';
import { HANDS, type TrackedFrame } from '../src/domain/hands/types';
import { ObjectTrackRecorder } from '../src/domain/recording/object-track-recorder';
import { q4 } from '../src/domain/recording/quantize';
import { EpisodeRecorder } from '../src/domain/recording/recorder';
import type { EpisodeSink } from '../src/domain/recording/sink';
import { LessonController } from '../src/domain/session/lesson-controller';
import { type DetectedPlane, EnvironmentRecorder } from '../src/domain/world/environment';
import {
  type CameraFrameSource,
  type Grounder,
  ObjectGrounder,
  type VisionLocator,
} from '../src/domain/world/grounding';
import { GraspTracker } from '../src/domain/world/holding';
import { ObjectRegistry } from '../src/domain/world/object-registry';
import { PoseHistory } from '../src/domain/world/pose-history';
import type { TrackedObjectSample, TrackedObjectSource } from '../src/domain/world/tracked-object';
import { Workspace } from '../src/domain/world/workspace';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const args = process.argv.slice(2);
const arg = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? fallback) : fallback;
};
const SCENARIO = arg('scenario', 'shirt-fold');
const OUT = resolve(arg('out', join(ROOT, 'fixtures', 'episodes', `synthetic-${SCENARIO}`)));
const HZ = Number(arg('hz', '30'));

/**
 * Writes episodes exactly like the server does (docs/data-format.md). observations.ndjson is
 * written only for episodes that list the "object.observations" feature.
 */
class DirectorySink implements EpisodeSink {
  private observations = false;
  constructor(
    private readonly dir: string,
    private readonly episodeId: string,
    private readonly createdAt: string,
  ) {}
  async create(meta: EpisodeCreate): Promise<string> {
    const { episodeId, createdAt } = this;
    await rm(this.dir, { recursive: true, force: true });
    await mkdir(this.dir, { recursive: true });
    const full = { ...meta, episodeId, createdAt };
    await writeFile(join(this.dir, 'meta.json'), `${JSON.stringify(full, null, 2)}\n`);
    this.observations = meta.features?.includes(EPISODE_FEATURE.objectObservations) ?? false;
    const files = ['frames.ndjson', 'events.ndjson', 'objects.ndjson'];
    for (const f of this.observations ? [...files, 'observations.ndjson'] : files)
      await writeFile(join(this.dir, f), '');
    await writeFile(join(this.dir, 'batches.json'), JSON.stringify({ received: [], gaps: [] }));
    return episodeId;
  }
  async append(_id: string, batch: EpisodeBatchInput): Promise<void> {
    const lines = (rows: unknown[]) => rows.map((r) => `${JSON.stringify(r)}\n`).join('');
    const add = async (file: string, rows: unknown[]) => {
      const path = join(this.dir, file);
      await writeFile(path, (await readFile(path, 'utf8')) + lines(rows));
    };
    await add('frames.ndjson', batch.frames);
    await add('events.ndjson', batch.events);
    await add('objects.ndjson', batch.objects ?? []);
    if (this.observations) await add('observations.ndjson', batch.observations ?? []);
    const bookkeeping = JSON.parse(await readFile(join(this.dir, 'batches.json'), 'utf8'));
    bookkeeping.received.push(batch.seq);
    await writeFile(join(this.dir, 'batches.json'), JSON.stringify(bookkeeping));
  }
  async finish(_id: string, finish: EpisodeFinish): Promise<void> {
    await writeFile(join(this.dir, 'finish.json'), `${JSON.stringify(finish, null, 2)}\n`);
  }
}

// ---- motion ------------------------------------------------------------------------------------

const Q_PINCH: Quat = quatFromAxisAngle([1, 0, 0], (-50 * Math.PI) / 180);
/** Wrist pose that puts the pinch grip point at `at`. */
const pinchAt = (hand: Handedness, at: Vec3): Pose => ({
  p: sub(at, rotateVec(Q_PINCH, gripPoint('pinch', hand))),
  q: Q_PINCH,
});
const key = (t: number, hand: Handedness, at: Vec3, shape: HandShapeId): Keyframe => ({
  t,
  wrist: pinchAt(hand, at),
  shape,
});
const up = (p: Vec3, h: number): Vec3 => [p[0], p[1] + h, p[2]];

/** A head orientation looking from `from` toward `at` (WebXR: the viewer looks down -z, y up). */
function lookAt(from: Readonly<Vec3>, at: Readonly<Vec3>): Quat {
  const [dx, dy, dz] = sub(at, from);
  return quatMultiply(
    quatFromAxisAngle([0, 1, 0], Math.atan2(-dx, -dz)),
    quatFromAxisAngle([1, 0, 0], Math.atan2(dy, Math.hypot(dx, dz))),
  );
}

// ---- the real domain ---------------------------------------------------------------------------

interface ScenarioSetup {
  /** File under procedures/. */
  procedure: string;
  episodeId: string;
  createdAt: string;
  clock: ManualClock;
  workspace: Workspace;
  mode: EpisodeMode;
  role: 'learner' | 'expert';
  /** The camera's object finder. Without one nothing is looked for. */
  grounder?: (registry: ObjectRegistry) => Grounder;
}

/** Builds the lesson, coach, perception and recorder, starts the lesson, and returns the frame step. */
async function setUp(s: ScenarioSetup) {
  const procedure = parseProcedure(
    JSON.parse(await readFile(join(ROOT, 'procedures', s.procedure), 'utf8')),
  );
  const { clock, workspace } = s;
  const bus = new Emitter<AppEvents>((err, type) => console.error(`handler ${String(type)}:`, err));
  const registry = new ObjectRegistry(bus);
  const recorder = new EpisodeRecorder({
    bus,
    clock,
    sink: new DirectorySink(OUT, s.episodeId, s.createdAt),
    sleep: async () => {},
  });
  const agent = new ScriptedAgent();
  const lesson = new LessonController({
    bus,
    clock,
    planner: { plan: async () => Promise.reject(new Error('not used')) },
    registry,
    workspace: () => workspace,
    grounder: s.grounder?.(registry) ?? null,
    images: null,
    demos: new DemoLibrary(null),
    recorder,
    context: () => ({
      operator: { role: s.role },
      coach: { kind: agent.kind },
      device: { userAgent: 'clio-synth', emulated: true, xrFeatures: ['hand-tracking'] },
      app: { version: 'synthetic' },
    }),
    options: { mode: s.mode },
  });
  const toolbox = new CoachToolbox(lesson.handlers(), bus, clock);
  const coach = new CoachSession({
    agent,
    toolbox,
    bus,
    clock,
    view: lesson.view(),
    voice: { play: () => {}, say: () => {}, stop: () => {} },
  });
  await coach.start();

  const pinch = new PinchDetector();
  const grasp = new GraspTracker(registry);
  await lesson.run(procedure);

  /**
   * One tracked frame (workspace space) through perception, the lesson and the recorder, in the
   * order clio-app.ts uses. Returns the ids of the objects let go in this frame.
   */
  const onFrame = (frame: TrackedFrame): string[] => {
    const { t } = frame;
    const released: string[] = [];
    for (const hand of HANDS) {
      const tr = pinch.update(hand, frame[hand], t);
      if (!tr) continue;
      bus.emit('hand.pinch', {
        t,
        hand,
        phase: tr.phase,
        point: tr.point,
        nearest: registry.nearest(tr.point, 0.15),
      });
      released.push(...grasp.onPinch(tr, frame));
      lesson.onPinch(tr);
    }
    released.push(...grasp.update(frame));
    const changes = registry.drainChanges();
    if (changes.length) bus.emit('objects.updated', { t, objects: changes });
    lesson.update({
      t,
      frame,
      pinching: { left: pinch.isPinching('left'), right: pinch.isPinching('right') },
      objects: { position: (id) => registry.position(id) },
    });
    coach.tick(t);
    recorder.recordFrame(frame);
    return released;
  };
  return { lesson, toolbox, coach, registry, onFrame };
}

// ---- shirt-fold --------------------------------------------------------------------------------

const SHOULDER: Vec3 = [0.14, 0.012, -0.18];
const MIDDLE: Vec3 = [0.4, 0.012, -0.18];
const TOO_LOW: Vec3 = [0.4, 0.012, -0.085];
const HEM: Vec3 = [0.68, 0.012, -0.18];

// Left: rest → pinch the shoulder (≈3 s) → carry the fabric over to the hem (≈8 s) → lift.
const LEFT: Keyframe[] = [
  key(0, 'left', [0.1, 0.25, 0.08], 'relaxed'),
  key(1800, 'left', up(SHOULDER, 0.08), 'open'),
  key(2500, 'left', SHOULDER, 'open'),
  key(2900, 'left', SHOULDER, 'pinch'),
  key(6800, 'left', SHOULDER, 'pinch'),
  key(7600, 'left', up([0.41, 0, -0.17], 0.12), 'pinch'),
  key(8400, 'left', HEM, 'pinch'),
  key(9400, 'left', HEM, 'pinch'),
  key(10400, 'left', up(HEM, 0.26), 'pinch'),
  key(11400, 'left', up(HEM, 0.26), 'pinch'),
];
// Right: rest → pinch too low (the planted mistake, ≈4.4 s) → slide up to the middle dot → lift.
const RIGHT: Keyframe[] = [
  key(0, 'right', [0.55, 0.25, 0.08], 'relaxed'),
  key(3400, 'right', up(TOO_LOW, 0.08), 'open'),
  key(4000, 'right', TOO_LOW, 'open'),
  key(4400, 'right', TOO_LOW, 'pinch'),
  key(5200, 'right', TOO_LOW, 'pinch'),
  key(5500, 'right', TOO_LOW, 'open'),
  key(6000, 'right', MIDDLE, 'open'),
  key(6400, 'right', MIDDLE, 'pinch'),
  key(9400, 'right', MIDDLE, 'pinch'),
  key(10400, 'right', up(MIDDLE, 0.26), 'pinch'),
  key(11400, 'right', up(MIDDLE, 0.26), 'pinch'),
];

async function shirtFold(): Promise<void> {
  const clock = new ManualClock(0);
  const { lesson, toolbox, coach, onFrame } = await setUp({
    procedure: 'shirt-fold.json',
    episodeId: 'ep-synthetic-shirt-fold',
    createdAt: '2026-10-24T04:00:00.000Z',
    clock,
    workspace: new Workspace({ p: [0, 0, 0], q: [0, 0, 0, 1] }, 'pinch_two_corners'),
    mode: 'record_demo',
    role: 'expert',
  });

  const dt = 1000 / HZ;
  let confirmedFlat = false;
  let askedForDemo = false;
  for (let t = 0; t <= 12_000; t += dt) {
    clock.set(t);
    const head: Pose = {
      p: [0.38 + 0.01 * Math.sin(t / 900), 0.45, 0.32],
      q: quatFromAxisAngle([1, 0, 0], -0.7),
    };
    onFrame({ t, head, left: sampleTrack(LEFT, t, 'left'), right: sampleTrack(RIGHT, t, 'right') });

    // The expert says the shirt is flat; later the coach shows the crossover demo; finally the
    // expert confirms the fold.
    if (!confirmedFlat && t >= 1000) {
      confirmedFlat = true;
      lesson.confirmByUser('shirt is flat');
    }
    if (!askedForDemo && lesson.currentStep()?.id === 'cross-to-hem') {
      askedForDemo = true;
      await toolbox.handle({ id: 'synth-1', name: 'show_demo', args: {} });
    }
    if (lesson.currentStep()?.id === 'lift-and-fold' && t >= 11_200) lesson.confirmByUser('folded');
    if (lesson.phase === 'done') break;
  }
  await lesson.settled();
  await coach.stop();
  console.log(`wrote ${OUT} (phase: ${lesson.phase})`);
  if (lesson.phase !== 'done') process.exitCode = 1;
}

// ---- ph-syringe --------------------------------------------------------------------------------

// The pH lesson's tray (procedures/ph-indicator.json) on a table: the workspace origin, the tray's
// near-left corner, is 76 cm above the floor and turned 8° from the learner's forward.
const TABLE: Pose = { p: [-0.32, 0.76, -0.38], q: quatFromAxisAngle([0, 1, 0], 0.14) };
const SYRINGE: Vec3 = [0.54, 0.01, -0.06]; // its taped spot
const BOTTLE_MOUTH: Vec3 = [0.12, 0.2, -0.27]; // just above the indicator bottle
const overCup = (x: number): Vec3 => [x, 0.115, -0.12];
const PUT_DOWN: Vec3 = [0.52, 0.01, -0.05];
const REST: Vec3 = [0.62, 0.22, 0.1];
/** The right hand is untracked in this window: longer than the pinch detector's 150 ms grace. */
const DROPOUT = { from: 5450, to: 5750 };
const END_T = 15_000;
/** As in clio-app.ts: look for a put-down object again once the hand is clear of it. */
const RELOCATE_DELAY_MS = 600;
/** The camera model the viewer assumes for recorded detections (detection-outline.ts). */
const CAMERA = defaultQuestCameraModel(1280, 960);

// Right: reach for the syringe and pinch it (≈2.4 s); carry it to the indicator bottle and lower it
// in; hold while drawing, untracked for 300 ms behind the bottle; squirt over cups A, B and C; lay
// it down beside its spot and let go (≈12.2 s); move away.
const PH_RIGHT: Keyframe[] = [
  key(0, 'right', REST, 'relaxed'),
  key(1500, 'right', up(SYRINGE, 0.08), 'open'),
  key(2100, 'right', SYRINGE, 'open'),
  key(2500, 'right', SYRINGE, 'pinch'),
  key(3000, 'right', up(SYRINGE, 0.15), 'pinch'),
  key(4300, 'right', up(BOTTLE_MOUTH, 0.06), 'pinch'),
  key(5300, 'right', BOTTLE_MOUTH, 'pinch'),
  key(6800, 'right', up(BOTTLE_MOUTH, -0.01), 'pinch'),
  key(7600, 'right', overCup(0.15), 'pinch'),
  key(8400, 'right', overCup(0.15), 'pinch'),
  key(9000, 'right', overCup(0.3), 'pinch'),
  key(9800, 'right', overCup(0.3), 'pinch'),
  key(10400, 'right', overCup(0.45), 'pinch'),
  key(11200, 'right', overCup(0.45), 'pinch'),
  key(12000, 'right', PUT_DOWN, 'pinch'),
  key(12400, 'right', PUT_DOWN, 'open'),
  key(13000, 'right', up(PUT_DOWN, 0.12), 'open'),
  key(14000, 'right', REST, 'relaxed'),
];
// Left: resting on the near edge of the table.
const PH_LEFT: Keyframe[] = [
  key(0, 'left', [0, 0.2, 0.12], 'relaxed'),
  key(END_T, 'left', [0.03, 0.21, 0.09], 'relaxed'),
];
/** Both hands as tracked at t: the right one is lost during the dropout. */
const phHands = (t: number) => ({
  left: sampleTrack(PH_LEFT, t, 'left'),
  right: t >= DROPOUT.from && t < DROPOUT.to ? null : sampleTrack(PH_RIGHT, t, 'right'),
});

/** What the app leaves to setTimeout or a network round trip, run between frames on the scene clock. */
class Timers {
  private readonly queue: { t: number; run: () => void }[] = [];

  at(t: number, run: () => void): void {
    this.queue.push({ t, run });
  }

  until(t: number): Promise<void> {
    return new Promise((done) => this.at(t, done));
  }

  /** Runs everything due by `t` (everything when omitted) in time order, settling each in turn. */
  async run(t = Number.POSITIVE_INFINITY): Promise<void> {
    for (;;) {
      let next: { t: number; run: () => void } | undefined;
      for (const item of this.queue) if (item.t <= t && (!next || item.t < next.t)) next = item;
      if (!next) return;
      this.queue.splice(this.queue.indexOf(next), 1);
      next.run();
      await new Promise((settled) => setImmediate(settled));
    }
  }
}

interface InImage {
  /** Normalized image coordinates, y down. */
  uv: [number, number];
  /** Distance in front of the camera (m). */
  depth: number;
}

/** Where a world point lands in a camera image, or null behind the camera. */
function project(worldFromHead: Pose, p: Readonly<Vec3>): InImage | null {
  const c = transformPoint(invertPose(composePose(worldFromHead, CAMERA.headFromCamera)), p);
  if (c[2] > -0.01) return null;
  const { width, height, fx, fy, cx, cy } = CAMERA.intrinsics;
  return {
    uv: [(cx - (fx * c[0]) / c[2]) / width, (cy + (fy * c[1]) / c[2]) / height],
    depth: -c[2],
  };
}

/**
 * A stand-in object finder that sees the synthetic scene exactly as the tracker has it: each object
 * is a box from the table up to its top, found when its center is in view and no hand in front of
 * it covers its box. It answers 1.1 to 1.5 s after the frame was taken, like the real finders.
 */
function standInFinder(
  registry: ObjectRegistry,
  poses: PoseHistory,
  workspace: Workspace,
  timers: Timers,
): VisionLocator {
  const unit = (v: number) => Math.min(1, Math.max(0, v));
  const see = (id: string, frameT: number, head: Pose, look: number): Detection[] => {
    const est = registry.get(id);
    if (!est) return [];
    const [x, y, z] = est.position;
    const r = est.spec.radius;
    const top = Math.max(2 * y, y + r);
    const center = project(head, workspace.toWorldPoint(est.position));
    const corners = [-r, r].flatMap((dx) =>
      [0, top].flatMap((h) =>
        [-r, r].map((dz) => project(head, workspace.toWorldPoint([x + dx, h, z + dz]))),
      ),
    );
    const seen = corners.filter((c) => c !== null);
    if (!center || center.uv.some((v) => v < 0 || v > 1) || seen.length < corners.length) return [];
    const us = seen.map(({ uv }) => uv[0]);
    const vs = seen.map(({ uv }) => uv[1]);
    const box: [number, number, number, number] = [
      unit(Math.min(...us)),
      unit(Math.min(...vs)),
      unit(Math.max(...us)),
      unit(Math.max(...vs)),
    ];
    const { left, right } = phHands(frameT);
    const covered = [left, right].some(
      (hand) =>
        hand &&
        [palmPoint(hand), pinchPoint(hand)].some((p) => {
          const at = project(head, workspace.toWorldPoint(p));
          if (!at || at.depth >= center.depth) return false;
          const [u, v] = at.uv;
          return u >= box[0] && u <= box[2] && v >= box[1] && v <= box[3];
        }),
    );
    if (covered) return [];
    return [
      {
        id,
        found: true,
        point: center.uv,
        box,
        outline: null,
        // A thin, clear syringe is harder to see than a cup or a bottle.
        confidence: (est.spec.kind === 'tool' ? 0.78 : 0.92) - 0.02 * (look % 3),
      },
    ];
  };
  let looks = 0;
  return {
    async locate(frame, objects) {
      const look = looks++;
      const head = poses.at(frame.t);
      const detections = head ? objects.flatMap((o) => see(o.id, frame.t, head, look)) : [];
      await timers.until(frame.t + 1100 + 200 * (look % 3));
      return { detections, model: 'synthetic-finder' };
    },
  };
}

async function phSyringe(): Promise<void> {
  const clock = new ManualClock(0, Date.UTC(2026, 9, 24, 5, 0, 0));
  const workspace = new Workspace(TABLE, 'pinch_two_corners');
  const poses = new PoseHistory(256);
  const timers = new Timers();
  const camera: CameraFrameSource = {
    capture: async () => ({ t: clock.now(), width: 1280, height: 960, jpegBase64: '' }),
    model: () => CAMERA,
  };
  // The learner watches the working hand, starting from the middle of the tray.
  let gaze: Vec3 = [0.36, 0.05, -0.14];
  const headAt = (t: number): Pose => {
    const p: Vec3 = [0.34 + 0.012 * Math.sin(t / 1100), 0.46 + 0.005 * Math.sin(t / 700), 0.3];
    return { p, q: lookAt(p, gaze) };
  };
  // The head is tracked before the lesson starts, so its first look has a pose to lift from.
  poses.push(0, workspace.toWorldPose(headAt(0)));
  const { lesson, coach, registry, onFrame } = await setUp({
    procedure: 'ph-indicator.json',
    episodeId: 'ep-synthetic-ph-syringe',
    createdAt: '2026-10-24T05:00:00.000Z',
    clock,
    workspace,
    mode: 'learn',
    role: 'learner',
    grounder: (registry) =>
      new ObjectGrounder({
        camera,
        locator: standInFinder(registry, poses, workspace, timers),
        registry,
        poses,
        workspace: () => workspace,
      }),
  });

  const dt = 1000 / HZ;
  for (let t = 0; t <= END_T; t += dt) {
    clock.set(t);
    await timers.run(t);
    const { left, right } = phHands(t);
    const head = headAt(t);
    poses.push(t, workspace.toWorldPose(head));
    const released = onFrame({ t, head, left, right });
    if (right) gaze = lerp(gaze, pinchPoint(right), 1 - Math.exp(-dt / 300));
    // Look for what was let go once the hand is clear, unless it has been picked up again.
    if (released.length > 0) {
      timers.at(t + RELOCATE_DELAY_MS, () =>
        lesson.relocate(released.filter((id) => !registry.get(id)?.heldBy)),
      );
    }
  }
  // The learner stops after dispensing. Answers still in flight arrive after the recording ends.
  const stopped = lesson.stop('learner stopped after dispensing');
  await timers.run();
  await stopped;
  await coach.stop();
  const syringe = registry.get('syringe');
  console.log(
    `wrote ${OUT} (phase: ${lesson.phase}, steps done: ${lesson.runnerState?.stepIndex}, syringe: ${syringe?.source})`,
  );
  if (lesson.runnerState?.stepIndex !== 2 || syringe?.source !== 'detector') process.exitCode = 1;
}

// ---- tracked-objects ---------------------------------------------------------------------------

// A desk in a room: the workspace origin, its near-left corner, is 74 cm above the floor and turned
// 6° from the collector's forward. The props are upright cylinders whose reference point is their
// center, as in the plan layouts.
const DESK: Pose = { p: [-0.42, 0.74, -0.46], q: quatFromAxisAngle([0, 1, 0], -0.1) };
const TRACKED_END_T = 8000;
/** The tracker's camera frames: 20 Hz, each answered 60 to 120 ms after it was taken. */
const TRACK_PERIOD_MS = 50;
const trackLag = (k: number) => 90 + 30 * Math.sin(k / 6);
/** jev names the objects about once a second and answers 700 to 900 ms later. */
const JEV_PERIOD_MS = 1000;
const jevLag = (k: number) => 800 + 100 * Math.sin(k * 1.7);
/** The table plane grows here: Quest refines its outline as more of the desk is seen. */
const TABLE_GROWS_T = 4100;

interface Prop {
  id: string;
  label: string;
  radius: number;
  height: number;
}
const MUG: Prop = { id: 'mug', label: 'mug', radius: 0.045, height: 0.1 };
const BOTTLE: Prop = { id: 'bottle', label: 'water bottle', radius: 0.035, height: 0.22 };
const TAPE: Prop = { id: 'tape', label: 'tape measure', radius: 0.035, height: 0.05 };
const MUG_START: Vec3 = [0.22, 0.05, -0.2];
const MUG_END: Vec3 = [0.48, 0.05, -0.13];
const BOTTLE_AT: Vec3 = [0.1, 0.11, -0.32];
const TAPE_AT: Vec3 = [0.62, 0.025, -0.27];
const TAPE_YAW = quatFromAxisAngle([0, 1, 0], 0.35);
/** Where the right hand pinches the mug: the rim nearest the collector. */
const atRim = (center: Vec3): Vec3 => add(center, [0, MUG.height / 2, MUG.radius]);

/** The right hand holds the mug from the pinch to the put-down, recorded as a grasp and a release. */
const MUG_GRASP = { from: 2300, to: 4800 };
/** The right hand closes over the mug: the tracker coasts on its last box. */
const MUG_COAST = { from: 2150, to: 2450 };
/** The left hand hides the bottle: the tracker coasts, loses it, and finds it again by look. */
const BOTTLE_COAST = { from: 3900, to: 4250 };
const BOTTLE_LOST = { from: 4250, to: 5300 };
const within = (t: number, span: { from: number; to: number }) => t >= span.from && t < span.to;

/** A turn of the wrist about the forearm (the wrist frame's z axis). */
const roll = (angle: number): Quat => quatFromAxisAngle([0, 0, 1], angle);
/** A keyframe whose pinch grip point is at `at`, the wrist turned by `turn` from the pinch pose. */
function turned(
  t: number,
  hand: Handedness,
  at: Vec3,
  shape: HandShapeId,
  turn: Quat = [0, 0, 0, 1],
): Keyframe {
  const q = quatMultiply(Q_PINCH, turn);
  return { t, wrist: { p: sub(at, rotateVec(q, gripPoint('pinch', hand))), q }, shape };
}

// Right: reach for the mug and pinch its rim (≈2.3 s), lift it with the wrist rolled, carry it to
// the right turning the wrist the other way, put it down (≈4.8 s), let go and move away.
const TRACKED_RIGHT: Keyframe[] = [
  turned(0, 'right', [0.64, 0.2, 0.08], 'relaxed'),
  turned(1200, 'right', up(atRim(MUG_START), 0.08), 'open'),
  turned(1900, 'right', atRim(MUG_START), 'open'),
  turned(MUG_GRASP.from, 'right', atRim(MUG_START), 'pinch'),
  turned(3000, 'right', up(atRim(MUG_START), 0.15), 'pinch', roll(0.45)),
  turned(
    4100,
    'right',
    up(atRim(MUG_END), 0.12),
    'pinch',
    quatMultiply(roll(-0.35), quatFromAxisAngle([0, 1, 0], 0.3)),
  ),
  turned(MUG_GRASP.to, 'right', atRim(MUG_END), 'pinch', roll(-0.1)),
  turned(5300, 'right', atRim(MUG_END), 'open', roll(-0.1)),
  turned(6000, 'right', up(atRim(MUG_END), 0.14), 'open'),
  turned(7200, 'right', [0.64, 0.2, 0.08], 'relaxed'),
];
// Left: rests on the near edge, then reaches across in front of the bottle, turning the palm up,
// and comes back.
const TRACKED_LEFT: Keyframe[] = [
  turned(0, 'left', [0.04, 0.18, 0.1], 'relaxed'),
  turned(3300, 'left', [0.06, 0.2, 0.06], 'relaxed', roll(0.2)),
  turned(4000, 'left', [0.13, 0.2, -0.16], 'open', roll(-0.6)),
  turned(4900, 'left', [0.12, 0.22, -0.17], 'open', roll(-0.9)),
  turned(5500, 'left', [0.05, 0.19, 0.08], 'relaxed', roll(0.1)),
  turned(TRACKED_END_T, 'left', [0.04, 0.18, 0.1], 'relaxed'),
];

/** The collector looks at the middle of the desk, swaying a little. */
function trackedHead(t: number): Pose {
  const p: Vec3 = [0.36 + 0.012 * Math.sin(t / 1300), 0.5 + 0.006 * Math.sin(t / 800), 0.36];
  return { p, q: lookAt(p, [0.36, 0.2, -0.25]) };
}

/** The mug's center (W): it rides with the pinch while held. */
function mugAt(t: number): Vec3 {
  if (t <= MUG_GRASP.from) return MUG_START;
  const grip = (at: number) => {
    const hand = sampleTrack(TRACKED_RIGHT, at, 'right');
    return hand ? pinchPoint(hand) : atRim(MUG_START);
  };
  return add(MUG_START, sub(grip(Math.min(t, MUG_GRASP.to)), grip(MUG_GRASP.from)));
}

/** A small, repeatable lifting error (m) for measured positions. */
const wobble = (k: number, seed: number): Vec3 => [
  0.002 * Math.sin(k * 0.7 + seed),
  0.0015 * Math.sin(k * 1.1 + 2 * seed),
  0.002 * Math.sin(k * 0.9 + 3 * seed),
];

type ImageGeometry = NonNullable<TrackedObjectSample['image']>;
const unit = (v: number) => Math.min(1, Math.max(0, v));
const clampPoint = ([u, v]: readonly [number, number]): NormalizedPoint => [unit(u), unit(v)];

/** Convex hull of image points (monotone chain). */
function hull(points: readonly NormalizedPoint[]): NormalizedPoint[] {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const turn = (o: NormalizedPoint, a: NormalizedPoint, b: NormalizedPoint) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (pts: readonly NormalizedPoint[]) => {
    const out: NormalizedPoint[] = [];
    for (const p of pts) {
      while (out.length >= 2 && turn(out.at(-2) ?? p, out.at(-1) ?? p, p) <= 0) out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };
  return [...half(sorted), ...half([...sorted].reverse())];
}

function boxOf(points: readonly NormalizedPoint[]): ImageGeometry['box'] {
  const us = points.map((p) => p[0]);
  const vs = points.map((p) => p[1]);
  return [Math.min(...us), Math.min(...vs), Math.max(...us), Math.max(...vs)];
}

/** Projects W points into the camera image of the world head pose; throws if one is behind it. */
function imageOf(head: Pose, workspace: Workspace, points: readonly Vec3[]): NormalizedPoint[] {
  return points.map((p) => {
    const at = project(head, workspace.toWorldPoint(p));
    if (!at) throw new Error(`synthetic scene: ${p.join(', ')} is behind the camera`);
    return clampPoint(at.uv);
  });
}

/** A prop's mask as YOLOE-26 would draw it: the outline of the cylinder, its box, center, contact. */
function propImage(
  head: Pose,
  workspace: Workspace,
  prop: Prop,
  center: Vec3,
  frame: ImageGeometry['frame'],
): ImageGeometry {
  const rim = Array.from({ length: 16 }, (_, i) => (i / 16) * 2 * Math.PI);
  const edge = [-prop.height / 2, prop.height / 2].flatMap((dy) =>
    rim.map((a): Vec3 => add(center, [prop.radius * Math.cos(a), dy, prop.radius * Math.sin(a)])),
  );
  const outline = hull(imageOf(head, workspace, edge));
  const [point, contact] = imageOf(head, workspace, [
    center,
    add(center, [0, -prop.height / 2, prop.radius]),
  ]);
  return { box: boxOf(outline), outline, point: point ?? null, contact: contact ?? null, frame };
}

/** The tape's marker as the marker tracker sees it: the 3 cm square on its top. */
function markerImage(
  head: Pose,
  workspace: Workspace,
  frame: ImageGeometry['frame'],
): ImageGeometry {
  const top = add(TAPE_AT, [0, TAPE.height / 2, 0]);
  const corners = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ].map(([x = 0, z = 0]) => add(top, rotateVec(TAPE_YAW, [0.015 * x, 0, 0.015 * z])));
  const outline = imageOf(head, workspace, corners);
  const [point] = imageOf(head, workspace, [top]);
  return { box: boxOf(outline), outline, point: point ?? null, contact: null, frame };
}

interface Answer {
  /** When the answer reaches the headset (scene ms). */
  at: number;
  sample: TrackedObjectSample;
}

/** What the tracker answers for one camera frame: the mug, the bottle and the tape. */
function trackerAnswers(k: number, workspace: Workspace): Answer[] {
  const observedT = 20 + k * TRACK_PERIOD_MS;
  const at = observedT + trackLag(k);
  const head = workspace.toWorldPose(trackedHead(observedT));
  const frame = { seq: k, width: CAMERA.intrinsics.width, height: CAMERA.intrinsics.height };
  const yoloe = { observedT, role: 'tracker', source: 'yoloe-26l-seg', orientation: null } as const;
  const world = (p: Vec3, seed: number) => workspace.toWorldPoint(add(p, wobble(k, seed)));

  const mugCoasting = within(observedT, MUG_COAST);
  const mugCenter = mugAt(mugCoasting ? MUG_COAST.from : observedT);
  const mug: TrackedObjectSample = {
    ...yoloe,
    objectId: MUG.id,
    status: mugCoasting ? 'predicted' : 'measured',
    score: mugCoasting
      ? 0.62 - (0.6 * (observedT - MUG_COAST.from)) / 1000
      : 0.86 + 0.04 * Math.sin(k / 3),
    trackId: '3',
    image: propImage(head, workspace, MUG, mugCenter, frame),
    // Coasting, the predicted box is lifted like a measured one.
    position: world(mugCenter, 1),
  };

  const lost = within(observedT, BOTTLE_LOST);
  const coasting = within(observedT, BOTTLE_COAST);
  const found = observedT >= BOTTLE_LOST.to;
  const bottle: TrackedObjectSample = {
    ...yoloe,
    objectId: BOTTLE.id,
    status: lost ? 'lost' : coasting ? 'predicted' : 'measured',
    score: lost
      ? null
      : coasting
        ? 0.6 - (0.6 * (observedT - BOTTLE_COAST.from)) / 1000
        : found
          ? Math.min(0.82, 0.35 + (0.47 * (observedT - BOTTLE_LOST.to)) / 1000)
          : 0.82 + 0.03 * Math.sin(k / 4),
    // Found again by appearance, the bottle is a new track.
    trackId: lost ? null : found ? '9' : '5',
    // Lost, the mask has no geometry but still names its frame.
    image: lost
      ? { box: null, outline: null, point: null, contact: null, frame }
      : propImage(head, workspace, BOTTLE, BOTTLE_AT, frame),
    // Coasting behind the hand, there is a predicted box but nothing to lift it with.
    position: lost || coasting ? null : world(BOTTLE_AT, 2),
  };

  const tape: TrackedObjectSample = {
    objectId: TAPE.id,
    observedT,
    status: 'measured',
    role: 'tracker',
    source: 'aruco_4x4_50',
    score: 0.95,
    trackId: '4',
    image: markerImage(head, workspace, frame),
    position: world(TAPE_AT, 3),
    orientation: workspace.toWorldPose({
      p: TAPE_AT,
      q: quatMultiply(TAPE_YAW, quatFromAxisAngle([0, 1, 0], 0.01 * Math.sin(k / 2))),
    }).q,
  };
  return [mug, bottle, tape].map((sample) => ({ at, sample }));
}

/** What jev answers about the mug and the bottle for one look: their box, or that it is not there. */
function jevAnswers(j: number, workspace: Workspace): Answer[] {
  const observedT = 500 + j * JEV_PERIOD_MS;
  const at = observedT + jevLag(j);
  const head = workspace.toWorldPose(trackedHead(observedT));
  const look = (prop: Prop, center: Vec3, hidden: boolean): TrackedObjectSample => {
    const seen = hidden ? null : propImage(head, workspace, prop, center, null);
    return {
      objectId: prop.id,
      observedT,
      status: hidden ? 'absent' : 'measured',
      role: 'identifier',
      source: 'jev',
      score: hidden ? null : 0.8,
      trackId: null,
      image: seen && {
        box: seen.box,
        outline: null,
        point: seen.point,
        contact: null,
        frame: null,
      },
      position: null,
      orientation: null,
    };
  };
  const bottleHidden = observedT >= BOTTLE_COAST.from && observedT < BOTTLE_LOST.to;
  return [look(MUG, mugAt(observedT), false), look(BOTTLE, BOTTLE_AT, bottleHidden)].map(
    (sample) => ({ at, sample }),
  );
}

/**
 * The tracker and jev behind one TrackedObjectSource. Every answer is computed from the synthetic
 * scene up front and delivered at its arrival time on the scene clock.
 */
function standInTracker(
  workspace: Workspace,
  clock: ManualClock,
  timers: Timers,
): TrackedObjectSource {
  const answers: Answer[] = [];
  const last = TRACKED_END_T - 50;
  for (let k = 0; 20 + k * TRACK_PERIOD_MS + trackLag(k) <= last; k++)
    answers.push(...trackerAnswers(k, workspace));
  for (let j = 0; 500 + j * JEV_PERIOD_MS + jevLag(j) <= last; j++)
    answers.push(...jevAnswers(j, workspace));
  return {
    start(onSample) {
      let running = true;
      for (const { at, sample } of answers) {
        timers.at(at, () => {
          if (!running) return;
          clock.set(at);
          onSample(sample);
        });
      }
      return () => {
        running = false;
      };
    },
  };
}

const rect = (hx: number, hz: number): [number, number][] => [
  [-hx, -hz],
  [hx, -hz],
  [hx, hz],
  [-hx, hz],
];

/** The room's planes as Quest reports them (world space): floor, desk, and two walls. */
function trackedPlanes(t: number, workspace: Workspace): DetectedPlane[] {
  const grown = t >= TABLE_GROWS_T;
  return [
    {
      key: 'plane-1',
      orientation: 'horizontal',
      label: 'floor',
      pose: { p: [0, 0, 0], q: [0, 0, 0, 1] },
      polygon: rect(2.5, 2.5),
      changedAt: 0,
    },
    {
      key: 'plane-2',
      orientation: 'horizontal',
      label: 'table',
      pose: workspace.toWorldPose({ p: [0.5, 0, -0.32], q: [0, 0, 0, 1] }),
      polygon: grown ? rect(0.62, 0.4) : rect(0.42, 0.3),
      changedAt: grown ? TABLE_GROWS_T : 0,
    },
    {
      // Facing the collector: the plane's +y (its normal) points along world +z.
      key: 'plane-3',
      orientation: 'vertical',
      label: 'wall',
      pose: { p: [0, 1.3, -1.9], q: quatFromAxisAngle([1, 0, 0], Math.PI / 2) },
      polygon: rect(2.5, 1.3),
      changedAt: 0,
    },
    {
      // On the left: the normal points along world +x.
      key: 'plane-4',
      orientation: 'vertical',
      label: 'wall',
      pose: { p: [-2.3, 1.3, -0.2], q: quatFromAxisAngle([0, 0, 1], -Math.PI / 2) },
      polygon: rect(1.3, 2.5),
      changedAt: 0,
    },
  ];
}

async function trackedObjects(): Promise<void> {
  const clock = new ManualClock(0, Date.UTC(2026, 9, 24, 6, 0, 0));
  const workspace = new Workspace(DESK, 'pinch_two_corners');
  const timers = new Timers();
  const bus = new Emitter<AppEvents>((err, type) => console.error(`handler ${String(type)}:`, err));
  const recorder = new EpisodeRecorder({
    bus,
    clock,
    sink: new DirectorySink(OUT, 'ep-synthetic-tracked-objects', '2026-10-24T06:00:00.000Z'),
    sleep: async () => {},
    onDrop: (why) => {
      console.error(`dropped ${why}`);
      process.exitCode = 1;
    },
  });
  // No holder: the tracker cannot tell who carries what, so its states leave heldBy out and the
  // grasp events below are the record of the carry.
  const tracks = new ObjectTrackRecorder({
    bus,
    clock,
    workspace: () => workspace,
    states: 'record',
  });
  const environment = new EnvironmentRecorder({ bus });

  const counts = { observations: 0, snapshots: 0, grasps: 0, flags: new Map<number, number>() };
  bus.on('objects.observed', () => counts.observations++);
  bus.on('environment.planes', () => counts.snapshots++);
  bus.on('object.grasped', () => counts.grasps++);
  bus.on('object.released', () => counts.grasps++);
  bus.on('objects.updated', ({ objects }) => {
    for (const o of objects) {
      const flags = o.locationFlags ?? -1;
      counts.flags.set(flags, (counts.flags.get(flags) ?? 0) + 1);
    }
  });

  const placed = (prop: Prop, position: Vec3, method: PlacedObject['method']): PlacedObject => ({
    id: prop.id,
    label: prop.label,
    position,
    radius: prop.radius,
    method,
  });
  recorder.start(
    {
      schema: EPISODE_SCHEMA_ID,
      mode: 'free',
      procedure: null,
      operator: { role: 'collector' },
      space: {
        frame: 'workspace',
        units: 'm',
        upAxis: '+y',
        worldFromWorkspace: poseToTuple(DESK).map(q4) as Pose7,
        calibration: workspace.method,
        anchored: false,
      },
      hands: HAND_LAYOUT,
      objects: [
        placed(MUG, MUG_START, 'detector'),
        placed(BOTTLE, BOTTLE_AT, 'detector'),
        placed(TAPE, TAPE_AT, 'marker'),
      ],
      coach: { kind: 'none' },
      device: {
        userAgent: 'clio-synth',
        emulated: true,
        xrFeatures: ['local-floor', 'hand-tracking', 'plane-detection'],
      },
      app: { version: 'synthetic' },
      features: [
        EPISODE_FEATURE.objectFlags,
        EPISODE_FEATURE.objectGrasp,
        EPISODE_FEATURE.objectObservations,
        EPISODE_FEATURE.environmentPlanes,
      ],
      camera: {
        intrinsics: CAMERA.intrinsics,
        headFromCamera: poseToTuple(CAMERA.headFromCamera).map(q4) as Pose7,
        source: 'default',
      },
    },
    0,
  );
  tracks.reset();
  environment.reset();
  const stopTracking = standInTracker(workspace, clock, timers).start((s) => tracks.record(s));
  // The right hand pinches the mug's rim and puts the mug down where it lets go.
  const mug = { objectId: MUG.id, hand: 'right' } as const;
  timers.at(MUG_GRASP.from, () => {
    const t = MUG_GRASP.from;
    clock.set(t);
    bus.emit('object.grasped', { t, ...mug, grip: 'pinch', position: mugAt(t) });
  });
  timers.at(MUG_GRASP.to, () => {
    const t = MUG_GRASP.to;
    clock.set(t);
    bus.emit('object.released', { t, ...mug, reason: 'opened', position: mugAt(t) });
  });

  const dt = 1000 / HZ;
  for (let t = 0; t <= TRACKED_END_T; t += dt) {
    // Answers that arrived since the last frame first, each at its own time.
    await timers.run(t);
    clock.set(t);
    recorder.recordFrame({
      t,
      head: trackedHead(t),
      left: sampleTrack(TRACKED_LEFT, t, 'left'),
      right: sampleTrack(TRACKED_RIGHT, t, 'right'),
    });
    environment.update(t, trackedPlanes(t, workspace), workspace);
  }
  stopTracking();
  await recorder.stop('completed', { stepsCompleted: 0, stepsTotal: 0 }, TRACKED_END_T);
  const flags = [...counts.flags].sort(([a], [b]) => a - b).map(([f, n]) => `${f}: ${n}`);
  console.log(
    `wrote ${OUT} (observations: ${counts.observations}, plane snapshots: ${counts.snapshots}, ` +
      `grasp events: ${counts.grasps}, states by flags: ${flags.join(', ')})`,
  );
  // One loss (the bottle), coasting with and without a 3D estimate, the marker's full pose, and
  // the mug's grasp and release.
  const expected = [0, 2, 10, 15].every((f) => counts.flags.has(f));
  if (!expected || counts.flags.get(0) !== 1 || counts.snapshots !== 2 || counts.grasps !== 2)
    process.exitCode = 1;
}

// ---- run ---------------------------------------------------------------------------------------

const SCENARIOS: Record<string, () => Promise<void>> = {
  'shirt-fold': shirtFold,
  'ph-syringe': phSyringe,
  'tracked-objects': trackedObjects,
};
const scenario = SCENARIOS[SCENARIO];
if (!scenario) {
  throw new Error(`Unknown --scenario ${SCENARIO}; use ${Object.keys(SCENARIOS).join(', ')}`);
}
await scenario();

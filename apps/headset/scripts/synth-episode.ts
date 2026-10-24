// Generates a synthetic, realistic episode by driving the real domain code (LessonController,
// ProcedureRunner, pinch and grasp perception, the scripted coach, EpisodeRecorder) with hand
// motion built from the same kinematic hand shapes the ghost hands use. It includes a planted
// mistake (pinching too low) and its correction. Output uses the server's on-disk layout, so the
// Python pipeline can be built and tested before anyone records on a headset.
//
//   pnpm synth                        → fixtures/episodes/synthetic-shirt-fold
//   pnpm synth -- --out /tmp/ep --hz 72

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  type EpisodeBatchInput,
  type EpisodeCreate,
  type EpisodeFinish,
  type Handedness,
  parseProcedure,
} from '@clio/protocol';
import { ScriptedAgent } from '../src/adapters/scripted/scripted-agent';
import { ManualClock } from '../src/core/clock';
import { Emitter } from '../src/core/emitter';
import {
  type Pose,
  type Quat,
  quatFromAxisAngle,
  rotateVec,
  sub,
  type Vec3,
} from '../src/core/math';
import { CoachSession } from '../src/domain/coach/session';
import { CoachToolbox } from '../src/domain/coach/toolbox';
import { DemoLibrary } from '../src/domain/demo/demo-library';
import { gripPoint, type HandShapeId } from '../src/domain/demo/hand-shapes';
import { type Keyframe, sampleTrack } from '../src/domain/demo/keyframes';
import type { AppEvents } from '../src/domain/events';
import { PinchDetector } from '../src/domain/hands/pinch-detector';
import { HANDS, type TrackedFrame } from '../src/domain/hands/types';
import { EpisodeRecorder } from '../src/domain/recording/recorder';
import type { EpisodeSink } from '../src/domain/recording/sink';
import { LessonController } from '../src/domain/session/lesson-controller';
import { GraspTracker } from '../src/domain/world/holding';
import { ObjectRegistry } from '../src/domain/world/object-registry';
import { Workspace } from '../src/domain/world/workspace';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const args = process.argv.slice(2);
const arg = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? fallback) : fallback;
};
const OUT = resolve(arg('out', join(ROOT, 'fixtures', 'episodes', 'synthetic-shirt-fold')));
const HZ = Number(arg('hz', '30'));

/** Writes episodes exactly like the server does (docs/data-format.md). */
class DirectorySink implements EpisodeSink {
  constructor(private readonly dir: string) {}
  async create(meta: EpisodeCreate): Promise<string> {
    const episodeId = 'ep-synthetic-shirt-fold';
    await rm(this.dir, { recursive: true, force: true });
    await mkdir(this.dir, { recursive: true });
    const full = { ...meta, episodeId, createdAt: '2026-10-24T04:00:00.000Z' };
    await writeFile(join(this.dir, 'meta.json'), `${JSON.stringify(full, null, 2)}\n`);
    for (const f of ['frames.ndjson', 'events.ndjson', 'objects.ndjson'])
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

const SHOULDER: Vec3 = [0.14, 0.012, -0.18];
const MIDDLE: Vec3 = [0.4, 0.012, -0.18];
const TOO_LOW: Vec3 = [0.4, 0.012, -0.085];
const HEM: Vec3 = [0.68, 0.012, -0.18];
const up = (p: Vec3, h: number): Vec3 => [p[0], p[1] + h, p[2]];

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

// ---- run the real domain -------------------------------------------------------------------

async function main(): Promise<void> {
  const procedure = parseProcedure(
    JSON.parse(await readFile(join(ROOT, 'procedures', 'shirt-fold.json'), 'utf8')),
  );
  const clock = new ManualClock(0);
  const bus = new Emitter<AppEvents>((err, type) => console.error(`handler ${String(type)}:`, err));
  const registry = new ObjectRegistry(bus);
  const recorder = new EpisodeRecorder({
    bus,
    clock,
    sink: new DirectorySink(OUT),
    sleep: async () => {},
  });
  const workspace = new Workspace({ p: [0, 0, 0], q: [0, 0, 0, 1] }, 'pinch_two_corners');
  const agent = new ScriptedAgent();
  const lesson = new LessonController({
    bus,
    clock,
    planner: { plan: async () => Promise.reject(new Error('not used')) },
    registry,
    workspace: () => workspace,
    grounder: null,
    images: null,
    demos: new DemoLibrary(null),
    recorder,
    context: () => ({
      operator: { role: 'expert' },
      coach: { kind: agent.kind },
      device: { userAgent: 'clio-synth', emulated: true, xrFeatures: ['hand-tracking'] },
      app: { version: 'synthetic' },
    }),
    options: { mode: 'record_demo' },
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

  const dt = 1000 / HZ;
  let confirmedFlat = false;
  let askedForDemo = false;
  for (let t = 0; t <= 12_000; t += dt) {
    clock.set(t);
    const head: Pose = {
      p: [0.38 + 0.01 * Math.sin(t / 900), 0.45, 0.32],
      q: quatFromAxisAngle([1, 0, 0], -0.7),
    };
    const frame: TrackedFrame = {
      t,
      head,
      left: sampleTrack(LEFT, t, 'left'),
      right: sampleTrack(RIGHT, t, 'right'),
    };

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
      grasp.onPinch(tr, frame);
      lesson.onPinch(tr);
    }
    grasp.update(frame);
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

await main();

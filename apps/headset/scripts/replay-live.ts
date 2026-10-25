// Replays a recorded episode directory into a running Clio server as if a headset were recording
// it right now: it creates the episode, posts batches cut like EpisodeRecorder (90 frames or
// 1000 ms) on the recording's own clock, and finishes it. Use it to drive live viewers without a
// headset. Every run adds an episode, so point it only at a server whose CLIO_DATA_DIR is a
// scratch directory.
//
//   CLIO_SERVER_PORT=8788 CLIO_DATA_DIR=/tmp/clio-scratch pnpm --filter @clio/server start
//   pnpm --filter @clio/headset exec tsx scripts/replay-live.ts \
//     --from ../../fixtures/episodes/synthetic-shirt-fold --base http://127.0.0.1:8788
//
// --base             server origin (default http://127.0.0.1:5173, the Vite proxy the headset uses)
// --speed 1          recording ms per wall-clock ms
// --batch-ms 1000    maximum batch age, as the recorder's batchIntervalMs
// --repeat-minutes N play the recording again, later each time, until it lasts at least N minutes
// --stall-after-s S  stop after S s of recording time and never finish, like a headset that lost
//                    its connection
// --no-finish        send every batch but never finish
//
// Samples keep the recording's `t`; `meta.clock.startEpochMs` becomes the replay's start time, and
// `meta.device` marks the episode as a replay (emulated, user agent "clio-replay (...)") so it is
// never mistaken for a new recording. A recording without finish.json is replayed without a finish
// too.

import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  type EpisodeBatch,
  type EpisodeCreate,
  EpisodeCreateSchema,
  type EpisodeEvent,
  EpisodeEventSchema,
  type EpisodeFinish,
  EpisodeFinishSchema,
  type FrameRecord,
  FrameRecordSchema,
  type ObjectObservation,
  ObjectObservationSchema,
  type ObjectTrackRecord,
  ObjectTrackRecordSchema,
} from '@clio/protocol';
import type { z } from 'zod';
import { ApiClient } from '../src/adapters/net/api-client';
import { HttpEpisodeSink } from '../src/adapters/net/http-episode-sink';
import { qTime } from '../src/domain/recording/quantize';
import { EpisodeUploader } from '../src/domain/recording/uploader';

/** One episode directory in the server's layout (docs/data-format.md). */
export interface Recording {
  meta: EpisodeCreate;
  frames: FrameRecord[];
  events: EpisodeEvent[];
  objects: ObjectTrackRecord[];
  /** 2D object observations; empty or absent in episodes without them. */
  observations?: ObjectObservation[];
  /** null when the recording never finished. */
  finish: EpisodeFinish | null;
}

/** EpisodeRecorder's cut rule. */
export interface BatchRule {
  /** Frames per batch (the recorder's default is 90). */
  frames: number;
  /** Maximum batch age in ms (the recorder's default is 1000). */
  ms: number;
}

export interface PlannedBatch {
  /** Recording time (ms) at which the recorder cut this batch, and so when the replay sends it. */
  t: number;
  batch: EpisodeBatch;
}

export interface ReplayOptions {
  from: string;
  base: string;
  speed: number;
  batchMs: number;
  repeatMinutes: number | null;
  stallAfterS: number | null;
  finish: boolean;
}

export const RECORDER_BATCH_FRAMES = 90;

const USAGE =
  'Usage: tsx scripts/replay-live.ts --from <episode dir> [--base http://127.0.0.1:5173] ' +
  '[--speed 1] [--batch-ms 1000] [--repeat-minutes N] [--stall-after-s S] [--no-finish]';
const VALUE_FLAGS = ['from', 'base', 'speed', 'batch-ms', 'repeat-minutes', 'stall-after-s'];

export function parseArgs(argv: readonly string[]): ReplayOptions {
  const values = new Map<string, string>();
  let finish = true;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i] ?? '';
    const name = flag.replace(/^--/, '');
    const value = argv[i + 1];
    if (flag === '--') continue;
    if (flag === '--no-finish') finish = false;
    else if (flag.startsWith('--') && VALUE_FLAGS.includes(name) && value !== undefined) {
      values.set(name, value);
      i++;
    } else throw new Error(`Unknown or incomplete argument "${flag}"\n${USAGE}`);
  }
  const from = values.get('from');
  if (!from) throw new Error(`--from is required\n${USAGE}`);
  const number = (name: string, zeroAllowed = false): number | null => {
    const raw = values.get(name);
    if (raw === undefined) return null;
    const n = Number(raw);
    if (raw.trim() === '' || !Number.isFinite(n) || n < 0 || (n === 0 && !zeroAllowed)) {
      const kind = zeroAllowed ? 'zero or more' : 'above zero';
      throw new Error(`--${name} must be a number ${kind}, got "${raw}"`);
    }
    return n;
  };
  return {
    from,
    base: (values.get('base') ?? 'http://127.0.0.1:5173').replace(/\/+$/, ''),
    speed: number('speed') ?? 1,
    batchMs: number('batch-ms') ?? 1000,
    repeatMinutes: number('repeat-minutes'),
    stallAfterS: number('stall-after-s', true),
    finish,
  };
}

/** Reads an episode directory. Every line is checked against the protocol, so errors name it. */
export async function readRecording(dir: string): Promise<Recording> {
  const metaPath = join(dir, 'meta.json');
  const finishPath = join(dir, 'finish.json');
  const meta = await readText(metaPath);
  if (meta === null) throw new Error(`No meta.json in ${dir}`);
  const finish = await readText(finishPath);
  return {
    meta: parseJson(EpisodeCreateSchema, meta, metaPath),
    frames: await readNdjson(join(dir, 'frames.ndjson'), FrameRecordSchema),
    events: await readNdjson(join(dir, 'events.ndjson'), EpisodeEventSchema),
    objects: await readNdjson(join(dir, 'objects.ndjson'), ObjectTrackRecordSchema),
    observations: await readNdjson(join(dir, 'observations.ndjson'), ObjectObservationSchema),
    finish: finish === null ? null : parseJson(EpisodeFinishSchema, finish, finishPath),
  };
}

/** Recording time between the starts of two repeats: the recording's span plus one frame. */
export function repeatPeriod(recording: Recording): number {
  const end = Math.max(
    lastT(recording.frames),
    lastT(recording.events),
    lastT(recording.objects),
    lastT(recording.observations ?? []),
  );
  return qTime(end + frameStep(recording.frames));
}

/** Whole repeats needed to last at least `minutes` (one when null). */
export function repeatCount(recording: Recording, minutes: number | null): number {
  if (minutes === null) return 1;
  return Math.max(1, Math.ceil((minutes * 60_000) / repeatPeriod(recording)));
}

/**
 * Cuts the recording into batches as EpisodeRecorder did: a batch closes on the frame that makes it
 * `rule.frames` long or `rule.ms` past the previous cut, and carries the events, object updates and
 * observations recorded up to that frame, in file order. What is left forms one last batch, like
 * EpisodeRecorder.stop. Each repeat plays `repeatPeriod` later than the one before it, and seq
 * keeps counting up from 0 across repeats.
 */
export function* planBatches(
  recording: Recording,
  rule: BatchRule,
  repeats = 1,
): Generator<PlannedBatch> {
  const period = repeatPeriod(recording);
  const eventsUpTo = takeUpTo(repeated(recording.events, repeats, period, later));
  const objectsUpTo = takeUpTo(repeated(recording.objects, repeats, period, laterTrack));
  const observationsUpTo = takeUpTo(
    repeated(recording.observations ?? [], repeats, period, laterObservation),
  );
  let seq = 0;
  let frames: FrameRecord[] = [];
  let lastCut = 0;
  for (const frame of repeated(recording.frames, repeats, period, later)) {
    frames.push(frame);
    if (frames.length < rule.frames && frame.t - lastCut < rule.ms) continue;
    const batch = {
      seq: seq++,
      frames,
      events: eventsUpTo(frame.t),
      objects: objectsUpTo(frame.t),
      observations: observationsUpTo(frame.t),
    };
    yield { t: frame.t, batch };
    frames = [];
    lastCut = frame.t;
  }
  const events = eventsUpTo(Number.POSITIVE_INFINITY);
  const objects = objectsUpTo(Number.POSITIVE_INFINITY);
  const observations = observationsUpTo(Number.POSITIVE_INFINITY);
  if (
    frames.length === 0 &&
    events.length === 0 &&
    objects.length === 0 &&
    observations.length === 0
  )
    return;
  const t = Math.max(lastCut, lastT(frames), lastT(events), lastT(objects), lastT(observations));
  yield { t, batch: { seq, frames, events, objects, observations } };
}

/**
 * The recording's meta, started now and marked as a replay: the samples were not measured by this
 * run, so the device is emulated and its user agent names the replay and the original device.
 */
export function replayMeta(meta: EpisodeCreate, startEpochMs: number): EpisodeCreate {
  return {
    ...meta,
    clock: { ...meta.clock, startEpochMs },
    device: { ...meta.device, userAgent: `clio-replay (${meta.device.userAgent})`, emulated: true },
  };
}

/** The recording's finish, stretched over the repeats, counting the batches the replay sent. */
export function replayFinish(
  finish: EpisodeFinish,
  repeats: number,
  period: number,
  batches: number,
): EpisodeFinish {
  return { ...finish, durationMs: qTime(finish.durationMs + (repeats - 1) * period), batches };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const dir = resolve(options.from);
  const recording = await readRecording(dir);
  const repeats = repeatCount(recording, options.repeatMinutes);
  const period = repeatPeriod(recording);
  const finish = options.finish ? recording.finish : null;
  const stallAfterMs = options.stallAfterS === null ? null : options.stallAfterS * 1000;
  console.log(
    `Replaying ${dir} (${recording.frames.length} frames, ${recording.events.length} events, ` +
      `${recording.objects.length} object updates, ` +
      `${recording.observations?.length ?? 0} observations, ${(period / 1000).toFixed(1)} s) ` +
      `${repeats} time(s) at ${options.speed}x to ${options.base}`,
  );

  // The headset's own delivery path, with the episode created up front so a missing server fails
  // at once instead of being retried forever.
  const startEpochMs = Date.now();
  const started = performance.now();
  const meta = replayMeta(recording.meta, startEpochMs);
  const api = new ApiClient(options.base);
  let episodeId: string;
  try {
    episodeId = await api.createEpisode(meta);
  } catch (err) {
    throw new Error(`Could not create the episode at ${options.base}: ${errorMessage(err)}`);
  }
  console.log(`Episode ${episodeId}`);
  const http = new HttpEpisodeSink(api);
  let dropped = 0;
  const uploader = new EpisodeUploader(
    {
      create: async () => episodeId,
      append: (id, batch) => http.append(id, batch),
      putMedia: (id, name, body) => http.putMedia(id, name, body),
      finish: (id, done) => http.finish(id, done),
    },
    meta,
    {
      onDrop: (why) => {
        dropped++;
        console.error(`Dropped ${why}`);
      },
    },
  );

  let sent = 0;
  let stalled = false;
  for (const { t, batch } of planBatches(
    recording,
    { frames: RECORDER_BATCH_FRAMES, ms: options.batchMs },
    repeats,
  )) {
    if (stallAfterMs !== null && t > stallAfterMs) {
      stalled = true;
      break;
    }
    await sleep(Math.max(0, started + t / options.speed - performance.now()));
    if (batch.seq % 10 === 0) {
      const backlog = uploader.queued;
      console.log(`Batch ${batch.seq} at ${(t / 1000).toFixed(1)} s, ${backlog} not yet delivered`);
    }
    uploader.push(batch);
    sent++;
  }

  if (finish && !stalled) {
    await uploader.finish(replayFinish(finish, repeats, period, sent));
    console.log(`Finished ${episodeId} after ${sent} batches`);
  } else {
    // Nothing to await without a finish: wait for the queue to drain.
    while (uploader.queued > 0) await sleep(100);
    const why = stalled
      ? `stalled after ${options.stallAfterS} s`
      : recording.finish
        ? '--no-finish'
        : 'the recording has no finish.json';
    console.log(`Sent ${sent} batches to ${episodeId} without a finish (${why})`);
  }
  if (dropped > 0) process.exitCode = 1;
}

// ---- helpers ---------------------------------------------------------------------------------

const lastT = (records: readonly { t: number }[]) =>
  records.reduce((max, record) => Math.max(max, record.t), 0);

/** The median frame interval, or 1 ms when there are too few frames to measure one. */
function frameStep(frames: readonly FrameRecord[]): number {
  const steps: number[] = [];
  for (let i = 1; i < frames.length; i++) {
    steps.push((frames[i]?.t ?? 0) - (frames[i - 1]?.t ?? 0));
  }
  steps.sort((a, b) => a - b);
  return steps[Math.floor(steps.length / 2)] ?? 1;
}

const later = <T extends { t: number }>(record: T, offset: number): T => ({
  ...record,
  t: qTime(record.t + offset),
});

const laterObservation = (o: ObjectObservation, offset: number): ObjectObservation => ({
  ...o,
  t: qTime(o.t + offset),
  observedT: qTime(o.observedT + offset),
});

const laterTrack = (record: ObjectTrackRecord, offset: number): ObjectTrackRecord => ({
  t: qTime(record.t + offset),
  objects: record.objects.map((o) =>
    o.observedT === undefined ? o : { ...o, observedT: qTime(o.observedT + offset) },
  ),
});

function* repeated<T>(
  records: readonly T[],
  repeats: number,
  period: number,
  shift: (record: T, offset: number) => T,
): Generator<T> {
  for (let k = 0; k < repeats; k++) {
    for (const record of records) yield k === 0 ? record : shift(record, k * period);
  }
}

/** Hands out records in file order up to a time; a record never overtakes an earlier one. */
function takeUpTo<T extends { t: number }>(records: Iterable<T>): (t: number) => T[] {
  const it = records[Symbol.iterator]();
  let next = it.next();
  return (t) => {
    const taken: T[] = [];
    while (!next.done && next.value.t <= t) {
      taken.push(next.value);
      next = it.next();
    }
    return taken;
  };
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function parseJson<T>(schema: z.ZodType<T>, text: string, where: string): T {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`${where}: ${errorMessage(err)}`);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`${where}: ${issue?.path.join('.') ?? ''} ${issue?.message ?? 'invalid'}`);
  }
  return parsed.data;
}

/** A missing file reads as empty: older episodes have no objects.ndjson or observations.ndjson. */
async function readNdjson<T>(path: string, schema: z.ZodType<T>): Promise<T[]> {
  const lines = ((await readText(path)) ?? '').split('\n');
  return lines.flatMap((line, i) =>
    line.trim() ? [parseJson(schema, line, `${path}:${i + 1}`)] : [],
  );
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** True when tsx was asked to run this file, false when a test imports it. */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  await main().catch((err: unknown) => {
    console.error(errorMessage(err));
    process.exitCode = 1;
  });
}

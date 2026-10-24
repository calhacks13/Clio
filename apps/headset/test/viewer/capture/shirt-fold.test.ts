import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EpisodeMetaSchema, type FrameRecord } from '@clio/protocol';
import { describe, expect, it } from 'vitest';
import {
  buildCaptureFromClio,
  type Capture,
  type CaptureEvent,
  ClioCaptureBuilder,
  type ClioEpisode,
  detectionsAt,
  detectionsFor,
  HEADSET,
  headWAt,
  heldAt,
  stepAt,
} from '../../../src/viewer/capture';
import { EpisodeData } from '../../../src/viewer/episode-data';

// The synthetic shirt-fold episode (pnpm synth) read the way the viewer reads a recording.

const DIR = join(import.meta.dirname, '../../../../../fixtures/episodes/synthetic-shirt-fold');
const read = (name: string) => readFileSync(join(DIR, name), 'utf8');
const lines = (name: string): unknown[] =>
  read(name)
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));

const meta = JSON.parse(read('meta.json'));
const episode: ClioEpisode = {
  meta,
  frames: lines('frames.ndjson'),
  events: lines('events.ndjson'),
  objects: lines('objects.ndjson'),
  finish: JSON.parse(read('finish.json')),
};
const frames = episode.frames as FrameRecord[];

/** Every frame time, every event time and just before it, in microseconds. */
function times(capture: Capture): number[] {
  const all = new Set<number>();
  for (const s of capture.poses.get(HEADSET)?.samples ?? []) all.add(s.t_us);
  for (const e of capture.events.samples) all.add(e.t_us).add(e.t_us - 1);
  return [...all].sort((a, b) => a - b);
}

/** heldAt as it was before held spans: every grasp and release up to t, replayed in order. */
function replayHeld(capture: Capture, t: number): Map<string, string> {
  const held = new Map<string, string>();
  const isHand = (id: string) => capture.entities.get(id)?.role === 'hand';
  for (const e of capture.events.samples.slice(0, capture.events.indexAt(t) + 1)) {
    if (e.event !== 'grasp' && e.event !== 'release') continue;
    const hand = e.entity_ids.find(isHand) ?? null;
    const objects = e.entity_ids.filter((id) => !isHand(id));
    if (e.event === 'grasp') {
      if (hand) for (const id of objects) held.set(id, hand);
    } else if (objects.length > 0) {
      for (const id of objects) held.delete(id);
    } else {
      for (const [id, by] of held) if (by === hand) held.delete(id);
    }
  }
  return held;
}

const grasps = (capture: Capture) =>
  capture.events.samples.filter((e: CaptureEvent) => e.event === 'grasp');

describe('shirt-fold as a Capture', () => {
  const capture = buildCaptureFromClio(episode);

  it('has every frame, both hands and every placed object; the mistake zone is hidden', () => {
    expect(capture.poses.get(HEADSET)?.samples).toHaveLength(337);
    expect(capture.hands.left.samples).toHaveLength(337);
    expect(capture.hands.right.samples).toHaveLength(337);
    for (const id of ['shoulder', 'middle', 'hem']) {
      expect(capture.entities.get(id)).toMatchObject({
        motion: 'static',
        extensions: { kind: 'point', hidden: false },
      });
    }
    expect(capture.entities.get('middle_low_zone')).toMatchObject({
      motion: 'static',
      extensions: { kind: 'region', hidden: true, radius_m: 0.06 },
    });
    // objects.ndjson restates the placements at t = 0.
    expect(capture.poses.get('shoulder')?.samples).toHaveLength(1);
  });

  it('keeps each hand pinch distance', () => {
    frames.forEach((f, i) => {
      expect(capture.hands.left.samples[i]?.pinch_m).toBe(f.left?.pinch ?? null);
      expect(capture.hands.right.samples[i]?.pinch_m).toBe(f.right?.pinch ?? null);
    });
    expect(frames.some((f) => f.left !== null)).toBe(true);
  });

  it('gives the frame head back in W', () => {
    for (const f of frames) {
      const t = Math.round(f.t * 1000);
      expect(headWAt(capture, t)?.map((v) => v + 0)).toEqual(f.head);
      expect(headWAt(capture, t + 1)?.map((v) => v + 0)).toEqual(f.head);
    }
    expect(headWAt(capture, -1)).toBeNull();
  });

  it('runs the same steps as the episode data, and has no finder answers', () => {
    const data = new EpisodeData(EpisodeMetaSchema.parse(meta));
    data.addEvents(episode.events);
    const steps = times(capture).map((t) => stepAt(capture, t)?.stepId ?? null);
    expect(steps).toEqual(times(capture).map((t) => data.stepAt(t / 1000)?.stepId ?? null));
    expect(new Set(steps)).toEqual(
      new Set([
        null,
        'lay-flat',
        'pinch-shoulder',
        'pinch-middle',
        'cross-to-hem',
        'lift-and-fold',
      ]),
    );
    expect(stepAt(capture, 2_800_000)?.instruction).toBe(
      'Keep holding. With your right hand, pinch the middle dot.',
    );
    for (const id of capture.entities.keys()) expect(detectionsFor(capture, id)).toEqual([]);
    expect(detectionsAt(capture, capture.endUs)).toEqual([]);
  });

  it('never grasps its dots, which are points', () => {
    expect(grasps(capture)).toEqual([]);
    for (const t of times(capture)) expect(heldAt(capture, t)).toEqual(new Map());
  });

  it('holds what the old grasp replay held, once its dots are movable', () => {
    const movable = structuredClone(meta);
    for (const o of movable.plan.objects) if (o.kind === 'point') o.kind = 'item';
    // The headset recorded no grasps of its points, so infer them, as for an older episode.
    delete movable.features;
    const capture = buildCaptureFromClio({ ...episode, meta: movable });
    // Left pinches the shoulder at 2.8 s; right misses the middle at 4.3 s, then gets it at 6.3 s.
    expect(grasps(capture).map((e) => [e.t_us, e.entity_ids])).toEqual([
      [2_800_000, ['left_hand', 'shoulder']],
      [6_300_000, ['right_hand', 'middle']],
    ]);
    expect(heldAt(capture, 7_000_000)).toEqual(
      new Map([
        ['shoulder', 'left_hand'],
        ['middle', 'right_hand'],
      ]),
    );
    for (const t of times(capture)) expect(heldAt(capture, t)).toEqual(replayHeld(capture, t));
  });

  it('changes no counts when the whole episode arrives twice', () => {
    const builder = new ClioCaptureBuilder(meta);
    const feed = () => {
      builder.addFrames(episode.frames);
      builder.addEvents(episode.events);
      builder.addObjects(episode.objects);
    };
    const counts = () => [
      builder.capture.events.samples.length,
      builder.capture.hands.left.samples.length,
      builder.capture.hands.right.samples.length,
      ...[...builder.capture.poses.values()].map((s) => s.samples.length),
    ];
    feed();
    const once = counts();
    expect(builder.duplicates).toBe(0);
    feed();
    expect(counts()).toEqual(once);
    expect(builder.duplicates).toBe(337 + 35 + 4);
    expect(builder.rejected).toBe(0);
  });
});

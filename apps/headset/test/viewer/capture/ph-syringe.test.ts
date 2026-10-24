import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildCaptureFromClio,
  ClioCaptureBuilder,
  type ClioEpisode,
  entityAt,
  GRIP_SOURCE,
  heldSpanAt,
  validSpans,
} from '../../../src/viewer/capture';

// The synthetic ph-syringe episode, which records grasps, releases and location flags
// (meta.features 'object.grasp' and 'object.flags'): the syringe is carried, the hand drops out
// for 300 ms, and the finder places it again after the release.

const DIR = join(import.meta.dirname, '../../../../../fixtures/episodes/synthetic-ph-syringe');
const read = (name: string) => readFileSync(join(DIR, name), 'utf8');
const lines = (name: string): unknown[] =>
  read(name)
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));

const episode: ClioEpisode = {
  meta: JSON.parse(read('meta.json')),
  frames: lines('frames.ndjson'),
  events: lines('events.ndjson'),
  objects: lines('objects.ndjson'),
  finish: JSON.parse(read('finish.json')),
};

describe('ph-syringe as a Capture', () => {
  const capture = buildCaptureFromClio(episode);
  const syringe = capture.poses.get('syringe');
  if (!syringe) throw new Error('no syringe track');

  it('takes held spans from the recorded grasps and releases, inferring none', () => {
    expect(
      capture.heldSpans('syringe').map((s) => [s.startUs, s.endUs, s.hand, s.grip, s.origin]),
    ).toEqual([
      // The first ends when the hand is lost, the second when it opens.
      [2_400_000, 5_600_000, 'right', 'pinch', 'runtime'],
      [5_766_670, 12_166_670, 'right', 'pinch', 'runtime'],
    ]);
    expect(capture.heldEntityIds()).toEqual(['syringe']);
    const graspEvents = capture.events.samples.filter(
      (e) => e.event === 'grasp' || e.event === 'release',
    );
    expect(
      graspEvents.map((e) => [e.t_us, e.event, e.origin, e.details.grip ?? e.details.reason]),
    ).toEqual([
      [2_400_000, 'grasp', 'runtime', 'pinch'],
      [5_600_000, 'release', 'runtime', 'hand_lost'],
      [5_766_670, 'grasp', 'runtime', 'pinch'],
      [12_166_670, 'release', 'runtime', 'opened'],
    ]);
    expect(capture.events.samples.some((e) => e.origin === 'inferred')).toBe(false);
  });

  it('shows the dropout as a gap with no valid position', () => {
    expect(validSpans(syringe, capture.endUs)).toEqual([
      [0, 5_466_670],
      [5_600_000, capture.endUs],
    ]);
    expect(entityAt(syringe, 5_500_000)).toMatchObject({
      lost: true,
      // Still drawn where it was last carried.
      position: entityAt(syringe, 5_433_330)?.position,
    });
    expect(entityAt(syringe, 5_433_330)?.lost).toBe(false);
    expect(entityAt(syringe, 5_600_000)?.lost).toBe(false);
    // Lost while held: the hand carrying it, not a measurement.
    expect(syringe.at(5_500_000)).toMatchObject({
      source_id: GRIP_SOURCE,
      estimate_type: 'runtime_estimate',
      location: { location_flags: 0, rotation: null },
    });
    const tracking = capture.events.samples.filter(
      (e) => e.event === 'tracking_lost' || e.event === 'tracking_recovered',
    );
    expect(tracking.map((e) => [e.t_us, e.event, e.entity_ids, e.origin])).toEqual([
      [5_466_670, 'tracking_lost', ['syringe'], 'runtime'],
      [5_600_000, 'tracking_recovered', ['syringe'], 'runtime'],
    ]);
  });

  it('types the carried estimates by heldBy and keeps the release estimates in the carry', () => {
    for (const s of syringe.samples) {
      const held = heldSpanAt(capture, 'syringe', s.t_us);
      if (held) expect(s.source_id, `${s.t_us}`).toBe(GRIP_SOURCE);
    }
    expect(syringe.at(5_600_000)?.source_id).toBe(GRIP_SOURCE);
    expect(syringe.at(12_166_670)?.source_id).toBe(GRIP_SOURCE);
  });

  it('places the finder answer at its camera frame time', () => {
    // Recorded at 14266.67 ms with observedT 12766.67.
    const answer = syringe.at(13_000_000);
    expect(answer).toMatchObject({
      t_us: 12_766_670,
      source_id: 'clio-detector',
      estimate_type: 'vision_estimate',
      confidence: 0.74,
    });
    expect(syringe.samples.at(-1)).toBe(answer);
  });

  it('changes no counts when the whole episode arrives twice', () => {
    const builder = new ClioCaptureBuilder(episode.meta);
    const feed = () => {
      builder.addFrames(episode.frames);
      builder.addEvents(episode.events);
      builder.addObjects(episode.objects);
    };
    const counts = () => [
      builder.capture.events.samples.length,
      builder.capture.heldSpans('syringe').length,
      ...[...builder.capture.poses.values()].map((s) => s.samples.length),
    ];
    feed();
    const once = counts();
    expect(builder.duplicates).toBe(0);
    expect(builder.rejected).toBe(0);
    feed();
    expect(counts()).toEqual(once);
    // Object states are counted one by one; the line at t = 0 holds every placement.
    const states = (episode.objects as { objects: unknown[] }[]).flatMap((r) => r.objects);
    expect(builder.duplicates).toBe(episode.frames.length + episode.events.length + states.length);
  });
});

import { type EpisodeEvent, type EpisodeMeta, HAND_LAYOUT } from '@clio/protocol';
import { describe, expect, it } from 'vitest';
import {
  ClioCaptureBuilder,
  clioEvents,
  type Detection,
  detectionsAt,
  detectionsFor,
  headWAt,
  stepAt,
} from '../../../src/viewer/capture';

const META: EpisodeMeta = {
  schema: 'clio.episode/1',
  episodeId: 'ep-20261024-031502-abcz',
  createdAt: '2026-10-24T03:15:02.123Z',
  mode: 'learn',
  procedure: null,
  operator: { role: 'learner' },
  clock: { timeline: 'performance.now', startEpochMs: 0 },
  space: {
    frame: 'workspace',
    units: 'm',
    upAxis: '+y',
    worldFromWorkspace: [0, 0, 0, 0, 0, 0, 1],
    calibration: 'none',
    anchored: false,
  },
  hands: HAND_LAYOUT,
  objects: [],
  coach: { kind: 'none' },
  device: { userAgent: 'vitest', emulated: false, xrFeatures: [] },
  app: { version: '0.1.0' },
};

const step = (t: number, index: number): EpisodeEvent => ({
  t,
  type: 'step.entered',
  stepId: `s${index}`,
  index,
  instruction: `Do step ${index + 1}.`,
  targets: [],
});

const answer = (
  t: number,
  objectId: string,
  found: boolean,
  latencyMs: number,
  source = 'gemini',
): Detection => ({
  t,
  type: 'object.detected',
  objectId,
  stepId: null,
  phrase: null,
  description: objectId,
  found,
  point: found ? [0.5, 0.5] : null,
  box: null,
  outline: null,
  confidence: found ? 0.8 : 0,
  position: found ? [0.1, 0, -0.2] : null,
  source,
  latencyMs,
});

describe('Clio event lookups', () => {
  it('finds the step running at a time', () => {
    const builder = new ClioCaptureBuilder(META);
    builder.addEvents([step(1000, 0), step(2500, 1)]);
    const { capture } = builder;
    expect(stepAt(capture, 999_999)).toBeNull();
    expect(stepAt(capture, 1_000_000)?.stepId).toBe('s0');
    expect(stepAt(capture, 2_499_999)?.stepId).toBe('s0');
    expect(stepAt(capture, 9_000_000)?.instruction).toBe('Do step 2.');
    // Seeking back works the same.
    expect(stepAt(capture, 1_500_000)?.stepId).toBe('s0');
  });

  it('places each finder answer from its camera frame to its arrival, misses included', () => {
    const builder = new ClioCaptureBuilder(META);
    builder.addEvents([
      answer(1200, 'cup', true, 900),
      answer(3000, 'cup', false, 1500, 'jev'),
      answer(4000, 'lid', true, 4500),
    ]);
    const { capture } = builder;
    const cup = detectionsFor(capture, 'cup');
    expect(cup.map((m) => [m.availableUs, m.observedUs, m.found, m.confidence, m.source])).toEqual([
      [1_200_000, 300_000, true, 0.8, 'gemini'],
      [3_000_000, 1_500_000, false, 0, 'jev'],
    ]);
    expect(cup[0]?.detection.position).toEqual([0.1, 0, -0.2]);
    const markers = capture.events.samples.filter((e) => e.event === 'marker');
    expect(cup.map((m) => m.eventSequence)).toEqual(markers.slice(0, 2).map((e) => e.sequence));
    // The camera frame can be older than the episode.
    expect(detectionsFor(capture, 'lid')[0]?.observedUs).toBe(-500_000);
    expect(detectionsFor(capture, 'jug')).toEqual([]);

    expect(detectionsAt(capture, 1_000_000)).toEqual([]);
    expect(detectionsAt(capture, 2_000_000).map((m) => [m.objectId, m.found])).toEqual([
      ['cup', true],
    ]);
    expect(detectionsAt(capture, 5_000_000).map((m) => [m.objectId, m.found])).toEqual([
      ['cup', false],
      ['lid', true],
    ]);
  });

  it('keeps up as events stream in, including one that arrives out of order', () => {
    const builder = new ClioCaptureBuilder(META);
    builder.addEvents([step(1000, 0)]);
    const { capture } = builder;
    expect(stepAt(capture, 5_000_000)?.stepId).toBe('s0');
    builder.addEvents([step(4000, 2), answer(4500, 'cup', true, 100)]);
    expect(stepAt(capture, 5_000_000)?.stepId).toBe('s2');
    builder.addEvents([step(2000, 1)]);
    expect(stepAt(capture, 3_000_000)?.stepId).toBe('s1');
    expect(clioEvents(capture).map((e) => e.t)).toEqual([1000, 2000, 4000, 4500]);
    expect(detectionsFor(capture, 'cup')).toHaveLength(1);
  });

  it('has no head pose before the first frame', () => {
    const builder = new ClioCaptureBuilder(META);
    expect(headWAt(builder.capture, 0)).toBeNull();
  });
});

import {
  type EpisodeEvent,
  type EpisodeMeta,
  type FrameRecord,
  HAND_LAYOUT,
  type ObjectTrackRecord,
} from '@clio/protocol';
import { describe, expect, it } from 'vitest';
import {
  buildCaptureFromClio,
  ClioCaptureBuilder,
  entityAt,
  HAND_ENTITY,
  HEADSET,
  handAt,
  heldAt,
  ORIENTATION_TRACKED,
  ORIENTATION_VALID,
  POSITION_TRACKED,
  POSITION_VALID,
  rosFromW,
  rosQuatFromW,
  WORKSPACE,
} from '../../../src/viewer/capture';

function meta(overrides: Partial<EpisodeMeta> = {}): EpisodeMeta {
  return {
    schema: 'clio.episode/1',
    episodeId: 'ep-20261024-031502-abcz',
    createdAt: '2026-10-24T03:15:02.123Z',
    mode: 'learn',
    procedure: { id: 'shirt-fold', version: 1, title: 'Fold a T-shirt in two seconds' },
    operator: { role: 'learner' },
    clock: { timeline: 'performance.now', startEpochMs: 1_792_811_702_000 },
    space: {
      frame: 'workspace',
      units: 'm',
      upAxis: '+y',
      worldFromWorkspace: [0, 0.75, -0.4, 0, 0, 0, 1],
      calibration: 'pinch_two_corners',
      anchored: false,
    },
    hands: { joints: [...HAND_LAYOUT.joints], jointFields: [...HAND_LAYOUT.jointFields] },
    objects: [
      {
        id: 'shoulder',
        label: 'shoulder dot',
        position: [0.14, 0, -0.18],
        radius: 0.025,
        method: 'layout',
      },
    ],
    coach: { kind: 'scripted' },
    device: { userAgent: 'vitest', emulated: false, xrFeatures: ['hand-tracking'] },
    app: { version: '0.1.0' },
    ...overrides,
  };
}

/** A hand whose joint i sits at (i, 2i, 3i) cm in W, with radius 1 cm. */
function hand(): { joints: number[]; pinch: number } {
  const joints: number[] = [];
  for (let i = 0; i < 25; i++) joints.push(i / 100, (2 * i) / 100, (3 * i) / 100, 0, 0, 0, 1, 0.01);
  return { joints, pinch: 0.03 };
}

function frame(t: number, withRight = false): FrameRecord {
  return { t, head: [0.3, 0.45, 0.45, 0, 0, 0, 1], left: hand(), right: withRight ? hand() : null };
}

const pinch = (
  t: number,
  phase: 'start' | 'end',
  distance: number | null,
  which: 'left' | 'right' = 'left',
): EpisodeEvent => ({
  t,
  type: 'hand.pinch',
  hand: which,
  phase,
  point: [0.14, 0.01, -0.18],
  nearest: distance === null ? null : { objectId: 'shoulder', distance },
});

describe('change of basis', () => {
  it('maps W (y up, z toward the user) to ROS (x forward, y left, z up)', () => {
    expect(rosFromW([1, 2, 3])).toEqual([-3, -1, 2]);
    // A quarter turn to the left about W's +y is a quarter turn about ROS's +z.
    const s = Math.SQRT1_2;
    expect(rosQuatFromW([0, s, 0, s])).toEqual([-0, -0, s, s]);
  });
});

describe('buildCaptureFromClio', () => {
  it('declares the headset, both hands, the workspace and the placed objects', () => {
    const capture = buildCaptureFromClio({ meta: meta(), frames: [], events: [], objects: [] });
    expect(capture.task).toBe('Fold a T-shirt in two seconds');
    expect([...capture.entities.keys()]).toEqual([
      HEADSET,
      'left_hand',
      'right_hand',
      WORKSPACE,
      'shoulder',
    ]);
    // Default 0.6 x 0.4 m table: x 0..0.4 forward, y -0.6..0 to the right, top face at z = 0.
    expect(capture.entities.get(WORKSPACE)).toMatchObject({
      role: 'environment',
      motion: 'static',
      geometry: { type: 'box', size: [0.4, 0.6, 0.01] },
      pose: { translation: [0.2, -0.3, -0.005] },
    });
    expect(capture.entities.get('shoulder')).toMatchObject({
      name: 'shoulder dot',
      role: 'object',
      motion: 'tracked',
      extensions: { radius_m: 0.025 },
    });
    expect(capture.poses.get('shoulder')?.samples).toEqual([
      expect.objectContaining({
        t_us: 0,
        estimate_type: 'manual',
        location: { translation: [0.18, -0.14, 0], rotation: null, location_flags: POSITION_VALID },
        confidence: null,
      }),
    ]);
  });

  it('turns frames into the headset series and 26-joint hand samples', () => {
    const capture = buildCaptureFromClio({
      meta: meta(),
      frames: [frame(12.5), frame(24.25, true)],
      events: [],
      objects: [],
    });
    const head = capture.poses.get(HEADSET)?.samples;
    expect(head?.map((s) => s.t_us)).toEqual([12_500, 24_250]);
    expect(head?.[0]?.location).toEqual({
      translation: [-0.45, -0.3, 0.45],
      rotation: [-0, -0, 0, 1],
      location_flags: ORIENTATION_VALID | POSITION_VALID,
    });
    expect(head?.[0]?.estimate_type).toBe('runtime_estimate');

    const left = handAt(capture, 'left', 12_500);
    expect(left?.entity_id).toBe(HAND_ENTITY.left);
    // OpenXR joint 0 is the palm, which WebXR does not report.
    expect(left?.flags[0]).toBe(0);
    expect(Number.isNaN(left?.positions[0])).toBe(true);
    // OpenXR joint 1 is WebXR's wrist (joint 0); joint 25 is WebXR's pinky tip (joint 24).
    expect(left?.flags[1]).toBe(ORIENTATION_VALID | POSITION_VALID);
    expect([...(left?.positions.slice(3, 6) ?? [])]).toEqual([-0, -0, 0]);
    expect([...(left?.positions.slice(75, 78) ?? [])].map((v) => +v.toFixed(4))).toEqual([
      -0.72, -0.24, 0.48,
    ]);
    expect(left?.radii[25]).toBeCloseTo(0.01);
    expect(handAt(capture, 'right', 12_500)).toBeNull();
    expect(capture.hands.right.samples[0]?.active).toBe(false);
    expect(handAt(capture, 'right', 30_000)?.active).toBe(true);
  });

  it('marks emulated hands and head as synthetic', () => {
    const capture = buildCaptureFromClio({
      meta: meta({ device: { userAgent: 'x', emulated: true, xrFeatures: [] } }),
      frames: [frame(0)],
      events: [],
      objects: [],
    });
    expect(capture.hands.left.samples[0]?.estimate_type).toBe('synthetic');
  });

  it('maps object estimates to validity flags by how they were measured', () => {
    const objects: ObjectTrackRecord[] = [
      {
        t: 100,
        objects: [
          {
            id: 'shoulder',
            position: [0.2, 0, -0.2],
            orientation: null,
            confidence: 0.8,
            source: 'detector',
          },
        ],
      },
      {
        t: 200,
        objects: [
          {
            id: 'syringe',
            position: [0.3, 0.05, -0.1],
            orientation: [0, 0, 0, 1],
            confidence: 0.95,
            source: 'marker',
          },
        ],
      },
    ];
    const capture = buildCaptureFromClio({ meta: meta(), frames: [], events: [], objects });
    expect(capture.poses.get('shoulder')?.samples[1]).toMatchObject({
      t_us: 100_000,
      estimate_type: 'vision_estimate',
      source_id: 'clio-detector',
      location: { location_flags: POSITION_VALID | POSITION_TRACKED },
      confidence: 0.8,
    });
    // An object first seen mid-episode becomes a tracked entity then.
    expect(capture.entities.get('syringe')).toMatchObject({ name: 'syringe', role: 'object' });
    expect(capture.poses.get('syringe')?.samples[0]?.location).toEqual({
      translation: [0.1, -0.3, 0.05],
      rotation: [-0, -0, 0, 1],
      location_flags: POSITION_VALID | POSITION_TRACKED | ORIENTATION_VALID | ORIENTATION_TRACKED,
    });
  });

  it('keeps every event as a marker and infers grasp and release from pinches', () => {
    const step: EpisodeEvent = {
      t: 1,
      type: 'step.entered',
      stepId: 'pinch-shoulder',
      index: 1,
      instruction: 'Pinch the shoulder dot.',
      targets: ['shoulder'],
    };
    const capture = buildCaptureFromClio({
      meta: meta(),
      frames: [],
      events: [step, pinch(10, 'start', 0.05), pinch(20, 'end', 0.05), pinch(30, 'start', 0.2)],
      objects: [],
    });
    const events = capture.events.samples;
    expect(events.map((e) => [e.t_us, e.event, e.entity_ids])).toEqual([
      [1_000, 'marker', ['shoulder']],
      [10_000, 'marker', ['left_hand']],
      [10_000, 'grasp', ['left_hand', 'shoulder']],
      [20_000, 'marker', ['left_hand']],
      [20_000, 'release', ['left_hand', 'shoulder']],
      // 0.2 m is beyond the dot's radius plus pinch reach: no grasp.
      [30_000, 'marker', ['left_hand']],
    ]);
    expect(events[0]?.details).toEqual({ clio: step });
    expect(events[2]?.origin).toBe('inferred');
    expect(heldAt(capture, 15_000)).toEqual(new Map([['shoulder', 'left_hand']]));
    expect(heldAt(capture, 25_000)).toEqual(new Map());
  });

  it('skips lines that do not match the protocol', () => {
    const builder = new ClioCaptureBuilder(meta());
    builder.addFrames([{ t: 1 }, frame(2)]);
    builder.addEvents([{ t: 1, type: 'party' }]);
    builder.addObjects([{ t: 'soon' }]);
    expect(builder.rejected).toBe(3);
    expect(builder.capture.poses.get(HEADSET)?.samples).toHaveLength(1);
  });
});

describe('ClioCaptureBuilder', () => {
  it('grows as a live episode streams in, matching a build of the whole episode', () => {
    const frames = [frame(0), frame(10), frame(20), frame(30)];
    const events = [pinch(5, 'start', 0.01), pinch(25, 'end', 0.01)];
    const whole = buildCaptureFromClio({
      meta: meta(),
      frames,
      events,
      objects: [],
      finish: { durationMs: 40 },
    });

    const live = new ClioCaptureBuilder(meta());
    live.addFrames(frames.slice(0, 2));
    live.addEvents(events.slice(0, 1));
    expect(live.capture.endUs).toBe(10_000);
    expect(live.capture.durationUs).toBeNull();
    // A late batch: lines can arrive out of time order.
    live.addFrames([frames[3], frames[2]]);
    live.addEvents(events.slice(1));
    live.finish({ durationMs: 40 });

    expect(live.capture.poses.get(HEADSET)?.samples.map((s) => s.t_us)).toEqual([
      0, 10_000, 20_000, 30_000,
    ]);
    expect(live.capture.endUs).toBe(40_000);
    expect(live.capture.events.samples.map((e) => e.event)).toEqual(
      whole.events.samples.map((e) => e.event),
    );
    const shoulder = live.capture.poses.get('shoulder');
    expect(shoulder && entityAt(shoulder, 1)).toMatchObject({ position: [0.18, -0.14, 0] });
  });
});

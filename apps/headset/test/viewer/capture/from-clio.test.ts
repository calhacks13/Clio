import {
  type EpisodeEvent,
  type EpisodeMeta,
  type FrameRecord,
  HAND_LAYOUT,
  type ObjectState,
  type ObjectTrackRecord,
  type Procedure,
} from '@clio/protocol';
import { describe, expect, it } from 'vitest';
import {
  buildCaptureFromClio,
  type Capture,
  ClioCaptureBuilder,
  entityAt,
  GRIP_SOURCE,
  HAND_ENTITY,
  HEADSET,
  handAt,
  heldAt,
  heldSpanAt,
  ORIENTATION_TRACKED,
  ORIENTATION_VALID,
  POSITION_TRACKED,
  POSITION_VALID,
  rosFromW,
  rosQuatFromW,
  WORKSPACE,
  wFromRos,
  wQuatFromRos,
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

  it('maps ROS back to W exactly', () => {
    expect(wFromRos([-3, -1, 2])).toEqual([1, 2, 3]);
    const points = [
      [0.12, -0.5, 1.75],
      [-2, 0.25, 0.003],
    ];
    for (const p of points) {
      expect(wFromRos(rosFromW(p))).toEqual(p);
      expect(rosFromW(wFromRos(p))).toEqual(p);
    }
    // A rotation about every axis survives the round trip, and still rotates the same way.
    const h = Math.sin(0.35);
    const q = [0.3 * h, -0.8 * h, Math.sqrt(1 - 0.73) * h, Math.cos(0.35)];
    expect(wQuatFromRos(rosQuatFromW(q))).toEqual(q);
    expect(rosQuatFromW(wQuatFromRos(q))).toEqual(q);
    const v = [0.2, -0.4, 0.9];
    expect(rotate(rosQuatFromW(q), rosFromW(v)).map(round)).toEqual(
      rosFromW(rotate(q, v)).map(round),
    );
  });
});

/** Rotates v by the unit quaternion q ([x, y, z, w]). */
function rotate(q: readonly number[], v: readonly number[]): number[] {
  const [x, y, z, w] = q as [number, number, number, number];
  const [a, b, c] = v as [number, number, number];
  // t = 2 (q.xyz × v); v' = v + w t + q.xyz × t
  const t = [2 * (y * c - z * b), 2 * (z * a - x * c), 2 * (x * b - y * a)] as const;
  return [
    a + w * t[0] + (y * t[2] - z * t[1]),
    b + w * t[1] + (z * t[0] - x * t[2]),
    c + w * t[2] + (x * t[1] - y * t[0]),
  ];
}

const round = (v: number) => Math.round(v * 1e9) / 1e9 + 0;

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
    // OpenXR joint 1 is WebXR's wrist (joint 0); joint 25 is WebXR's pinky tip (joint 24). Joint
    // orientations are not kept, so only the position is valid.
    expect(left?.flags[1]).toBe(POSITION_VALID);
    expect(left?.flags[25]).toBe(POSITION_VALID);
    expect(left?.pinch_m).toBe(0.03);
    expect([...(left?.positions.slice(3, 6) ?? [])]).toEqual([-0, -0, 0]);
    expect([...(left?.positions.slice(75, 78) ?? [])].map((v) => +v.toFixed(4))).toEqual([
      -0.72, -0.24, 0.48,
    ]);
    expect(left?.radii[25]).toBeCloseTo(0.01);
    expect(handAt(capture, 'right', 12_500)).toBeNull();
    expect(capture.hands.right.samples[0]?.active).toBe(false);
    expect(capture.hands.right.samples[0]?.pinch_m).toBeNull();
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
    live.addFrames(frames.slice(2));
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

type Kind = Procedure['objects'][number]['kind'];

/** Meta whose plan declares these objects, each placed by layout at the start. */
function planned(objects: { id: string; kind: Kind; hidden?: boolean; radius?: number }[]) {
  const position: [number, number, number] = [0.1, 0, -0.1];
  return meta({
    objects: objects.map((o) => ({
      id: o.id,
      label: o.id,
      position,
      radius: o.radius ?? 0.02,
      method: 'layout' as const,
    })),
    plan: {
      schema: 'clio.procedure/1',
      id: 'test',
      version: 1,
      origin: { kind: 'curated' },
      title: 'Test',
      summary: 'A test plan.',
      workspace: { size: [0.6, 0.4] },
      objects: objects.map((o) => ({
        id: o.id,
        label: o.id,
        kind: o.kind,
        radius: o.radius ?? 0.02,
        hidden: o.hidden ?? false,
        placement: { method: 'layout', position },
      })),
      steps: [
        {
          id: 'go',
          instruction: 'Go.',
          targets: [],
          hand: 'either',
          show: [],
          success: { type: 'confirm', by: 'either', prompt: 'Done' },
          mistakes: [],
        },
      ],
      coach: {},
    },
  });
}

const state = (
  id: string,
  source: ObjectState['source'],
  confidence = 1,
  position: [number, number, number] = [0.1, 0.05, -0.1],
): ObjectState => ({ id, position, orientation: null, confidence, source });

/** One objects line per time, all for one object. */
const track = (id: string, source: ObjectState['source'], times: number[], confidence = 1) =>
  times.map((t): ObjectTrackRecord => ({ t, objects: [state(id, source, confidence)] }));

/** Every 11 ms (90 Hz) from `from` to `to`, both included. */
const frameTimes = (from: number, to: number) => {
  const times: number[] = [];
  for (let t = from; t < to; t += 11) times.push(t);
  return [...times, to];
};

const pinchAt = (
  t: number,
  phase: 'start' | 'end',
  objectId: string,
  which: 'left' | 'right' = 'right',
): EpisodeEvent => ({
  t,
  type: 'hand.pinch',
  hand: which,
  phase,
  point: [0.1, 0.05, -0.1],
  nearest: { objectId, distance: 0.01 },
});

const typesOf = (capture: Capture, id: string) =>
  capture.poses.get(id)?.samples.map((s) => [s.t_us / 1000, s.estimate_type, s.source_id]);

describe('ClioCaptureBuilder objects', () => {
  it('keeps the plan kind, hides hidden objects, and never grasps points, regions or hidden ones', () => {
    const builder = new ClioCaptureBuilder(
      planned([
        { id: 'syringe', kind: 'tool' },
        { id: 'dot', kind: 'point' },
        { id: 'zone', kind: 'region', hidden: true },
        { id: 'lid', kind: 'item', hidden: true },
      ]),
    );
    const { capture } = builder;
    expect(capture.entities.get('syringe')).toMatchObject({
      motion: 'tracked',
      extensions: { radius_m: 0.02, kind: 'tool', hidden: false },
    });
    expect(capture.entities.get('dot')).toMatchObject({
      motion: 'static',
      extensions: { kind: 'point', hidden: false },
    });
    expect(capture.entities.get('zone')).toMatchObject({
      motion: 'static',
      extensions: { kind: 'region', hidden: true },
    });
    expect(capture.entities.get('lid')).toMatchObject({
      motion: 'tracked',
      extensions: { kind: 'item', hidden: true },
    });

    builder.addEvents(
      ['dot', 'zone', 'lid'].flatMap((id, i) => [
        pinchAt(100 * i + 10, 'start', id),
        pinchAt(100 * i + 50, 'end', id),
      ]),
    );
    // Frame-rate `pinch` runs on them make no carry either.
    builder.addObjects(['dot', 'zone', 'lid'].flatMap((id) => track(id, 'pinch', [400, 411, 422])));
    builder.addEvents([pinchAt(500, 'start', 'syringe'), pinchAt(600, 'end', 'syringe')]);
    for (const id of ['dot', 'zone', 'lid']) expect(capture.heldSpans(id)).toEqual([]);
    expect(capture.events.samples.filter((e) => e.event === 'grasp')).toHaveLength(1);
    expect(capture.heldSpans('syringe')).toEqual([
      {
        entityId: 'syringe',
        hand: 'right',
        startUs: 500_000,
        endUs: 600_000,
        origin: 'inferred',
        grip: 'pinch',
      },
    ]);
  });

  it('infers a carry from a frame-rate run of pinch estimates with no pinch grasp', () => {
    const builder = new ClioCaptureBuilder(planned([{ id: 'syringe', kind: 'tool' }]));
    builder.addObjects([
      // A pinch registration on its own, then a fist carry, then another after a pause.
      ...track('syringe', 'pinch', [100]),
      ...track('syringe', 'pinch', frameTimes(1000, 1200)),
      ...track('syringe', 'pinch', frameTimes(1300, 1350)),
    ]);
    const spans = builder.capture.heldSpans('syringe');
    expect(spans.map((s) => [s.startUs, s.endUs, s.hand, s.grip, s.origin])).toEqual([
      [1_000_000, 1_200_000, null, null, 'inferred'],
      [1_300_000, 1_350_000, null, null, 'inferred'],
    ]);
    expect(heldSpanAt(builder.capture, 'syringe', 1_250_000)).toBeNull();
    expect(heldAt(builder.capture, 1_100_000)).toEqual(new Map([['syringe', null]]));
  });

  it('infers a carry from the rest of a run that outlasts its pinch grasp', () => {
    // GraspTracker releases on pinch end; the closed hand picks the object up again next frame,
    // so the `pinch` estimates go on at frame rate.
    const objects = track('syringe', 'pinch', frameTimes(1000, 3000));
    const events = [pinchAt(1000, 'start', 'syringe'), pinchAt(1500, 'end', 'syringe')];
    const inOrder = new ClioCaptureBuilder(planned([{ id: 'syringe', kind: 'tool' }]));
    inOrder.addEvents(events);
    inOrder.addObjects(objects);
    const eventsLate = new ClioCaptureBuilder(planned([{ id: 'syringe', kind: 'tool' }]));
    eventsLate.addObjects(objects);
    eventsLate.addEvents(events);

    for (const { capture } of [inOrder, eventsLate]) {
      const spans = capture.heldSpans('syringe');
      expect(spans.map((s) => [s.startUs, s.endUs, s.hand, s.grip, s.origin])).toEqual([
        [1_000_000, 1_500_000, 'right', 'pinch', 'inferred'],
        // 1506 ms is the first estimate after the release.
        [1_506_000, 3_000_000, null, null, 'inferred'],
      ]);
      expect(heldSpanAt(capture, 'syringe', 2_000_000)).toMatchObject({ hand: null });
      const types = typesOf(capture, 'syringe') ?? [];
      expect(
        types
          .slice(1)
          .every(([, type, source]) => type === 'runtime_estimate' && source === GRIP_SOURCE),
      ).toBe(true);
    }
  });

  it('types registration, carry and release estimates, whichever channel arrives first', () => {
    const objects = [
      ...track('syringe', 'pinch', [500], 0.9),
      ...track('syringe', 'pinch', frameTimes(1000, 1500)),
      ...track('syringe', 'detector', [2000], 0.7),
    ];
    const events: EpisodeEvent[] = [
      {
        t: 500,
        type: 'object.registered',
        objectId: 'syringe',
        position: [0.1, 0, -0.1],
        method: 'pinch',
      },
      pinchAt(1000, 'start', 'syringe'),
      pinchAt(1500, 'end', 'syringe'),
    ];
    const inOrder = new ClioCaptureBuilder(planned([{ id: 'syringe', kind: 'tool' }]));
    inOrder.addEvents(events);
    inOrder.addObjects(objects);
    // The objects channel can run a batch ahead of the events channel.
    const eventsLate = new ClioCaptureBuilder(planned([{ id: 'syringe', kind: 'tool' }]));
    eventsLate.addObjects(objects);
    eventsLate.addEvents(events);

    for (const { capture } of [inOrder, eventsLate]) {
      const types = typesOf(capture, 'syringe') ?? [];
      expect(types[0]).toEqual([0, 'manual', 'clio-layout']);
      expect(types[1]).toEqual([500, 'manual', 'clio-pinch']);
      expect(types[2]).toEqual([1000, 'runtime_estimate', GRIP_SOURCE]);
      // The release estimate is written at the release.
      expect(types.at(-2)).toEqual([1500, 'runtime_estimate', GRIP_SOURCE]);
      expect(types.at(-1)).toEqual([2000, 'vision_estimate', 'clio-detector']);
      expect(capture.heldSpans('syringe').map((s) => [s.startUs, s.endUs, s.grip])).toEqual([
        [1_000_000, 1_500_000, 'pinch'],
      ]);
      // Confidence is kept only where it was measured.
      const confidences = capture.poses.get('syringe')?.samples.map((s) => s.confidence);
      expect(confidences?.slice(0, -1).every((c) => c === null)).toBe(true);
      expect(confidences?.at(-1)).toBe(0.7);
    }
  });

  it('gives objects first seen in objects.ndjson a radius, from the plan when it lists them', () => {
    const builder = new ClioCaptureBuilder({
      ...planned([{ id: 'jug', kind: 'container', radius: 0.05 }]),
      objects: [],
    });
    builder.addObjects([{ t: 5, objects: [state('jug', 'detector'), state('stray', 'detector')] }]);
    expect(builder.capture.entities.get('jug')?.extensions).toEqual({
      radius_m: 0.05,
      kind: 'container',
      hidden: false,
    });
    expect(builder.capture.entities.get('stray')?.extensions).toEqual({ radius_m: 0.03 });
  });
});

describe('ClioCaptureBuilder input checks', () => {
  it('keeps meta.space as recorded, in W', () => {
    const capture = buildCaptureFromClio({ meta: meta(), frames: [], events: [], objects: [] });
    expect(capture.space).toEqual({
      worldFromWorkspace: [0, 0.75, -0.4, 0, 0, 0, 1],
      calibration: 'pinch_two_corners',
      anchored: false,
    });
  });

  it('refuses a hand layout it does not read', () => {
    expect(() => new ClioCaptureBuilder(meta({ hands: { joints: [], jointFields: [] } }))).toThrow(
      /meta\.hands/,
    );
    const swapped = ['py', 'px', ...HAND_LAYOUT.jointFields.slice(2)];
    expect(
      () =>
        new ClioCaptureBuilder(
          meta({ hands: { joints: [...HAND_LAYOUT.joints], jointFields: swapped } }),
        ),
    ).toThrow(/hand layout/);
  });

  it('drops lines it already has: feeding a batch twice changes no counts', () => {
    const frames = [frame(0, true), frame(11, true), frame(22, true), frame(33, true)];
    const events = [pinchAt(11, 'start', 'shoulder'), pinchAt(33, 'end', 'shoulder')];
    const objects = [
      { t: 0, objects: [state('shoulder', 'layout')] },
      ...track('shoulder', 'pinch', [11, 22, 33]),
      ...track('cup', 'detector', [11], 0.6),
    ];
    const builder = new ClioCaptureBuilder(meta());
    const counts = () => {
      const { capture } = builder;
      return {
        headset: capture.poses.get(HEADSET)?.samples.length,
        left: capture.hands.left.samples.length,
        right: capture.hands.right.samples.length,
        events: capture.events.samples.length,
        poses: [...capture.poses.values()].map((s) => s.samples.length),
        held: capture.heldSpans('shoulder').length,
        types: typesOf(capture, 'shoulder'),
        rejected: builder.rejected,
      };
    };
    builder.addFrames(frames);
    builder.addEvents(events);
    builder.addObjects(objects);
    // The line at t = 0 restates the placement from meta.objects: not a repeat.
    expect(builder.duplicates).toBe(0);
    const once = counts();
    expect(once.poses).toEqual([4, 4, 1]);
    expect(once.held).toBe(1);

    builder.addFrames(frames);
    builder.addEvents(events);
    builder.addObjects(objects);
    expect(counts()).toEqual(once);
    expect(builder.duplicates).toBe(frames.length + events.length + objects.length);
  });

  it('drops a frame that is not after the newest one', () => {
    const builder = new ClioCaptureBuilder(meta());
    builder.addFrames([frame(0), frame(20)]);
    builder.addFrames([frame(10), frame(20), frame(30)]);
    expect(builder.capture.poses.get(HEADSET)?.samples.map((s) => s.t_us)).toEqual([
      0, 20_000, 30_000,
    ]);
    expect(builder.capture.hands.left.samples).toHaveLength(3);
    expect(builder.duplicates).toBe(2);
  });
});

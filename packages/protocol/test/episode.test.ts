import { describe, expect, it } from 'vitest';
import {
  EPISODE_EVENT_TYPES,
  EPISODE_FEATURE,
  EpisodeBatchSchema,
  EpisodeCreateSchema,
  EpisodeEventSchema,
  EpisodeMetaSchema,
  FrameRecordSchema,
  jointOffset,
  LOCATION_FLAG,
  ObjectStateSchema,
  ObjectTrackRecordSchema,
} from '../src/index';

const hand = (n = 200) => ({ joints: new Array(n).fill(0), pinch: 0.03 });
const head = [0, 1.6, 0, 0, 0, 0, 1];

describe('frame records', () => {
  it('accepts a frame where one hand is untracked', () => {
    const r = FrameRecordSchema.safeParse({ t: 12.5, head, left: hand(), right: null });
    expect(r.success).toBe(true);
  });

  it('rejects a hand sample with the wrong number of joint values', () => {
    const r = FrameRecordSchema.safeParse({ t: 0, head, left: hand(199), right: null });
    expect(r.success).toBe(false);
  });

  it('rejects non-finite numbers', () => {
    const r = FrameRecordSchema.safeParse({
      t: 0,
      head: [0, Number.NaN, 0, 0, 0, 0, 1],
      left: null,
      right: null,
    });
    expect(r.success).toBe(false);
  });
});

describe('hand layout', () => {
  it('stores joints in WebXR order with 8 values each', () => {
    expect(jointOffset('wrist')).toBe(0);
    expect(jointOffset('thumb-tip')).toBe(32);
    expect(jointOffset('index-finger-tip')).toBe(72);
    expect(jointOffset('pinky-finger-tip')).toBe(192);
  });
});

describe('episode events', () => {
  it('parses a completed step with its provenance', () => {
    const e = EpisodeEventSchema.parse({
      t: 1500,
      type: 'step.completed',
      stepId: 'pinch-shoulder',
      index: 1,
      by: 'coach',
      forced: true,
      durationMs: 4200,
    });
    expect(e.type === 'step.completed' && e.forced).toBe(true);
  });

  it('rejects an unknown event type', () => {
    expect(EpisodeEventSchema.safeParse({ t: 0, type: 'step.teleported' }).success).toBe(false);
  });

  it('rejects an event without a timestamp', () => {
    const r = EpisodeEventSchema.safeParse({ type: 'procedure.aborted', reason: 'user quit' });
    expect(r.success).toBe(false);
  });

  it('rejects a batch with a negative sequence number', () => {
    expect(EpisodeBatchSchema.safeParse({ seq: -1, frames: [], events: [] }).success).toBe(false);
  });
});

describe('object tracks', () => {
  const track = {
    t: 40,
    objects: [
      {
        id: 'syringe',
        position: [0.2, 0.05, -0.1],
        orientation: [0, 0, 0, 1],
        confidence: 0.9,
        source: 'marker',
      },
    ],
  };

  it('carries object tracks in a batch alongside frames and events', () => {
    const b = EpisodeBatchSchema.parse({ seq: 0, frames: [], events: [], objects: [track] });
    expect(b.objects[0]?.objects[0]?.id).toBe('syringe');
  });

  it('treats a batch without object tracks as having none', () => {
    expect(EpisodeBatchSchema.parse({ seq: 1, frames: [], events: [] }).objects).toEqual([]);
  });

  it('rejects a confidence outside 0..1', () => {
    const bad = { ...track, objects: [{ ...track.objects[0], confidence: 1.5 }] };
    expect(ObjectTrackRecordSchema.safeParse(bad).success).toBe(false);
  });
});

describe('episode meta', () => {
  const meta = {
    schema: 'clio.episode/1',
    episodeId: 'ep-20261024-040000-abcd',
    createdAt: '2026-10-24T04:00:00.000Z',
    mode: 'learn',
    procedure: { id: 'tiny', version: 1, title: 'Tiny' },
    operator: { role: 'learner' },
    clock: { timeline: 'performance.now', startEpochMs: 1_792_000_000_000 },
    space: {
      frame: 'workspace',
      units: 'm',
      upAxis: '+y',
      worldFromWorkspace: [0, 0.8, -0.5, 0, 0, 0, 1],
      calibration: 'default_in_front',
      anchored: false,
    },
    hands: { joints: [], jointFields: [] },
    objects: [],
    coach: { kind: 'gemini', model: 'gemini-3.8-live', transport: 'relay' },
    device: { userAgent: 'test', emulated: true, xrFeatures: [] },
    app: { version: '0.1.0' },
  };
  const plan = {
    schema: 'clio.procedure/1',
    id: 'tiny',
    version: 1,
    title: 'Tiny',
    summary: 'One step.',
    workspace: { size: [0.5, 0.5] },
    objects: [],
    steps: [{ id: 'wait', instruction: 'Wait a moment.', success: { type: 'elapsed', ms: 500 } }],
  };

  it('embeds the full plan so generated lessons are reproducible', () => {
    const parsed = EpisodeMetaSchema.parse({ ...meta, plan });
    expect(parsed.plan?.steps[0]?.instruction).toBe('Wait a moment.');
    expect(parsed.plan?.origin).toEqual({ kind: 'curated' });
  });

  it('still accepts episodes recorded without a plan snapshot', () => {
    expect(EpisodeMetaSchema.safeParse(meta).success).toBe(true);
  });

  it('lists the optional recording features an episode uses, and none in older episodes', () => {
    const features = [EPISODE_FEATURE.objectFlags, EPISODE_FEATURE.objectGrasp];
    expect(features).toEqual(['object.flags', 'object.grasp']);
    expect(EpisodeMetaSchema.parse({ ...meta, features }).features).toEqual(features);
    expect(EpisodeMetaSchema.parse(meta).features).toBeUndefined();
    const { episodeId: _id, createdAt: _at, ...create } = meta;
    expect(EpisodeCreateSchema.parse({ ...create, features }).features).toEqual(features);
  });

  it('accepts features it does not know, so a newer headset is not refused', () => {
    expect(EpisodeMetaSchema.safeParse({ ...meta, features: ['object.later'] }).success).toBe(true);
  });
});

describe('event type list', () => {
  it('is derived from the schema, so the recorder knows every recordable event', () => {
    expect(EPISODE_EVENT_TYPES).toHaveLength(19);
    expect(EPISODE_EVENT_TYPES).toEqual(
      expect.arrayContaining([
        'step.entered',
        'coach.tool_call',
        'transcript',
        'annotation',
        'object.grasped',
        'object.released',
      ]),
    );
  });
});

describe('detections as labels', () => {
  it('records what the object finder saw for a description, with the lifted 3D position', () => {
    const e = EpisodeEventSchema.parse({
      t: 1200,
      type: 'object.detected',
      objectId: 'cap',
      stepId: 'open-cap',
      phrase: 'blue cap',
      description: 'The round blue cap with a wiper icon.',
      found: true,
      point: [0.5, 0.4],
      box: [0.45, 0.35, 0.55, 0.45],
      outline: null,
      confidence: 0.9,
      position: [0.2, 0.1, -0.3],
      source: 'jev',
      latencyMs: 850,
    });
    expect(e.type === 'object.detected' && e.position).toEqual([0.2, 0.1, -0.3]);
  });

  it('dates the camera frame by how long the answer took', () => {
    const base = {
      t: 1200,
      type: 'object.detected',
      objectId: 'cap',
      stepId: null,
      phrase: null,
      description: 'cap',
      found: false,
      point: null,
      box: null,
      outline: null,
      confidence: 0,
      position: null,
      source: 'gemini',
    };
    expect(EpisodeEventSchema.safeParse(base).success).toBe(false);
    expect(EpisodeEventSchema.safeParse({ ...base, latencyMs: -1 }).success).toBe(false);
    expect(EpisodeEventSchema.safeParse({ ...base, latencyMs: 0 }).success).toBe(true);
  });
});

// The optional extension inside clio.episode/1 (docs/data-format.md, "objects.ndjson"). Older
// episodes leave every new field out and must keep parsing.
describe('object location flags', () => {
  const quat = [0, 0, 0, 1];
  const state = {
    id: 'syringe',
    position: [0.2, 0.05, -0.1],
    orientation: null,
    confidence: 0.9,
    source: 'detector',
  };
  const ok = (extra: object) => ObjectStateSchema.safeParse({ ...state, ...extra }).success;

  it('names the four bits as in OpenXR and Capture v1', () => {
    expect(LOCATION_FLAG).toEqual({
      orientationValid: 1,
      positionValid: 2,
      orientationTracked: 4,
      positionTracked: 8,
    });
  });

  it('keeps every new field optional, so older object states still parse', () => {
    const parsed = ObjectStateSchema.parse(state);
    expect(parsed).toEqual(state);
    expect(ok({ orientation: quat, source: 'marker' })).toBe(true);
  });

  it('carries flags, the holding hand and the observation time', () => {
    const parsed = ObjectStateSchema.parse({
      ...state,
      locationFlags: 10,
      heldBy: 'right',
      observedT: -12.5,
    });
    expect(parsed).toMatchObject({ locationFlags: 10, heldBy: 'right', observedT: -12.5 });
    expect(ok({ locationFlags: 2, heldBy: null })).toBe(true);
    expect(ok({ heldBy: 'both' })).toBe(false);
  });

  it('accepts only flags whose tracked bits come with their valid bits', () => {
    const allowed = [0, 1, 2, 3, 5, 7, 10, 11, 15];
    for (let flags = 0; flags <= 15; flags++) {
      const orientation = flags & LOCATION_FLAG.orientationValid ? quat : null;
      expect(ok({ locationFlags: flags, orientation }), `flags ${flags}`).toBe(
        allowed.includes(flags),
      );
    }
    expect(ok({ locationFlags: 16 })).toBe(false);
    expect(ok({ locationFlags: -1 })).toBe(false);
    expect(ok({ locationFlags: 2.5 })).toBe(false);
  });

  it('keeps the last valid position while the position is not valid', () => {
    expect(ok({ locationFlags: 0 })).toBe(true);
    expect(ok({ locationFlags: 0, position: null })).toBe(false);
    const { position: _position, ...withoutPosition } = state;
    expect(ObjectStateSchema.safeParse({ ...withoutPosition, locationFlags: 0 }).success).toBe(
      false,
    );
  });

  it('sets the orientation exactly when the orientation is valid', () => {
    expect(ok({ locationFlags: 15, orientation: quat, source: 'marker' })).toBe(true);
    expect(ok({ locationFlags: 10, orientation: null, source: 'marker' })).toBe(true);
    expect(ok({ locationFlags: 10, orientation: quat, source: 'marker' })).toBe(false);
    expect(ok({ locationFlags: 2, orientation: quat, source: 'pinch' })).toBe(false);
    expect(ok({ locationFlags: 3, orientation: null })).toBe(false);
  });

  it('applies the same rules to object states inside a batch', () => {
    const track = { t: 40, objects: [{ ...state, locationFlags: 4 }] };
    expect(ObjectTrackRecordSchema.safeParse(track).success).toBe(false);
    expect(
      EpisodeBatchSchema.safeParse({ seq: 0, frames: [], events: [], objects: [track] }).success,
    ).toBe(false);
  });
});

describe('grasp events', () => {
  const grasped = {
    t: 2000,
    type: 'object.grasped',
    objectId: 'syringe',
    hand: 'right',
    grip: 'fist',
    position: [0.2, 0.05, -0.1],
  };
  const released = {
    t: 3500,
    type: 'object.released',
    objectId: 'syringe',
    hand: 'right',
    reason: 'hand_lost',
    position: [0.25, 0.12, -0.2],
  };

  it('records a grasp with its grip and a release with its reason', () => {
    const g = EpisodeEventSchema.parse(grasped);
    const r = EpisodeEventSchema.parse(released);
    expect(g.type === 'object.grasped' && g.grip).toBe('fist');
    expect(r.type === 'object.released' && r.reason).toBe('hand_lost');
  });

  it('rejects an unknown grip or release reason', () => {
    expect(EpisodeEventSchema.safeParse({ ...grasped, grip: 'claw' }).success).toBe(false);
    expect(EpisodeEventSchema.safeParse({ ...released, reason: 'dropped' }).success).toBe(false);
  });

  it('needs the hand and the object position', () => {
    const { hand: _hand, ...withoutHand } = grasped;
    const { position: _position, ...withoutPosition } = released;
    expect(EpisodeEventSchema.safeParse(withoutHand).success).toBe(false);
    expect(EpisodeEventSchema.safeParse(withoutPosition).success).toBe(false);
  });
});

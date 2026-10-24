import {
  type EpisodeEvent,
  EpisodeEventSchema,
  type EpisodeMeta,
  EpisodeMetaSchema,
  type FrameRecord,
  HAND_SAMPLE_LENGTH,
  JOINT_STRIDE,
  type ObjectState,
  ObjectTrackRecordSchema,
  type PlacementMethod,
} from '@clio/protocol';
import {
  Capture,
  type CaptureEvent,
  type EstimateType,
  HAND_JOINTS,
  type Handedness,
  type HandSample,
  type Location,
  ORIENTATION_TRACKED,
  ORIENTATION_VALID,
  POSITION_TRACKED,
  POSITION_VALID,
  type Quat,
  type Vec3,
} from './model';

// A Clio episode (meta.json plus the frames, events and objects NDJSON; docs/data-format.md) as a
// Capture. Spatial values move from the workspace frame W (y up, +z toward the user) to ROS REP-103
// the way the pipeline exports them; milliseconds become integer microseconds.
//
//   frames   the headset's pose series, and one hand sample per side per frame (WebXR's 25 joints
//            become OpenXR's 26: the palm, which WebXR lacks, is left invalid)
//   objects  one pose series per object, starting from meta.objects at t = 0
//   events   every event as a `marker` (details.clio is the original), plus grasp and release
//            inferred from pinches that start within reach of an object

export const HEADSET = 'headset';
export const WORKSPACE = 'workspace';
export const HAND_ENTITY: Record<Handedness, string> = { left: 'left_hand', right: 'right_hand' };

/** W to ROS: x = -z, y = -x, z = y. */
export const rosFromW = (v: readonly number[]): Vec3 => [-(v[2] ?? 0), -(v[0] ?? 0), v[1] ?? 0];
/** The same change of basis for a rotation (B R Bᵀ). B is a proper rotation, so only x, y, z move. */
export const rosQuatFromW = (q: readonly number[]): Quat => [
  -(q[2] ?? 0),
  -(q[0] ?? 0),
  q[1] ?? 0,
  q[3] ?? 1,
];

/** Pinch reach beyond an object's radius, the same as the headset's GraspTracker. */
const PINCH_REACH = 0.04;
const DEFAULT_RADIUS = 0.03;
const DEFAULT_WORKSPACE: readonly [number, number] = [0.6, 0.4];
const WORKSPACE_THICKNESS = 0.01;

/** Marker and detector estimates are measured; layout, pinch and manual placements are given. */
const ESTIMATE: Record<PlacementMethod, EstimateType> = {
  layout: 'manual',
  pinch: 'manual',
  manual: 'manual',
  marker: 'vision_estimate',
  detector: 'vision_estimate',
};

const toUs = (ms: number) => Math.round(ms * 1000);

function objectLocation(state: Pick<ObjectState, 'position' | 'orientation' | 'source'>): Location {
  const measured = state.source === 'marker' || state.source === 'detector';
  let flags = POSITION_VALID | (measured ? POSITION_TRACKED : 0);
  if (state.orientation) flags |= ORIENTATION_VALID | (measured ? ORIENTATION_TRACKED : 0);
  return {
    translation: rosFromW(state.position),
    rotation: state.orientation ? rosQuatFromW(state.orientation) : null,
    location_flags: flags,
  };
}

/** Frame lines were validated at ingest; parsing every hand sample again would be slow. */
function isFrame(value: unknown): value is FrameRecord {
  const f = value as Partial<FrameRecord> | null;
  const hand = (h: unknown) =>
    h === null || (h as { joints?: unknown[] } | undefined)?.joints?.length === HAND_SAMPLE_LENGTH;
  return (
    typeof f?.t === 'number' &&
    Array.isArray(f.head) &&
    f.head.length === 7 &&
    hand(f.left) &&
    hand(f.right)
  );
}

/** Builds a Capture from an episode as its lines arrive, so a live episode is converted once. */
export class ClioCaptureBuilder {
  readonly capture: Capture;
  /** Lines that did not match the protocol, skipped. */
  rejected = 0;
  readonly #meta: EpisodeMeta;
  readonly #estimate: EstimateType;
  readonly #known = new Map<string, { label: string; radius: number }>();
  readonly #sequence = new Map<string, number>();
  readonly #grasped: Record<Handedness, string[]> = { left: [], right: [] };

  constructor(meta: unknown) {
    this.#meta = EpisodeMetaSchema.parse(meta);
    const { plan, procedure, objects } = this.#meta;
    // The emulator's hands and head are generated, not measured.
    this.#estimate = this.#meta.device.emulated ? 'synthetic' : 'runtime_estimate';
    this.capture = new Capture(procedure?.title ?? 'Free recording');
    const none = { type: 'none' } as const;
    this.capture.addEntity({
      id: HEADSET,
      name: 'Headset',
      role: 'headset',
      motion: 'tracked',
      geometry: none,
      pose: null,
    });
    for (const side of ['left', 'right'] as const) {
      this.capture.addEntity({
        id: HAND_ENTITY[side],
        name: `${side === 'left' ? 'Left' : 'Right'} hand`,
        role: 'hand',
        motion: 'tracked',
        geometry: none,
        pose: null,
      });
    }
    // The table: W's x along its near edge, -z away from the user, so it spans x 0..d, y -w..0.
    const [w, d] = plan?.workspace.size ?? DEFAULT_WORKSPACE;
    this.capture.addEntity({
      id: WORKSPACE,
      name: 'Workspace',
      role: 'environment',
      motion: 'static',
      geometry: { type: 'box', size: [d, w, WORKSPACE_THICKNESS], color: '#2a3442' },
      pose: { translation: [d / 2, -w / 2, -WORKSPACE_THICKNESS / 2], rotation: [0, 0, 0, 1] },
    });
    for (const o of plan?.objects ?? []) {
      this.#known.set(o.id, { label: o.label, radius: o.radius ?? DEFAULT_RADIUS });
    }
    for (const o of objects) {
      this.#known.set(o.id, { label: o.label, radius: o.radius });
      this.#addObjectPose(0, {
        id: o.id,
        position: o.position,
        orientation: null,
        source: o.method,
      });
    }
  }

  addFrames(records: readonly unknown[]): void {
    for (const r of records) {
      if (!isFrame(r)) {
        this.rejected++;
        continue;
      }
      const t = toUs(r.t);
      this.capture.addPose({
        kind: 'pose',
        t_us: t,
        sequence: this.#next(`headset/${HEADSET}`),
        source_id: 'clio-xr',
        estimate_type: this.#estimate,
        entity_id: HEADSET,
        location: {
          translation: rosFromW(r.head),
          rotation: rosQuatFromW(r.head.slice(3)),
          location_flags: ORIENTATION_VALID | POSITION_VALID,
        },
        confidence: null,
      });
      for (const side of ['left', 'right'] as const) this.capture.addHand(this.#hand(t, side, r));
    }
  }

  addObjects(records: readonly unknown[]): void {
    for (const r of records) {
      const parsed = ObjectTrackRecordSchema.safeParse(r);
      if (!parsed.success) {
        this.rejected++;
        continue;
      }
      for (const state of parsed.data.objects) this.#addObjectPose(parsed.data.t, state);
    }
  }

  addEvents(records: readonly unknown[]): void {
    for (const r of records) {
      const parsed = EpisodeEventSchema.safeParse(r);
      if (!parsed.success) {
        this.rejected++;
        continue;
      }
      const e = parsed.data;
      this.#addEvent(e, 'marker', 'runtime', entitiesOf(e));
      if (e.type === 'hand.pinch') this.#pinch(e);
    }
  }

  /** The episode's length, once the headset has finished it. */
  finish(finish: { durationMs: number } | null | undefined): void {
    this.capture.durationUs = finish ? toUs(finish.durationMs) : null;
  }

  #next(track: string): number {
    const n = this.#sequence.get(track) ?? 0;
    this.#sequence.set(track, n + 1);
    return n;
  }

  #addObjectPose(
    tMs: number,
    state: Pick<ObjectState, 'id' | 'position' | 'orientation' | 'source'> & {
      confidence?: number;
    },
  ): void {
    if (!this.capture.entities.has(state.id)) {
      const known = this.#known.get(state.id);
      this.capture.addEntity({
        id: state.id,
        name: known?.label ?? state.id,
        role: 'object',
        motion: 'tracked',
        geometry: { type: 'none' },
        pose: null,
        extensions: { radius_m: known?.radius ?? DEFAULT_RADIUS },
      });
    }
    this.capture.addPose({
      kind: 'pose',
      t_us: toUs(tMs),
      sequence: this.#next(`objects/${state.id}`),
      source_id: `clio-${state.source}`,
      estimate_type: ESTIMATE[state.source],
      entity_id: state.id,
      location: objectLocation(state),
      confidence: state.confidence ?? null,
    });
  }

  #hand(t: number, side: Handedness, frame: FrameRecord): HandSample {
    const positions = new Float32Array(HAND_JOINTS * 3).fill(Number.NaN);
    const radii = new Float32Array(HAND_JOINTS).fill(Number.NaN);
    const flags = new Uint8Array(HAND_JOINTS);
    const hand = frame[side];
    if (hand) {
      const j = hand.joints;
      // WebXR joint i is OpenXR joint i + 1 (OpenXR starts with the palm).
      for (let i = 0; i + 1 < HAND_JOINTS; i++) {
        const o = i * JOINT_STRIDE;
        positions.set(rosFromW([j[o] ?? 0, j[o + 1] ?? 0, j[o + 2] ?? 0]), (i + 1) * 3);
        radii[i + 1] = j[o + 7] ?? Number.NaN;
        flags[i + 1] = ORIENTATION_VALID | POSITION_VALID;
      }
    }
    return {
      kind: 'hand',
      t_us: t,
      sequence: this.#next(`hands/${HAND_ENTITY[side]}`),
      source_id: 'clio-xr',
      estimate_type: this.#estimate,
      entity_id: HAND_ENTITY[side],
      handedness: side,
      active: hand !== null,
      positions,
      radii,
      flags,
    };
  }

  #addEvent(
    e: EpisodeEvent,
    event: CaptureEvent['event'],
    origin: CaptureEvent['origin'],
    entityIds: string[],
  ): void {
    this.capture.addEvent({
      kind: 'event',
      t_us: toUs(e.t),
      sequence: this.#next('events'),
      source_id: 'clio',
      event,
      entity_ids: entityIds,
      origin,
      details: { clio: e },
    });
  }

  #pinch(e: Extract<EpisodeEvent, { type: 'hand.pinch' }>): void {
    const hand = HAND_ENTITY[e.hand];
    if (e.phase === 'start') {
      const near = e.nearest;
      const radius = near ? this.#known.get(near.objectId)?.radius : undefined;
      if (!near || radius === undefined || near.distance > radius + PINCH_REACH) return;
      this.#grasped[e.hand] = [near.objectId];
      this.#addEvent(e, 'grasp', 'inferred', [hand, near.objectId]);
    } else if (this.#grasped[e.hand].length > 0) {
      this.#addEvent(e, 'release', 'inferred', [hand, ...this.#grasped[e.hand]]);
      this.#grasped[e.hand] = [];
    }
  }
}

/** The entities an event is about. */
function entitiesOf(e: EpisodeEvent): string[] {
  switch (e.type) {
    case 'step.entered':
      return [...e.targets];
    case 'object.detected':
    case 'object.registered':
      return [e.objectId];
    case 'hand.pinch':
      return [HAND_ENTITY[e.hand]];
    default:
      return [];
  }
}

export interface ClioEpisode {
  meta: unknown;
  frames: unknown[];
  events: unknown[];
  objects: unknown[];
  finish?: { durationMs: number } | null;
}

/** A whole episode at once. For a live episode, keep a ClioCaptureBuilder and feed it new lines. */
export function buildCaptureFromClio(episode: ClioEpisode): Capture {
  const builder = new ClioCaptureBuilder(episode.meta);
  builder.addObjects(episode.objects);
  builder.addFrames(episode.frames);
  builder.addEvents(episode.events);
  builder.finish(episode.finish);
  return builder.capture;
}

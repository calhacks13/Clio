import {
  type EpisodeEvent,
  EpisodeEventSchema,
  type EpisodeMeta,
  EpisodeMetaSchema,
  type FrameRecord,
  HAND_SAMPLE_LENGTH,
  JOINT_FIELDS,
  JOINT_STRIDE,
  type ObjectState,
  ObjectTrackRecordSchema,
  type PlacementMethod,
  HAND_JOINTS as WEBXR_JOINTS,
} from '@clio/protocol';
import {
  Capture,
  type CaptureEvent,
  type EstimateType,
  HAND_JOINTS,
  type Handedness,
  type HandSample,
  type HeldSpan,
  type Location,
  type ObjectKind,
  ORIENTATION_TRACKED,
  ORIENTATION_VALID,
  POSITION_TRACKED,
  POSITION_VALID,
  type PoseSample,
  type Quat,
  type Vec3,
} from './model';

// A Clio episode (meta.json plus the frames, events and objects NDJSON; docs/data-format.md) as a
// Capture. Spatial values move from the workspace frame W (y up, +z toward the user) to ROS REP-103
// the way the pipeline exports them; milliseconds become integer microseconds.
//
//   frames   the headset's pose series, and one hand sample per side per frame (WebXR's 25 joints
//            become OpenXR's 26: the palm, which WebXR lacks, is left invalid). Joint orientations
//            are not kept, so joints are flagged POSITION_VALID only.
//   events   every event as a `marker` (details.clio is the original), plus grasp and release
//            inferred from pinches that start within reach of a movable object
//   objects  one pose series per object, starting from meta.objects at t = 0
//
// Held spans come from those inferred grasps, and from runs of `pinch` estimates written every XR
// frame with no pinch grasp to explain them (a fist carry). A `pinch` estimate inside a held span
// is the hand carrying the object; any other is a pinch registration. Only detector and marker
// estimates keep their confidence: the headset's other values are fixed, not measured.
//
// The same lines can arrive twice (read again after a server restart). Frames not after the newest
// frame, object states at a (t, id) already seen and events equal to one at the same t are dropped
// and counted in `duplicates`.

export const HEADSET = 'headset';
export const WORKSPACE = 'workspace';
export const HAND_ENTITY: Record<Handedness, string> = { left: 'left_hand', right: 'right_hand' };
/** The source of an object pose carried by the hand holding it. */
export const GRIP_SOURCE = 'clio-grip';

/** W to ROS: x = -z, y = -x, z = y. */
export const rosFromW = (v: readonly number[]): Vec3 => [-(v[2] ?? 0), -(v[0] ?? 0), v[1] ?? 0];
/** The same change of basis for a rotation (B R Bᵀ). B is a proper rotation, so only x, y, z move. */
export const rosQuatFromW = (q: readonly number[]): Quat => [
  -(q[2] ?? 0),
  -(q[0] ?? 0),
  q[1] ?? 0,
  q[3] ?? 1,
];
/** ROS to W, undoing rosFromW: x = -y, y = z, z = -x. */
export const wFromRos = (v: readonly number[]): Vec3 => [-(v[1] ?? 0), v[2] ?? 0, -(v[0] ?? 0)];
/** ROS to W for a rotation, undoing rosQuatFromW. */
export const wQuatFromRos = (q: readonly number[]): Quat => [
  -(q[1] ?? 0),
  q[2] ?? 0,
  -(q[0] ?? 0),
  q[3] ?? 1,
];

/** Pinch reach beyond an object's radius, the same as the headset's GraspTracker. */
const PINCH_REACH = 0.04;
/** A held object is written every XR frame: a longer gap between `pinch` estimates ends a carry. */
const CARRY_GAP_US = 50_000;
/** The kinds the headset's GraspTracker picks up (unless hidden). */
const MOVABLE_KINDS = new Set<ObjectKind>(['item', 'tool', 'container']);
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

const measured = (source: PlacementMethod) => source === 'marker' || source === 'detector';

function objectLocation(state: Pick<ObjectState, 'position' | 'orientation' | 'source'>): Location {
  const tracked = measured(state.source);
  let flags = POSITION_VALID | (tracked ? POSITION_TRACKED : 0);
  if (state.orientation) flags |= ORIENTATION_VALID | (tracked ? ORIENTATION_TRACKED : 0);
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

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

/** Whether a span covers `t`, counting its end (the release estimate is written at the release). */
const covers = (span: HeldSpan, t: number) =>
  span.startUs <= t && (span.endUs === null || t <= span.endUs);

interface Known {
  label: string;
  radius: number;
  /** Set for objects the plan lists. */
  kind?: ObjectKind;
  hidden?: boolean;
}

/** Builds a Capture from an episode as its lines arrive, so a live episode is converted once. */
export class ClioCaptureBuilder {
  readonly capture: Capture;
  /** Lines that did not match the protocol, skipped. */
  rejected = 0;
  /** Lines already received (see above), skipped. */
  duplicates = 0;
  readonly #meta: EpisodeMeta;
  readonly #estimate: EstimateType;
  readonly #known = new Map<string, Known>();
  readonly #sequence = new Map<string, number>();
  readonly #grasped: Record<Handedness, string[]> = { left: [], right: [] };
  #lastFrameUs = Number.NEGATIVE_INFINITY;
  /** Each placement from meta.objects, until an objects line at t = 0 restates it. */
  readonly #placements = new Set<PoseSample>();
  /** The events received, as JSON, by time. */
  readonly #events = new Map<number, string[]>();
  /** Each object's `pinch` estimates in time order: registrations and carries. */
  readonly #pinches = new Map<string, PoseSample[]>();
  /** Each object's carries inferred from its `pinch` estimates. */
  readonly #carries = new Map<string, readonly HeldSpan[]>();
  /** Objects whose carries and estimate types need working out again. */
  readonly #unsettled = new Set<string>();

  constructor(meta: unknown) {
    this.#meta = EpisodeMetaSchema.parse(meta);
    const { plan, procedure, objects, hands, space } = this.#meta;
    if (!sameList(hands.joints, WEBXR_JOINTS) || !sameList(hands.jointFields, JOINT_FIELDS)) {
      throw new Error(
        `Episode ${this.#meta.episodeId}: meta.hands is not the hand layout this viewer reads ` +
          `(${WEBXR_JOINTS.length} WebXR joints, fields ${JOINT_FIELDS.join(', ')})`,
      );
    }
    // The emulator's hands and head are generated, not measured.
    this.#estimate = this.#meta.device.emulated ? 'synthetic' : 'runtime_estimate';
    this.capture = new Capture(procedure?.title ?? 'Free recording');
    this.capture.space = {
      worldFromWorkspace: [...space.worldFromWorkspace],
      calibration: space.calibration,
      anchored: space.anchored,
    };
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
      this.#known.set(o.id, { label: o.label, radius: o.radius, kind: o.kind, hidden: o.hidden });
    }
    for (const o of objects) {
      this.#known.set(o.id, { ...this.#known.get(o.id), label: o.label, radius: o.radius });
      const placed = this.#addObjectPose(0, {
        id: o.id,
        position: o.position,
        orientation: null,
        confidence: null,
        source: o.method,
      });
      if (placed) this.#placements.add(placed);
    }
  }

  addFrames(records: readonly unknown[]): void {
    for (const r of records) {
      if (!isFrame(r)) {
        this.rejected++;
        continue;
      }
      const t = toUs(r.t);
      if (t <= this.#lastFrameUs) {
        this.duplicates++;
        continue;
      }
      this.#lastFrameUs = t;
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
    this.#settle();
  }

  addEvents(records: readonly unknown[]): void {
    for (const r of records) {
      const parsed = EpisodeEventSchema.safeParse(r);
      if (!parsed.success) {
        this.rejected++;
        continue;
      }
      const e = parsed.data;
      if (this.#received(e)) {
        this.duplicates++;
        continue;
      }
      this.#addEvent(e, 'marker', 'runtime', entitiesOf(e));
      if (e.type === 'hand.pinch') this.#pinch(e);
    }
    this.#settle();
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

  /** Whether an equal event at the same time already arrived; remembers it if not. */
  #received(e: EpisodeEvent): boolean {
    const t = toUs(e.t);
    const json = JSON.stringify(e);
    const seen = this.#events.get(t);
    if (seen?.includes(json)) return true;
    if (seen) seen.push(json);
    else this.#events.set(t, [json]);
    return false;
  }

  /** An object entity, declared the first time the object is seen. */
  #object(id: string): void {
    if (this.capture.entities.has(id)) return;
    let known = this.#known.get(id);
    if (!known) {
      known = { label: id, radius: DEFAULT_RADIUS };
      this.#known.set(id, known);
    }
    const { kind, hidden } = known;
    this.capture.addEntity({
      id,
      name: known.label,
      role: 'object',
      motion: kind === 'point' || kind === 'region' ? 'static' : 'tracked',
      geometry: { type: 'none' },
      pose: null,
      extensions: {
        radius_m: known.radius,
        ...(kind && { kind }),
        ...(hidden !== undefined && { hidden }),
      },
    });
  }

  /** The object's radius if a hand can pick it up: movable (or not in the plan) and not hidden. */
  #graspRadius(id: string): number | null {
    const known = this.#known.get(id);
    if (!known || known.hidden || (known.kind && !MOVABLE_KINDS.has(known.kind))) return null;
    return known.radius;
  }

  /** Adds the estimate, or restates a placement; returns null for a duplicate. */
  #addObjectPose(
    tMs: number,
    state: Pick<ObjectState, 'id' | 'position' | 'orientation' | 'source'> & {
      /** Null for a placement from meta.objects, which records none. */
      confidence: number | null;
    },
  ): PoseSample | null {
    this.#object(state.id);
    const t = toUs(tMs);
    const fields = {
      source_id: `clio-${state.source}`,
      estimate_type: ESTIMATE[state.source],
      location: objectLocation(state),
      confidence: measured(state.source) ? state.confidence : null,
    };
    const series = this.capture.poses.get(state.id);
    const existing = series?.samples[series.indexAt(t)];
    let sample: PoseSample;
    if (existing?.t_us === t) {
      // A line at t = 0 restates meta.objects; anything else at a known (t, id) is a repeat.
      if (!this.#placements.delete(existing)) {
        this.duplicates++;
        return null;
      }
      sample = Object.assign(existing, fields);
    } else {
      sample = {
        kind: 'pose',
        t_us: t,
        sequence: this.#next(`objects/${state.id}`),
        entity_id: state.id,
        ...fields,
      };
      this.capture.addPose(sample);
    }
    if (state.source === 'pinch') {
      const pinches = this.#pinches.get(state.id) ?? [];
      if (pinches.length === 0) this.#pinches.set(state.id, pinches);
      let at = pinches.length;
      while (at > 0 && (pinches[at - 1] as PoseSample).t_us > t) at--;
      pinches.splice(at, 0, sample);
      this.#unsettled.add(state.id);
    }
    return sample;
  }

  /**
   * Works out the carries of objects that gained `pinch` estimates or grasps: a run of estimates
   * at frame rate is a carry unless a grasp span already explains it. Then each `pinch` estimate is
   * typed by whether a held span covers it.
   */
  #settle(): void {
    for (const id of this.#unsettled) {
      const pinches = this.#pinches.get(id) ?? [];
      const previous = this.#carries.get(id) ?? [];
      const grasps = this.capture.heldSpans(id).filter((span) => !previous.includes(span));
      const carries: HeldSpan[] = [];
      if (this.#graspRadius(id) !== null) {
        // A stretch of a run that no grasp covers is a carry, even after a pinch grasp in the same
        // run: GraspTracker releases on pinch end and the closed hand picks the object up again.
        let first: PoseSample | null = null;
        let last: PoseSample | null = null;
        const close = () => {
          if (first && last && first !== last) {
            carries.push({
              entityId: id,
              hand: null,
              startUs: first.t_us,
              endUs: last.t_us,
              origin: 'inferred',
              grip: null,
            });
          }
          first = last = null;
        };
        for (const sample of pinches) {
          if (last && sample.t_us - last.t_us > CARRY_GAP_US) close();
          if (grasps.some((span) => covers(span, sample.t_us))) {
            close();
            continue;
          }
          first ??= sample;
          last = sample;
        }
        close();
      }
      this.#carries.set(id, carries);
      this.capture.setSampleHeldSpans(id, carries);
      const spans = this.capture.heldSpans(id);
      for (const sample of pinches) {
        const carried = spans.some((span) => covers(span, sample.t_us));
        sample.source_id = carried ? GRIP_SOURCE : 'clio-pinch';
        sample.estimate_type = carried ? 'runtime_estimate' : 'manual';
      }
    }
    this.#unsettled.clear();
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
        flags[i + 1] = POSITION_VALID;
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
      pinch_m: hand?.pinch ?? null,
    };
  }

  #addEvent(
    e: EpisodeEvent,
    event: CaptureEvent['event'],
    origin: CaptureEvent['origin'],
    entityIds: string[],
    details: Record<string, unknown> = {},
  ): void {
    this.capture.addEvent({
      kind: 'event',
      t_us: toUs(e.t),
      sequence: this.#next('events'),
      source_id: 'clio',
      event,
      entity_ids: entityIds,
      origin,
      details: { clio: e, ...details },
    });
  }

  /** Like GraspTracker: a pinch picks up the movable object in reach that no other hand holds. */
  #pinch(e: Extract<EpisodeEvent, { type: 'hand.pinch' }>): void {
    const hand = HAND_ENTITY[e.hand];
    const grasped = this.#grasped[e.hand];
    if (e.phase === 'start') {
      const near = e.nearest;
      const radius = near ? this.#graspRadius(near.objectId) : null;
      if (!near || radius === null || near.distance > radius + PINCH_REACH) return;
      const other = this.#grasped[e.hand === 'left' ? 'right' : 'left'];
      if (grasped.includes(near.objectId) || other.includes(near.objectId)) return;
      grasped.push(near.objectId);
      this.#addEvent(e, 'grasp', 'inferred', [hand, near.objectId], { grip: 'pinch' });
      this.#unsettled.add(near.objectId);
    } else if (grasped.length > 0) {
      this.#addEvent(e, 'release', 'inferred', [hand, ...grasped]);
      for (const id of grasped) this.#unsettled.add(id);
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

/**
 * A whole episode at once, in the order a live episode is read: frames, events, objects. For a live
 * episode, keep a ClioCaptureBuilder and feed it new lines.
 */
export function buildCaptureFromClio(episode: ClioEpisode): Capture {
  const builder = new ClioCaptureBuilder(episode.meta);
  builder.addFrames(episode.frames);
  builder.addEvents(episode.events);
  builder.addObjects(episode.objects);
  builder.finish(episode.finish);
  return builder.capture;
}

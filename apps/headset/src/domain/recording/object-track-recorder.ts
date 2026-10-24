import {
  type Handedness,
  LOCATION_FLAG,
  type ObjectObservation,
  type ObjectState,
  type PlacementMethod,
} from '@clio/protocol';
import type { Clock } from '../../core/clock';
import type { Quat, Vec3 } from '../../core/math';
import type { AppBus } from '../events';
import type { TrackedObjectSample } from '../world/tracked-object';
import type { Workspace } from '../world/workspace';

// Records what object sources report (TrackedObjectSample) on the bus, for EpisodeRecorder to
// write. The 2D part goes out as an `objects.observed` observation, unchanged (normalized image
// coordinates). The 3D part, when asked for, goes out as an `objects.updated` state in the
// workspace frame with honest location flags: a position measured on its frame is tracked; a
// predicted one (a coasting tracker), or one not measured on that frame (a reused depth, a surface
// guess), is valid but never tracked; and a lost object keeps its last position with no flags, once
// per loss. Like ObjectRegistry's, a state without a valid position has no observedT: it says what
// is true when it is written. Nothing is invented: a sample without a score, or with a non-finite
// number, gets no 3D state, and heldBy is left out (unknown) unless the caller says who holds the
// object. In the lesson ObjectRegistry owns the 3D estimates, so there only the observations are
// recorded.

export interface ObjectTrackRecorderDeps {
  bus: AppBus;
  clock: Clock;
  /** The episode's workspace, read at use time. Without one no 3D state is recorded. */
  workspace: () => Workspace | null;
  /** record: also record 3D states (free capture). none: 2D observations only (the lesson). */
  states: 'record' | 'none';
  /**
   * The hand carrying an object when a state is recorded, if the caller knows (e.g. from a
   * GraspTracker): null for no hand. Without it, or when it returns undefined, states leave heldBy
   * out, which readers take as unknown.
   */
  holderOf?: (objectId: string) => Handedness | null | undefined;
}

/** A 3D estimate in the workspace frame and how valid it is (`LOCATION_FLAG` bits). */
interface Estimate {
  position: Vec3;
  orientation: Quat | null;
  confidence: number;
  source: PlacementMethod;
  flags: number;
}

interface LastState extends Estimate {
  /**
   * When readers place the last recorded state (performance.now ms): its camera frame time, or the
   * time it was written when its position is not valid.
   */
  at: number;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const finite = (v: readonly number[]) => v.every(Number.isFinite);

export class ObjectTrackRecorder {
  private readonly last = new Map<string, LastState>();

  constructor(private readonly deps: ObjectTrackRecorderDeps) {}

  record(sample: TrackedObjectSample): void {
    const t = this.deps.clock.now();
    if (sample.image || sample.status === 'lost' || sample.status === 'absent') {
      this.deps.bus.emit('objects.observed', { t, observation: observationOf(sample, t) });
    }
    if (this.deps.states !== 'record') return;
    const state = this.stateOf(sample, t);
    if (state) this.deps.bus.emit('objects.updated', { t, objects: [state] });
  }

  /** Forget every object's last state (a new episode). */
  reset(): void {
    this.last.clear();
  }

  /**
   * The 3D state a sample implies, or null when it implies nothing new. A sample about a frame no
   * later than where readers place the object's last state is ignored, so each object's states
   * keep their order.
   */
  private stateOf(sample: TrackedObjectSample, t: number): ObjectState | null {
    const workspace = this.deps.workspace();
    if (!workspace) return null;
    const last = this.last.get(sample.objectId);
    if (last && sample.observedT <= last.at) return null;
    switch (sample.status) {
      case 'measured':
      case 'predicted': {
        // A confidence is reported or not recorded at all: never a default, never NaN.
        if (sample.score === null || !Number.isFinite(sample.score)) return null;
        const confidence = clamp01(sample.score);
        if (sample.position) {
          // Checked before the transform: normalizing would turn a NaN orientation into identity.
          if (!finite(sample.position) || !finite(sample.orientation ?? [])) return null;
          const measured = sample.status === 'measured';
          // A box seen on this frame but placed at a reused depth or a surface guess: valid, not
          // tracked. The orientation, when there is one, was measured with the box.
          const positionTracked = measured && sample.positionMeasured !== false;
          const orientation = sample.orientation && toWorkspaceQuat(workspace, sample.orientation);
          const position = workspace.toWorkspacePoint(sample.position);
          let flags =
            LOCATION_FLAG.positionValid | (positionTracked ? LOCATION_FLAG.positionTracked : 0);
          if (orientation) {
            flags |= LOCATION_FLAG.orientationValid;
            if (measured) flags |= LOCATION_FLAG.orientationTracked;
          }
          const source = orientation ? 'marker' : 'detector';
          return this.remember(sample, t, { position, orientation, confidence, source, flags });
        }
        // A coasting tracker without a 3D estimate: the last position still stands, untracked.
        // Written once per stretch (an unchanged estimate is not recorded again), not after a loss.
        const carried = LOCATION_FLAG.positionValid;
        if (sample.status !== 'predicted' || !last || last.flags === 0 || last.flags === carried) {
          return null;
        }
        return this.remember(sample, t, { ...last, orientation: null, confidence, flags: carried });
      }
      case 'lost':
      case 'absent':
        if (!last || last.flags === 0) return null;
        return this.remember(sample, t, { ...last, orientation: null, confidence: 0, flags: 0 });
      case 'unknown':
        return null;
    }
  }

  /** Records the estimate as the object's last state; `t` is when it is written. */
  private remember(sample: TrackedObjectSample, t: number, estimate: Estimate): ObjectState {
    const { objectId, observedT } = sample;
    const valid = (estimate.flags & LOCATION_FLAG.positionValid) !== 0;
    this.last.set(objectId, { ...estimate, at: valid ? observedT : t });
    const heldBy = this.deps.holderOf?.(objectId);
    return {
      id: objectId,
      position: estimate.position,
      orientation: estimate.orientation,
      confidence: estimate.confidence,
      source: estimate.source,
      locationFlags: estimate.flags,
      ...(heldBy === undefined ? {} : { heldBy }),
      ...(valid ? { observedT } : {}),
    };
  }
}

/** The observation a sample makes, with absolute times; the episode recorder rebases them. */
function observationOf(sample: TrackedObjectSample, t: number): ObjectObservation {
  const image = sample.image;
  return {
    t,
    observedT: sample.observedT,
    objectId: sample.objectId,
    status: sample.status,
    role: sample.role,
    source: sample.source,
    box: image?.box ?? null,
    outline: image?.outline ?? null,
    point: image?.point ?? null,
    contact: image?.contact ?? null,
    score: sample.score,
    frame: image?.frame ?? null,
    trackId: sample.trackId,
  };
}

const toWorkspaceQuat = (workspace: Workspace, q: Quat): Quat =>
  workspace.toWorkspacePose({ p: [0, 0, 0], q }).q;

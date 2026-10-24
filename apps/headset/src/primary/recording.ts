import {
  EPISODE_FEATURE,
  type EpisodeCreate,
  type EpisodeOutcome,
  HAND_LAYOUT,
  LOCATION_FLAG,
  type ObjectState,
  type PrimaryResponse,
} from '@clio/protocol';
import { FrameSampler } from '../adapters/xr/frame-sampler';
import { type Clock, performanceClock } from '../core/clock';
import { Emitter } from '../core/emitter';
import { type Pose7, poseToTuple, type Vec3 } from '../core/math';
import type { AppEvents } from '../domain/events';
import type { TrackedFrame } from '../domain/hands/types';
import { q4 } from '../domain/recording/quantize';
import { EpisodeRecorder } from '../domain/recording/recorder';
import type { EpisodeSink } from '../domain/recording/sink';
import { Workspace, workspaceInFrontOf } from '../domain/world/workspace';

// Records a primary-demo session as an ordinary Clio episode (clio.episode/1, mode "free"), through
// the lesson's own EpisodeRecorder and uploader: no new format and no new server route. The episode
// appears in /api/episodes and replays in viewer.html.
//
//   frames   head and both hands, every XR frame
//   objects  one object per target name: the placed outline's center while it is tracked
//            (locationFlags 10, observedT = the camera frame's capture time), the last center with
//            0 once the tracker loses it, and with 2 once the demo moves on to another target
//   events   object.registered on an object's first placement, object.detected for every answer
//            that named something, and an annotation "primary.target" whenever the named target
//            changes
//
// Only the current target is recorded: placed() and lost() for any other name are ignored, so a
// mask still in flight for the previous target (or for one the tracker was told to drop) cannot
// re-register or revive an object the demo has moved on from.
//
// The demo works in local-floor space; the episode's workspace is the default one in front of the
// head at the first XR frame (as in a lesson without a table), fixed for the whole episode.

/** The annotation label recorded when the named target changes. */
export const TARGET_ANNOTATION = 'primary.target';

/** A tracked object: position valid and measured just now. */
const TRACKED = LOCATION_FLAG.positionValid | LOCATION_FLAG.positionTracked;
/** No longer followed: its last position still stands, but nothing measures it. */
const UNTRACKED = LOCATION_FLAG.positionValid;
/** Lost by the tracker: where it is now is unknown. */
const LOST = 0;

export interface PrimaryRecordingDeps {
  /** Production: new HttpEpisodeSink(new ApiClient()). */
  sink: EpisodeSink;
  clock?: Clock;
  /** Frames per batch (default 90). */
  batchFrames?: number;
  /** Maximum batch age in ms (default 1000). */
  batchIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onDrop?: (why: string) => void;
}

/** What the episode's meta says about the session. */
export interface PrimarySessionInfo {
  userAgent: string;
  emulated: boolean;
  /** The session's enabled features. */
  xrFeatures: readonly string[];
  /** __CLIO_VERSION__. */
  version: string;
}

interface ObjectTrack {
  /** Workspace frame. */
  position: Vec3;
  flags: number;
}

/** An object id from a target name: "Red mug" becomes "red-mug". */
export function objectIdFor(name: string): string {
  const id = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return id || 'object';
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export class PrimaryRecording {
  private readonly bus = new Emitter<AppEvents>();
  private readonly clock: Clock;
  private readonly recorder: EpisodeRecorder;
  private readonly sampler = new FrameSampler();
  /** Set by begin(); the episode starts on the next frame, which fixes the workspace. */
  private info: PrimarySessionInfo | null = null;
  private workspace: Workspace | null = null;
  private readonly tracks = new Map<string, ObjectTrack>();
  /** The object the latest answer named. */
  private target: string | null = null;

  constructor(deps: PrimaryRecordingDeps) {
    this.clock = deps.clock ?? performanceClock;
    this.recorder = new EpisodeRecorder({
      bus: this.bus,
      clock: this.clock,
      sink: deps.sink,
      ...(deps.batchFrames === undefined ? {} : { batchFrames: deps.batchFrames }),
      ...(deps.batchIntervalMs === undefined ? {} : { batchIntervalMs: deps.batchIntervalMs }),
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
      ...(deps.onDrop ? { onDrop: deps.onDrop } : {}),
    });
  }

  get recording(): boolean {
    return this.recorder.recording;
  }

  /** The server's id for the episode, once it has answered the create. */
  get episodeId(): string | null {
    return this.recorder.episodeId;
  }

  /**
   * A session started: record it from its first XR frame on. A previous episode still open is
   * finished as interrupted.
   */
  begin(info: PrimarySessionInfo): void {
    if (this.recorder.recording) void this.end('interrupted');
    this.info = info;
    this.workspace = null;
    this.tracks.clear();
    this.target = null;
  }

  /** Every XR frame: samples the head and both hands (world space) and records them. */
  xrFrame(frame: XRFrame, space: XRReferenceSpace, t: number): void {
    if (!this.info && !this.recorder.recording) return;
    const sampled = this.sampler.sample(frame, space, t);
    if (sampled) this.frame(sampled);
  }

  /** One frame in world (local-floor) space; the first after begin() starts the episode. */
  frame(world: TrackedFrame): void {
    const info = this.info;
    if (info && !this.recorder.recording) {
      this.workspace = new Workspace(workspaceInFrontOf(world.head), 'default_in_front');
      this.recorder.start(this.meta(info, this.workspace), world.t);
      this.info = null;
    }
    if (!this.workspace || !this.recorder.recording) return;
    this.recorder.recordFrame(this.workspace.toWorkspaceFrame(world));
  }

  /**
   * An answer from the server (Gemini named it, jev found it), measured on the camera frame taken
   * at `captureT`. Records it as object.detected (unless nothing was named), and the target change
   * when the name differs from the last answer's. `position` is where it was placed (world), if it
   * was.
   */
  answer(response: PrimaryResponse, captureT: number, position: Vec3 | null = null): void {
    if (!this.workspace || !this.recorder.recording) return;
    const t = this.clock.now();
    const { name, detection } = response;
    this.retarget(name, t);
    if (!name) return;
    this.bus.emit('object.detected', {
      t,
      objectId: objectIdFor(name),
      stepId: null,
      phrase: name,
      description: response.description ?? name,
      found: detection?.found ?? false,
      point: detection?.point ?? null,
      box: detection?.box ?? null,
      outline: detection?.outline ?? null,
      confidence: clamp01(detection?.confidence ?? 0),
      position: position && this.workspace.toWorkspacePoint(position),
      source: response.model.finder,
      latencyMs: Math.max(0, t - captureT),
    });
  }

  /**
   * The outline of `name` was placed (ignored unless `name` is the latest answer's target) with its center at `center` (world), seen in the camera frame
   * taken at `captureT` (null when unknown). `confidence` is the tracker's score, if any.
   */
  placed(
    name: string,
    center: Readonly<Vec3>,
    captureT: number | null,
    confidence: number | null = null,
  ): void {
    if (!this.workspace || !this.recorder.recording) return;
    const id = objectIdFor(name);
    if (!this.isTarget(id)) return;
    const t = this.clock.now();
    const position = this.workspace.toWorkspacePoint(center);
    if (!this.tracks.has(id)) {
      this.bus.emit('object.registered', { t, objectId: id, position, method: 'detector' });
    }
    this.tracks.set(id, { position, flags: TRACKED });
    this.update(t, id, position, TRACKED, confidence ?? 1, captureT);
  }

  /**
   * The tracker lost `name` in the camera frame taken at `captureT` (or an answer without a tracker
   * did not find it). Recorded once per loss, keeping its last position; ignored unless `name` is
   * the latest answer's target.
   */
  lost(name: string, captureT: number | null = null): void {
    if (!this.workspace || !this.recorder.recording) return;
    const id = objectIdFor(name);
    if (!this.isTarget(id)) return;
    const track = this.tracks.get(id);
    if (!track || track.flags === LOST) return;
    track.flags = LOST;
    this.update(this.clock.now(), id, track.position, LOST, 0, captureT);
  }

  /** The session ended: finish the episode (resolves once everything is delivered or dropped). */
  async end(outcome: EpisodeOutcome = 'completed'): Promise<void> {
    this.info = null;
    if (!this.recorder.recording) return;
    const t = this.clock.now();
    const stopped = this.recorder.stop(outcome, { stepsCompleted: 0, stepsTotal: 0 }, t);
    this.workspace = null;
    this.tracks.clear();
    this.target = null;
    await stopped;
  }

  /** Whether `id` is the object the latest answer named (nothing is, before an answer or after one naming nothing). */
  private isTarget(id: string): boolean {
    return this.target !== null && objectIdFor(this.target) === id;
  }

  /** Records a change of the named target; the previous one, if tracked, is no longer followed. */
  private retarget(name: string | null, t: number): void {
    if (name === this.target) return;
    const previous = this.target;
    this.target = name;
    const old = previous === null ? undefined : this.tracks.get(objectIdFor(previous));
    if (previous !== null && old && old.flags === TRACKED) {
      old.flags = UNTRACKED;
      this.update(t, objectIdFor(previous), old.position, UNTRACKED, 1, null);
    }
    this.bus.emit('annotation', {
      t,
      label: TARGET_ANNOTATION,
      data: {
        objectId: name === null ? null : objectIdFor(name),
        name,
        previous: previous === null ? null : objectIdFor(previous),
      },
    });
  }

  private update(
    t: number,
    id: string,
    position: Vec3,
    flags: number,
    confidence: number,
    observedT: number | null,
  ): void {
    const state: ObjectState = {
      id,
      position,
      orientation: null,
      confidence: clamp01(confidence),
      source: 'detector',
      locationFlags: flags,
      heldBy: null,
      ...(observedT === null ? {} : { observedT }),
    };
    this.bus.emit('objects.updated', { t, objects: [state] });
  }

  private meta(info: PrimarySessionInfo, workspace: Workspace): Omit<EpisodeCreate, 'clock'> {
    return {
      schema: 'clio.episode/1',
      mode: 'free',
      procedure: null,
      operator: { role: 'collector' },
      space: {
        frame: 'workspace',
        units: 'm',
        upAxis: '+y',
        worldFromWorkspace: poseToTuple(workspace.worldFromWorkspace).map(q4) as Pose7,
        calibration: workspace.method,
        anchored: false,
      },
      hands: HAND_LAYOUT,
      objects: [],
      coach: { kind: 'none' },
      device: {
        userAgent: info.userAgent,
        emulated: info.emulated,
        xrFeatures: [...info.xrFeatures],
      },
      app: { version: info.version },
      features: [EPISODE_FEATURE.objectFlags],
    };
  }
}

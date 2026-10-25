import {
  type CalibrationMethod,
  EPISODE_EVENT_TYPES,
  type EpisodeEventPayload,
  type EpisodeEventType,
  type FocusAction,
  type FocusDetection,
  type HighlightRole,
  type ObjectObservation,
  type ObjectState,
  type PlanStage,
  type Procedure,
  type StepCheckCriterion,
} from '@clio/protocol';
import type { Emitter } from '../core/emitter';
import type { Pose, Vec3 } from '../core/math';
import type { PlanOp } from './plan/recital';
import type { ObjectOutline } from './world/outline';

// The headset's event bus. Recordable events are exactly the protocol's episode events (payload
// plus an absolute `t` on the performance.now() timeline); the recorder rebases `t` to the episode
// start, and with it the other times a payload holds (a keyframe's `capturedT` is a bus time too,
// quantize.ts). Internal events coordinate the app but are not part of the dataset.

export type Timed<T> = T & { t: number };

export type RecordableEvents = { [K in EpisodeEventType]: Timed<EpisodeEventPayload<K>> };

export type LessonPhase =
  | 'idle'
  | 'planning'
  | 'locating'
  | 'calibrating'
  | 'lesson'
  | 'done'
  | 'failed';

export type HighlightStyle = 'target' | 'attention' | 'warning';

/**
 * The conversation with a coach that listens: the learner talking (hearing), Clio talking
 * (speaking), or neither (quiet). Off without one: no coach, or the scripted one, which can't hear.
 */
export type CoachVoice = 'off' | 'quiet' | 'hearing' | 'speaking';

export interface InternalEvents {
  'lesson.phase': Timed<{ phase: LessonPhase; detail?: string }>;
  'plan.requested': Timed<{ goal: string; revision: boolean }>;
  'plan.ready': Timed<{
    planId: string;
    procedure: Procedure;
    warnings: string[];
    revision: boolean;
    /**
     * first: the steps after the first are an outline, being written in full. rest: that full
     * version replaced the outline (a revision). Absent for a plan written whole.
     */
    stage?: Exclude<PlanStage, 'full'>;
  }>;
  'plan.failed': Timed<{ goal: string; error: string; revision: boolean }>;
  /** Planning is taking longer than expected; the plan may still arrive. */
  'plan.slow': Timed<{ goal: string; elapsedMs: number }>;
  /** The plan or a step's status changed. Read the new plan from LessonView.plan(). */
  'plan.changed': Timed<{ rev: number; op: PlanOp; stepId: string | null }>;
  /**
   * The step watcher thinks a step looks done (base64 JPEG it judged by), with the step's criteria
   * as the last look judged them (all met). The coach decides.
   */
  'step.looks_done': Timed<{
    stepId: string;
    observation: string;
    image: string | null;
    criteria?: StepCheckCriterion[];
  }>;
  /**
   * The step watcher thinks the learner did something else instead, e.g. "picked up the milk,
   * not the yogurt drink" (base64 JPEG it judged by), with the step's criteria as judged. The
   * coach decides whether to correct them.
   */
  'step.looks_wrong': Timed<{
    stepId: string;
    wrong: string;
    observation: string;
    image: string | null;
    criteria?: StepCheckCriterion[];
  }>;
  /** The step watcher saw a danger near the hands (a blade, something hot), whatever the step. */
  'step.hazard': Timed<{ stepId: string; hazard: string; image: string | null }>;
  'step.stuck': Timed<{ stepId: string; elapsedMs: number }>;
  'object.missing': Timed<{ objectIds: string[] }>;
  'objects.updated': Timed<{ objects: ObjectState[] }>;
  /**
   * What an object finder saw in one camera frame (2D). Its `t` and `observedT` are performance.now
   * ms like every bus time; the recorder rebases them and writes it to observations.ndjson.
   */
  'objects.observed': Timed<{ observation: ObjectObservation }>;
  'overlay.highlight': Timed<{ objectId: string; style: HighlightStyle; source: 'auto' | 'coach' }>;
  /**
   * Robotics-ER 2's action focus answered for the focused step (session/action-focus.ts): where
   * the followed objects are in the frame it saw and the one thing to touch next. For the learner's
   * view and the recording, never a Gemini coach.
   */
  'focus.answered': Timed<{
    /** When the frame ER saw was captured (performance.now ms, like `t`). */
    frameT: number;
    stepId: string;
    /** One per object it was asked about, in that order; boxes are 0..1 of that frame. */
    detections: FocusDetection[];
    /** The one thing to touch next, in ER's words; null when the step needs nothing touched. */
    action: FocusAction | null;
    /** The lesson object lit for the action (declared now if the plan lacked it), or null. */
    actionId: string | null;
    model: string;
    latencyMs: number;
  }>;
  'overlay.demo': Timed<{ stepId: string; playing: boolean }>;
  /** An outline for something the current step shows (replaces the object's previous one). */
  'overlay.outline': Timed<{
    objectId: string;
    outline: ObjectOutline;
    /**
     * Where the camera saw the object relative to its estimate (workspace frame). Zero unless the
     * registry kept a measured layout position over the detection.
     */
    offset: Vec3;
    /** Its place in the step's show list: 0 is what to act on, then where it goes. */
    rank: number;
    /** The glow's meaning, which picks its color (overlay/accents.ts). */
    role: HighlightRole;
    phrase: string;
  }>;
  'coach.caption': Timed<{ role: 'user' | 'coach'; text: string; final: boolean }>;
  /** The conversation changed (CoachSession), for the panel's status mark. Not recorded. */
  'coach.voice': Timed<{ voice: CoachVoice }>;
  'workspace.calibrated': Timed<{ method: CalibrationMethod; worldFromWorkspace: Pose }>;
  'recorder.status': Timed<{ recording: boolean; episodeId: string | null; queued: number }>;
}

export type AppEvents = RecordableEvents & InternalEvents;
export type AppBus = Emitter<AppEvents>;

const RECORDABLE = new Set<string>(EPISODE_EVENT_TYPES);
export function isRecordable(type: PropertyKey): type is EpisodeEventType {
  return typeof type === 'string' && RECORDABLE.has(type);
}

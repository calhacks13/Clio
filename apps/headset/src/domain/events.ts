import {
  type CalibrationMethod,
  EPISODE_EVENT_TYPES,
  type EpisodeEventPayload,
  type EpisodeEventType,
  type ObjectState,
  type Procedure,
} from '@clio/protocol';
import type { Emitter } from '../core/emitter';
import type { Pose } from '../core/math';

// The headset's event bus. Recordable events are exactly the protocol's episode events (payload
// plus an absolute `t` on the performance.now() timeline); the recorder rebases `t` to the episode
// start. Internal events coordinate the app but are not part of the dataset.

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

export interface InternalEvents {
  'lesson.phase': Timed<{ phase: LessonPhase; detail?: string }>;
  'plan.requested': Timed<{ goal: string; revision: boolean }>;
  'plan.ready': Timed<{
    planId: string;
    procedure: Procedure;
    warnings: string[];
    revision: boolean;
  }>;
  'plan.failed': Timed<{ goal: string; error: string }>;
  'step.stuck': Timed<{ stepId: string; elapsedMs: number }>;
  'object.missing': Timed<{ objectIds: string[] }>;
  'objects.updated': Timed<{ objects: ObjectState[] }>;
  'overlay.highlight': Timed<{ objectId: string; style: HighlightStyle; source: 'auto' | 'coach' }>;
  'overlay.demo': Timed<{ stepId: string; playing: boolean }>;
  'coach.caption': Timed<{ role: 'user' | 'coach'; text: string; final: boolean }>;
  'workspace.calibrated': Timed<{ method: CalibrationMethod; worldFromWorkspace: Pose }>;
  'recorder.status': Timed<{ recording: boolean; episodeId: string | null; queued: number }>;
}

export type AppEvents = RecordableEvents & InternalEvents;
export type AppBus = Emitter<AppEvents>;

const RECORDABLE = new Set<string>(EPISODE_EVENT_TYPES);
export function isRecordable(type: PropertyKey): type is EpisodeEventType {
  return typeof type === 'string' && RECORDABLE.has(type);
}

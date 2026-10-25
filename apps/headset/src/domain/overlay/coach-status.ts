import type { OverlaySnapshot } from './overlay-model';

// The coach status mark on the instruction panel: whether Clio is connecting, listening, hearing
// the learner, speaking or planning, so the learner always knows (PRODUCT.md principle 3). One state
// at a time, the most urgent first.

export type CoachStatusState =
  | 'offline'
  | 'connecting'
  | 'speaking'
  | 'hearing'
  | 'planning'
  | 'listening';

export interface CoachStatus {
  readonly state: CoachStatusState;
  /** The word or two beside the mark. */
  readonly label: string;
}

// "Speaking", not "Clio": every label says what Clio is doing, and the idle header already reads
// CLIO. Hearing keeps the word "Listening"; only the mark gets livelier.
const STATUS: Readonly<Record<CoachStatusState, CoachStatus>> = {
  offline: { state: 'offline', label: 'Voice offline' },
  connecting: { state: 'connecting', label: 'Connecting' },
  speaking: { state: 'speaking', label: 'Speaking' },
  hearing: { state: 'hearing', label: 'Listening' },
  planning: { state: 'planning', label: 'Planning' },
  listening: { state: 'listening', label: 'Listening' },
};

/**
 * The mark's state, or null when no coach listens (none, or the scripted coach). Read every frame,
 * so it returns shared objects and allocates nothing.
 */
export function coachStatus({
  coach,
  voice,
  phase,
}: Pick<OverlaySnapshot, 'coach' | 'voice' | 'phase'>): CoachStatus | null {
  if (coach === 'off' || voice === 'off') return null;
  if (coach === 'error' || coach === 'closed') return STATUS.offline;
  if (coach === 'connecting' || coach === 'reconnecting') return STATUS.connecting;
  if (voice === 'speaking') return STATUS.speaking;
  if (voice === 'hearing') return STATUS.hearing;
  if (phase === 'planning') return STATUS.planning;
  return STATUS.listening;
}

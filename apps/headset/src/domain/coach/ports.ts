import type { Procedure } from '@clio/protocol';
import type { LessonPhase } from '../events';
import type { PlanView } from '../plan/recital';

/** Port: microphone, delivering PCM16 mono chunks at 16 kHz. */
export interface MicSource {
  start(onChunk: (pcm16k: Int16Array) => void): Promise<void>;
  stop(): void;
}

/** Port: speaker. */
export interface VoiceOutput {
  play(pcm: Int16Array, sampleRate: number): void;
  say(text: string): void;
  /** Stop and discard anything queued (barge-in). */
  stop(): void;
  /**
   * Whether anything played or said is still coming out. Without it, speech counts as over when
   * the model's turn ends.
   */
  playing?(): boolean;
}

/** Port: camera snapshots for the coach (base64 JPEG), or null when unavailable. */
export interface CoachFrameSource {
  snapshot(): Promise<string | null>;
}

/** What the coach layer may know about the current lesson. */
export interface LessonView {
  procedure(): Procedure | null;
  label(objectId: string): string;
  /** The plan with each step's status, or null when no lesson is running. */
  plan(): PlanView | null;
  /** Where the lesson is: idle before the first one and after one is ended, done once finished. */
  phase?(): LessonPhase;
  /** Who completes steps from sensor checks right now (see docs/coach-plan.md). */
  authority?(): 'coach' | 'local';
}

import type { Procedure } from '@clio/protocol';

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
}

/** Port: camera snapshots for the coach (base64 JPEG), or null when unavailable. */
export interface CoachFrameSource {
  snapshot(): Promise<string | null>;
}

/** What the coach layer may know about the current lesson. */
export interface LessonView {
  procedure(): Procedure | null;
  label(objectId: string): string;
}

import type { ActionVerb, ClipFrame } from '@clio/protocol';
import type { Vec3 } from '../../core/math';

/** Frames of ghost-hand motion: recorded (from an expert episode) or synthesized. */
export interface HandClip {
  durationMs: number;
  frames: ClipFrame[];
}

/** Non-hand visual cues drawn alongside a demonstration. Workspace frame. */
export type Glyph =
  | { kind: 'arrow'; from: Vec3; to: Vec3 }
  | { kind: 'arc'; center: Vec3; axis: Vec3; radius: number; angle: number }
  | { kind: 'press'; at: Vec3 }
  | { kind: 'sweep'; from: Vec3; to: Vec3 };

export type DemoMark =
  | 'reach'
  | 'grip'
  | 'lift'
  | 'carry'
  | 'place'
  | 'release'
  | 'pour'
  | 'twist'
  | 'press'
  | 'pull'
  | 'touch'
  | 'wipe'
  | 'fold';

export interface Demonstration {
  stepId: string;
  verb: ActionVerb;
  source: 'synthesized' | 'recorded';
  clip: HandClip;
  glyphs: Glyph[];
  /** When notable moments happen (ms into the clip), for captions and tests. */
  marks: Partial<Record<DemoMark, number>>;
  captions: { t: number; text: string }[];
}

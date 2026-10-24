import { z } from 'zod';
import { HandSampleSchema } from './hand';

// A demo clip is a slice of an expert episode's hand frames for one step, in the workspace frame.
// Because every episode shares the workspace convention, a clip replays correctly on any
// calibrated table: this is what the ghost hands play.

export const CLIP_SCHEMA_ID = 'clio.clip/1';

export const ClipFrameSchema = z.object({
  t: z.number().nonnegative().describe('ms since clip start'),
  left: HandSampleSchema.nullable(),
  right: HandSampleSchema.nullable(),
});

export const DemoClipSchema = z.object({
  schema: z.literal(CLIP_SCHEMA_ID),
  clipId: z.string(),
  procedureId: z.string(),
  procedureVersion: z.number().int(),
  stepId: z.string(),
  source: z.object({
    episodeId: z.string(),
    startT: z.number().nonnegative(),
    endT: z.number().nonnegative(),
  }),
  durationMs: z.number().nonnegative(),
  frames: z.array(ClipFrameSchema).min(2),
});

export type ClipFrame = z.infer<typeof ClipFrameSchema>;
export type DemoClip = z.infer<typeof DemoClipSchema>;

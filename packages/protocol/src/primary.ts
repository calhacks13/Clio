import { z } from 'zod';
import { DetectionSchema, ImagePayloadSchema } from './api';

// "What is the main object in view?" for the primary-object demo: the server asks Gemini to name
// the most prominent object in a camera frame, then the object finder (tracker/: jev confirms it,
// YOLOE-26 outlines it) finds it. POST /api/vision/primary.

export const PrimaryRequestSchema = z.object({
  image: ImagePayloadSchema,
  previous: z
    .object({ name: z.string().min(1) })
    .optional()
    .describe('The last object named, so the name stays stable while it is still in view'),
  known: z
    .object({ name: z.string().min(1), description: z.string().min(1) })
    .optional()
    .describe(
      'Skip naming and find this object (from an earlier answer) right away: only the finder runs',
    ),
  focus: z
    .enum(['object', 'part'])
    .optional()
    .describe(
      "'part' names one meaningful part of the main object (a label, button, wheel) instead of the whole object",
    ),
});
export const PrimaryResponseSchema = z.object({
  name: z
    .string()
    .nullable()
    .describe('Short noun phrase for the main object; null when nothing stands out'),
  description: z.string().nullable().describe('Visual description sent to the object finder'),
  detection: DetectionSchema.nullable().describe('Null when nothing was named or found'),
  model: z.object({ picker: z.string(), finder: z.string() }),
  timings: z.object({
    pickMs: z.number().nonnegative(),
    findMs: z.number().nonnegative(),
  }),
});

export type PrimaryRequest = z.infer<typeof PrimaryRequestSchema>;
export type PrimaryResponse = z.output<typeof PrimaryResponseSchema>;

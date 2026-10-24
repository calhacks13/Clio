import { z } from 'zod';
import { DetectionSchema, ImagePayloadSchema } from './api';

// "What is the main object in view?" for the primary-object demo: the server asks Gemini to name
// the most prominent object in a camera frame, then the object finder (jev boxes refined by SAM
// 2.1) outlines it. POST /api/vision/primary.

export const PrimaryRequestSchema = z.object({
  image: ImagePayloadSchema,
  previous: z
    .object({ name: z.string().min(1) })
    .optional()
    .describe('The last object named, so the name stays stable while it is still in view'),
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

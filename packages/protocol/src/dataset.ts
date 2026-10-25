import { z } from 'zod';

/** Local exports use safe names, never filesystem paths or remote repository URLs. */
export const DatasetExportRequestSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  episodeIds: z
    .array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/))
    .min(1)
    .max(100)
    .refine((ids) => new Set(ids).size === ids.length, 'Select each episode once'),
  fps: z.number().int().min(1).max(120).default(30),
});

export const DatasetExportStatusSchema = z.object({
  id: z.string(),
  name: z.string(),
  episodeCount: z.number().int(),
  fps: z.number().int(),
  state: z.enum(['queued', 'running', 'ready', 'failed']),
  error: z.string().nullable(),
});

export type DatasetExportRequest = z.infer<typeof DatasetExportRequestSchema>;
export type DatasetExportStatus = z.infer<typeof DatasetExportStatusSchema>;

import { z } from 'zod';
import {
  EpisodeFinishSchema,
  EpisodeMetaSchema,
  EpisodeModeSchema,
  EpisodeOutcomeSchema,
} from './episode';
import { NormalizedBoxSchema, NormalizedPointSchema, NormalizedPolygonSchema } from './geometry';
import { ProcedureSchema } from './procedure';

// HTTP contract between the headset and the laptop server. Both sides import these schemas, so a
// mismatch is a type error rather than a 400 at the venue.

const seg = encodeURIComponent;

export const ApiPaths = {
  health: '/api/health',
  coachToken: '/api/coach/token',
  procedures: '/api/procedures',
  procedure: (id: string) => `/api/procedures/${seg(id)}`,
  plans: '/api/plans',
  plan: (id: string) => `/api/plans/${seg(id)}`,
  visionLocate: '/api/vision/locate',
  episodes: '/api/episodes',
  episode: (id: string) => `/api/episodes/${seg(id)}`,
  episodeBatches: (id: string) => `/api/episodes/${seg(id)}/batches`,
  episodeFinish: (id: string) => `/api/episodes/${seg(id)}/finish`,
  episodeMedia: (id: string, name: string) => `/api/episodes/${seg(id)}/media/${seg(name)}`,
  episodeFrames: (id: string) => `/api/episodes/${seg(id)}/frames`,
  episodeEvents: (id: string) => `/api/episodes/${seg(id)}/events`,
  episodeObjects: (id: string) => `/api/episodes/${seg(id)}/objects`,
  clipsFromEpisode: '/api/clips/from-episode',
  clip: (procedureId: string, stepId: string) => `/api/clips/${seg(procedureId)}/${seg(stepId)}`,
} as const;

/** WebSocket prefix of the Gemini Live relay. The SDK's baseUrl points here. */
export const GEMINI_RELAY_PATH = '/gemini';

export const HealthResponseSchema = z.object({
  ok: z.literal(true),
  version: z.string(),
  coach: z.object({
    configured: z.boolean().describe('A Gemini API key is set on the server'),
    liveModel: z.string(),
    relayPath: z.string(),
  }),
});

export const CoachTokenRequestSchema = z.object({ model: z.string().optional() });
export const CoachTokenResponseSchema = z.object({
  token: z.string(),
  expiresAt: z.iso.datetime(),
  model: z.string(),
});

export const ProcedureSummarySchema = z.object({
  id: z.string(),
  version: z.number().int(),
  title: z.string(),
  summary: z.string(),
  stepCount: z.number().int(),
  source: z
    .enum(['curated', 'generated'])
    .describe('curated: procedures/ in the repo. generated: written by the planner (data/plans/)'),
});
export const ProcedureListResponseSchema = z.object({
  procedures: z.array(ProcedureSummarySchema),
});
export const ImagePayloadSchema = z.object({
  mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  data: z.string().min(1).describe('base64, no data: prefix'),
});

export const PlanRequestSchema = z.object({
  goal: z.string().min(3).max(300).describe('What to teach, e.g. "refill windshield washer fluid"'),
  context: z.string().max(2000).optional().describe('What the user said about their setup'),
  images: z.array(ImagePayloadSchema).max(3).default([]).describe('Current camera views'),
  revise: z
    .object({
      planId: z.string(),
      fromStepIndex: z.number().int().nonnegative().describe('Steps before this are kept as-is'),
      reason: z.string().min(1),
    })
    .optional(),
});
export const PlanResponseSchema = z.object({
  planId: z.string(),
  procedure: ProcedureSchema,
  warnings: z.array(z.string()).describe('Non-fatal issues the planner fixed or skipped'),
});

export const LocateRequestSchema = z.object({
  image: ImagePayloadSchema,
  objects: z
    .array(
      z.object({
        id: z.string(),
        query: z.string().min(1).describe('Full visual description of the thing to find'),
        phrase: z
          .string()
          .min(1)
          .optional()
          .describe('Short noun phrase, for detectors that take category-style prompts'),
      }),
    )
    .min(1)
    .max(16),
});
export const DetectionSchema = z.object({
  id: z.string(),
  found: z.boolean(),
  point: NormalizedPointSchema.nullable().describe('Best single point on the object'),
  box: NormalizedBoxSchema.nullable(),
  outline: NormalizedPolygonSchema.nullable()
    .default(null)
    .describe('Segmentation outline, when the object finder provides one'),
  confidence: z.number().min(0).max(1),
});
export const LocateResponseSchema = z.object({
  detections: z.array(DetectionSchema),
  model: z.string(),
  latencyMs: z.number().nonnegative(),
});

export const EpisodeCreateResponseSchema = z.object({ episodeId: z.string() });
export const EpisodeBatchResponseSchema = z.object({
  ok: z.literal(true),
  duplicate: z.boolean(),
});
export const EpisodeFinishResponseSchema = z.object({ ok: z.literal(true) });
export const MediaUploadResponseSchema = z.object({
  ok: z.literal(true),
  name: z.string(),
  bytes: z.number().int().nonnegative(),
});

export const EpisodeSummarySchema = z.object({
  episodeId: z.string(),
  createdAt: z.string(),
  mode: EpisodeModeSchema,
  procedureId: z.string().nullable(),
  finished: z.boolean(),
  outcome: EpisodeOutcomeSchema.nullable(),
  durationMs: z.number().nullable(),
  frameCount: z.number().int(),
  eventCount: z.number().int(),
});
export const EpisodeListResponseSchema = z.object({ episodes: z.array(EpisodeSummarySchema) });
/** What batches.json says arrived. Complete when `finish.batches === received` and no gaps. */
export const EpisodeBatchIntegritySchema = z.object({
  received: z.number().int().nonnegative().describe('Distinct batch seqs stored'),
  gaps: z.array(z.number().int().nonnegative()).describe('Seqs skipped so far, ascending'),
  lastSeq: z.number().int().nonnegative().nullable().describe('Highest seq stored'),
});
export const EpisodeDetailResponseSchema = z.object({
  meta: EpisodeMetaSchema,
  summary: EpisodeSummarySchema,
  finish: EpisodeFinishSchema.nullable(),
  batches: EpisodeBatchIntegritySchema.optional().describe('Absent when the server has no record'),
});

export const ClipsFromEpisodeRequestSchema = z.object({
  episodeId: z.string(),
  stepIds: z.array(z.string()).optional().describe('Defaults to every completed, unforced step'),
});
export const ClipsFromEpisodeResponseSchema = z.object({
  clips: z.array(
    z.object({
      clipId: z.string(),
      stepId: z.string(),
      durationMs: z.number(),
      frameCount: z.number().int(),
    }),
  ),
});

export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;
export type CoachTokenRequest = z.infer<typeof CoachTokenRequestSchema>;
export type CoachTokenResponse = z.infer<typeof CoachTokenResponseSchema>;
export type ProcedureSummary = z.infer<typeof ProcedureSummarySchema>;
export type ProcedureListResponse = z.infer<typeof ProcedureListResponseSchema>;
export type ImagePayload = z.infer<typeof ImagePayloadSchema>;
export type PlanRequest = z.input<typeof PlanRequestSchema>;
export type PlanResponse = z.infer<typeof PlanResponseSchema>;
export type LocateRequest = z.infer<typeof LocateRequestSchema>;
export type Detection = z.output<typeof DetectionSchema>;
export type DetectionInput = z.input<typeof DetectionSchema>;
export type LocateResponse = z.infer<typeof LocateResponseSchema>;
export type EpisodeCreateResponse = z.infer<typeof EpisodeCreateResponseSchema>;
export type EpisodeBatchResponse = z.infer<typeof EpisodeBatchResponseSchema>;
export type EpisodeFinishResponse = z.infer<typeof EpisodeFinishResponseSchema>;
export type MediaUploadResponse = z.infer<typeof MediaUploadResponseSchema>;
export type EpisodeSummary = z.infer<typeof EpisodeSummarySchema>;
export type EpisodeListResponse = z.infer<typeof EpisodeListResponseSchema>;
export type EpisodeBatchIntegrity = z.infer<typeof EpisodeBatchIntegritySchema>;
export type EpisodeDetailResponse = z.infer<typeof EpisodeDetailResponseSchema>;
export type ClipsFromEpisodeRequest = z.infer<typeof ClipsFromEpisodeRequestSchema>;
export type ClipsFromEpisodeResponse = z.infer<typeof ClipsFromEpisodeResponseSchema>;
export type ApiError = z.infer<typeof ApiErrorSchema>;

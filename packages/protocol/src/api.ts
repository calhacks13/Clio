import { z } from 'zod';
import {
  EpisodeFinishSchema,
  EpisodeMetaSchema,
  EpisodeModeSchema,
  EpisodeOutcomeSchema,
} from './episode';
import { ProcedureSchema } from './procedure';

// HTTP contract between the headset and the laptop server. Both sides import these schemas, so a
// mismatch is a type error rather than a 400 at the venue.

const seg = encodeURIComponent;

export const ApiPaths = {
  health: '/api/health',
  coachToken: '/api/coach/token',
  procedures: '/api/procedures',
  procedure: (id: string) => `/api/procedures/${seg(id)}`,
  procedureDraft: '/api/procedures/draft',
  episodes: '/api/episodes',
  episode: (id: string) => `/api/episodes/${seg(id)}`,
  episodeBatches: (id: string) => `/api/episodes/${seg(id)}/batches`,
  episodeFinish: (id: string) => `/api/episodes/${seg(id)}/finish`,
  episodeMedia: (id: string, name: string) => `/api/episodes/${seg(id)}/media/${seg(name)}`,
  episodeFrames: (id: string) => `/api/episodes/${seg(id)}/frames`,
  episodeEvents: (id: string) => `/api/episodes/${seg(id)}/events`,
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
});
export const ProcedureListResponseSchema = z.object({
  procedures: z.array(ProcedureSummarySchema),
});
export const ProcedureDraftRequestSchema = z.object({
  task: z.string().min(3).max(300).describe('What to teach, e.g. "change a bike tire"'),
  notes: z.string().max(2000).optional().describe('Constraints: available objects, safety, etc.'),
});
export const ProcedureDraftResponseSchema = z.object({
  procedure: ProcedureSchema,
  savedAs: z.string().nullable(),
});

export const EpisodeCreateResponseSchema = z.object({ episodeId: z.string() });
export const EpisodeBatchResponseSchema = z.object({
  ok: z.literal(true),
  duplicate: z.boolean(),
});
export const EpisodeFinishResponseSchema = z.object({ ok: z.literal(true) });

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
export const EpisodeDetailResponseSchema = z.object({
  meta: EpisodeMetaSchema,
  summary: EpisodeSummarySchema,
  finish: EpisodeFinishSchema.nullable(),
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
export type ProcedureDraftRequest = z.infer<typeof ProcedureDraftRequestSchema>;
export type ProcedureDraftResponse = z.infer<typeof ProcedureDraftResponseSchema>;
export type EpisodeCreateResponse = z.infer<typeof EpisodeCreateResponseSchema>;
export type EpisodeBatchResponse = z.infer<typeof EpisodeBatchResponseSchema>;
export type EpisodeSummary = z.infer<typeof EpisodeSummarySchema>;
export type EpisodeListResponse = z.infer<typeof EpisodeListResponseSchema>;
export type EpisodeDetailResponse = z.infer<typeof EpisodeDetailResponseSchema>;
export type ClipsFromEpisodeRequest = z.infer<typeof ClipsFromEpisodeRequestSchema>;
export type ClipsFromEpisodeResponse = z.infer<typeof ClipsFromEpisodeResponseSchema>;
export type ApiError = z.infer<typeof ApiErrorSchema>;

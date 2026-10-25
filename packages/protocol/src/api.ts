import { z } from 'zod';
import { CompileManifestSchema } from './derived';
import {
  EpisodeFinishSchema,
  EpisodeMetaSchema,
  EpisodeModeSchema,
  EpisodeOutcomeSchema,
} from './episode';
import { NormalizedBoxSchema, NormalizedPointSchema, NormalizedPolygonSchema } from './geometry';
import { ProcedureSchema } from './procedure';
import { SceneDocSchema } from './scene';

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
  planCheck: '/api/plans/check',
  planCriteria: '/api/plans/criteria',
  visionLocate: '/api/vision/locate',
  sceneAsk: '/api/scene/ask',
  episodes: '/api/episodes',
  episode: (id: string) => `/api/episodes/${seg(id)}`,
  episodeBatches: (id: string) => `/api/episodes/${seg(id)}/batches`,
  episodeFinish: (id: string) => `/api/episodes/${seg(id)}/finish`,
  episodeMedia: (id: string, name: string) => `/api/episodes/${seg(id)}/media/${seg(name)}`,
  episodeFrames: (id: string) => `/api/episodes/${seg(id)}/frames`,
  episodeEvents: (id: string) => `/api/episodes/${seg(id)}/events`,
  episodeObjects: (id: string) => `/api/episodes/${seg(id)}/objects`,
  episodeObservations: (id: string) => `/api/episodes/${seg(id)}/observations`,
  episodeCompile: (id: string) => `/api/episodes/${seg(id)}/compile`,
  episodeDerived: (id: string, name: string) => `/api/episodes/${seg(id)}/derived/${seg(name)}`,
  episodeScene: (id: string, name: string) => `/api/episodes/${seg(id)}/scene/${seg(name)}`,
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

export const PlanStageSchema = z
  .enum(['full', 'first', 'rest'])
  .describe(
    'full: the whole plan at once. first: step 1 in full and the other steps as an outline, so ' +
      'the lesson can start quickly. rest: rewrite the outline steps (from revise.fromStepIndex) ' +
      'in full while the learner works on the first step',
  );

export const PlanRequestSchema = z.object({
  goal: z.string().min(3).max(300).describe('What to teach, e.g. "refill windshield washer fluid"'),
  context: z.string().max(2000).optional().describe('What the user said about their setup'),
  images: z.array(ImagePayloadSchema).max(3).default([]).describe('Current camera views'),
  revise: z
    .object({
      planId: z.string(),
      fromStepIndex: z.number().int().nonnegative().describe('Steps before this are kept as-is'),
      reason: z.string().min(1),
      skippedStepIds: z
        .array(z.string())
        .optional()
        .describe('Kept steps (before fromStepIndex) that were skipped, not done'),
      base: ProcedureSchema.optional().describe(
        'The plan as it stands now, with its done and skipped steps first. Used instead of the ' +
          'stored plan, which lacks the edits the coach made during the lesson',
      ),
    })
    .optional(),
  stage: PlanStageSchema.default('full').describe('rest needs revise'),
});
export const PlanSightingSchema = z
  .object({
    objectId: z.string(),
    view: z.number().int().nonnegative().describe('Index into the request images'),
    point: NormalizedPointSchema,
    box: NormalizedBoxSchema.nullable(),
  })
  .describe('Where the planner saw a declared object in one of the camera views it was given');
export const PlanResponseSchema = z.object({
  planId: z.string(),
  procedure: ProcedureSchema,
  warnings: z.array(z.string()).describe('Non-fatal issues the planner fixed or skipped'),
  outlineFrom: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Steps from this index are an outline, to be rewritten by a stage "rest" request'),
  sightings: z.array(PlanSightingSchema).optional(),
});

export const StepCheckObjectSchema = z.object({
  id: z.string(),
  label: z.string(),
  look: z.string().max(300).describe('What it looks like, so a look-alike is not taken for it'),
});
export const StepCheckRequestSchema = z.object({
  goal: z.string().min(1).max(300),
  step: z.object({
    id: z.string(),
    instruction: z.string().min(1).max(200),
    doneWhen: z.string().max(200).optional(),
  }),
  images: z.array(ImagePayloadSchema).min(1).max(3).describe('Current camera views, newest last'),
  before: z
    .array(ImagePayloadSchema)
    .max(2)
    .optional()
    .describe('Views from when the step started, oldest first, to compare with now'),
  objects: z
    .array(StepCheckObjectSchema)
    .max(6)
    .optional()
    .describe("The step's objects, as they look"),
  confusions: z
    .array(z.string().min(1).max(200))
    .max(4)
    .optional()
    .describe('Mistakes that look like success, e.g. "picking up the milk, not the yogurt drink"'),
  criteria: z
    .array(z.string().min(1).max(200))
    .max(4)
    .optional()
    .describe(
      'What must all be visible for done, from /api/plans/criteria, e.g. "cup A is pink". ' +
        'Each is judged on its own, and the step is done only when every one is met',
    ),
  quick: z
    .boolean()
    .optional()
    .describe(
      'A quick look: less thinking, a sooner answer. The watcher uses one to notice a change ' +
        'while the step is far from done, never to confirm one',
    ),
});
export const StepCheckVerdictSchema = z.enum(['done', 'not_done', 'unsure']);
export const StepCriterionMetSchema = z.enum(['yes', 'no', 'unsure']);
export const StepCheckCriterionSchema = z.object({
  text: z.string(),
  met: StepCriterionMetSchema.describe('unsure: out of view, hidden or too blurred to tell'),
  seen: z.string().optional().describe('What the model saw of it, in a few words'),
});
export const StepCheckResponseSchema = z.object({
  verdict: StepCheckVerdictSchema,
  observation: z.string().describe('What the model saw, in a few words'),
  model: z.string(),
  latencyMs: z.number().nonnegative(),
  progress: z
    .number()
    .int()
    .min(0)
    .max(100)
    .optional()
    .describe('How far along the step looks, in percent'),
  wrong: z
    .string()
    .optional()
    .describe('The learner did something else instead, e.g. "picked up the milk, not the yogurt"'),
  hazard: z
    .string()
    .optional()
    .describe(
      'A danger near the hands right now, whatever the step, e.g. "kitchen knife by cup A"',
    ),
  evidence: z
    .object({ label: z.string(), point: NormalizedPointSchema })
    .nullable()
    .optional()
    .describe('The object that decided the verdict, in the newest view'),
  criteria: z
    .array(StepCheckCriterionSchema)
    .optional()
    .describe("The request's criteria as judged, in order: what is met and what is not yet"),
});
/** The step's done-when as criteria a camera can confirm, asked once when the step gains focus. */
export const StepCriteriaRequestSchema = StepCheckRequestSchema.pick({
  goal: true,
  step: true,
  objects: true,
  confusions: true,
}).extend({
  images: z
    .array(ImagePayloadSchema)
    .max(2)
    .optional()
    .describe('Views from when the step started, so the criteria can say which object is which'),
});
export const StepCriteriaResponseSchema = z.object({
  criteria: z.array(z.string()).min(1).max(4),
  model: z.string(),
  latencyMs: z.number().nonnegative(),
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
  session: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe('One headset run, so a tracking object finder keeps its state per client'),
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
  refreshMs: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      'How soon the finder wants the next frame. A tracking finder sends this: it answers each ' +
        'frame from its own state, so it is cheap to ask often',
    ),
});

export const SceneObjectSchema = z.object({
  id: z.string(),
  label: z.string(),
  look: z.string().max(300).optional().describe('What it looks like'),
});
export const SceneAskRequestSchema = z.object({
  question: z
    .string()
    .min(3)
    .max(300)
    .describe('What the voice coach wants to know, e.g. "Which bottle is the vinegar?"'),
  goal: z.string().max(300).optional().describe('The lesson goal, when a lesson is running'),
  step: z
    .object({
      instruction: z.string().min(1).max(200),
      doneWhen: z.string().max(200).optional(),
    })
    .optional()
    .describe('The step being worked on'),
  objects: z
    .array(SceneObjectSchema)
    .max(16)
    .optional()
    .describe("The lesson's materials, so the answer can say which one it means"),
  images: z.array(ImagePayloadSchema).min(1).max(2).describe('Current camera views, newest last'),
});
export const SceneRefSchema = z
  .object({
    label: z.string().describe('What it is, in a few words'),
    objectId: z.string().nullable().describe('One of the request objects, or null'),
    point: NormalizedPointSchema,
    box: NormalizedBoxSchema.nullable(),
  })
  .describe('Something the answer points out, where it is in the newest view');
export const SceneAskResponseSchema = z.object({
  hazard: z
    .string()
    .nullable()
    .describe('A danger near the hands or the work, whatever the question was, in a few words'),
  answer: z
    .string()
    .describe('At most two short sentences of plain facts, for the coach to say in its own words'),
  refs: z.array(SceneRefSchema).describe('For the AR layer only: never passed on to the coach'),
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
/**
 * none: never compiled; queued / running: a compile is waiting or in progress; ok: compiled from
 * the current raw files; stale: a raw file changed since (for example a repeated finish), or the
 * compile came from an older pipeline whose manifest this server cannot read; failed: the last
 * compile run failed before writing a manifest. `error` can be set with ok or stale too, when a
 * later recompile failed and the previous compile was kept.
 */
export const CompileStateSchema = z.enum(['none', 'queued', 'running', 'ok', 'stale', 'failed']);
export const EpisodeDerivedStatusSchema = z.object({
  state: CompileStateSchema,
  manifest: CompileManifestSchema.nullable().describe('The last successful compile, if any'),
  error: z.string().nullable().describe('Why the last compile run failed'),
});
/**
 * The rebuilt scene (`clio scene`, data/scenes/<id>/), with the same states as a compile: none,
 * never built; queued / running; ok: built from the current compile and media; stale: they changed
 * since; failed: the last build failed before writing scene.json.
 */
export const EpisodeSceneStatusSchema = z.object({
  state: CompileStateSchema,
  scene: SceneDocSchema.nullable().describe('The last successful build, if any'),
  error: z.string().nullable().describe('Why the last build run failed'),
});
export const EpisodeDetailResponseSchema = z.object({
  meta: EpisodeMetaSchema,
  summary: EpisodeSummarySchema,
  finish: EpisodeFinishSchema.nullable(),
  batches: EpisodeBatchIntegritySchema.optional().describe('Absent when the server has no record'),
  derived: EpisodeDerivedStatusSchema.optional()
    .catch(undefined)
    .describe('Absent from servers older than compiling; unreadable compile state is dropped'),
  scene: EpisodeSceneStatusSchema.optional()
    .catch(undefined)
    .describe('Absent from servers older than scene builds; unreadable scene state is dropped'),
});
export const EpisodeCompileResponseSchema = z.object({
  ok: z.literal(true),
  state: CompileStateSchema,
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
export type PlanStage = z.infer<typeof PlanStageSchema>;
export type PlanSighting = z.infer<typeof PlanSightingSchema>;
export type PlanRequest = z.input<typeof PlanRequestSchema>;
export type PlanResponse = z.infer<typeof PlanResponseSchema>;
export type StepCheckObject = z.infer<typeof StepCheckObjectSchema>;
export type StepCheckRequest = z.infer<typeof StepCheckRequestSchema>;
export type StepCheckVerdict = z.infer<typeof StepCheckVerdictSchema>;
export type StepCheckResponse = z.infer<typeof StepCheckResponseSchema>;
export type StepCriterionMet = z.infer<typeof StepCriterionMetSchema>;
export type StepCheckCriterion = z.infer<typeof StepCheckCriterionSchema>;
export type StepCriteriaRequest = z.infer<typeof StepCriteriaRequestSchema>;
export type StepCriteriaResponse = z.infer<typeof StepCriteriaResponseSchema>;
export type LocateRequest = z.infer<typeof LocateRequestSchema>;
export type Detection = z.output<typeof DetectionSchema>;
export type DetectionInput = z.input<typeof DetectionSchema>;
export type LocateResponse = z.infer<typeof LocateResponseSchema>;
export type SceneObject = z.infer<typeof SceneObjectSchema>;
export type SceneAskRequest = z.infer<typeof SceneAskRequestSchema>;
export type SceneRef = z.infer<typeof SceneRefSchema>;
export type SceneAskResponse = z.infer<typeof SceneAskResponseSchema>;
export type EpisodeCreateResponse = z.infer<typeof EpisodeCreateResponseSchema>;
export type EpisodeBatchResponse = z.infer<typeof EpisodeBatchResponseSchema>;
export type EpisodeFinishResponse = z.infer<typeof EpisodeFinishResponseSchema>;
export type MediaUploadResponse = z.infer<typeof MediaUploadResponseSchema>;
export type EpisodeSummary = z.infer<typeof EpisodeSummarySchema>;
export type EpisodeListResponse = z.infer<typeof EpisodeListResponseSchema>;
export type EpisodeBatchIntegrity = z.infer<typeof EpisodeBatchIntegritySchema>;
export type EpisodeDetailResponse = z.infer<typeof EpisodeDetailResponseSchema>;
export type CompileState = z.infer<typeof CompileStateSchema>;
export type EpisodeDerivedStatus = z.infer<typeof EpisodeDerivedStatusSchema>;
export type EpisodeSceneStatus = z.infer<typeof EpisodeSceneStatusSchema>;
export type EpisodeCompileResponse = z.infer<typeof EpisodeCompileResponseSchema>;
export type ClipsFromEpisodeRequest = z.infer<typeof ClipsFromEpisodeRequestSchema>;
export type ClipsFromEpisodeResponse = z.infer<typeof ClipsFromEpisodeResponseSchema>;
export type ApiError = z.infer<typeof ApiErrorSchema>;

import { z } from 'zod';
import {
  ImagePayloadSchema,
  PlanRequestSchema,
  PlanSightingSchema,
  PlanStageSchema,
  StepCheckRequestSchema,
} from './api';
import { SlugSchema } from './checks';
import { ProcedureSchema } from './procedure';

// The planner bench: a laptop page (apps/headset/bench.html) and a CLI (`pnpm bench`) that put the
// planner in front of real scenes from a webcam. A scenario is one planner request (goal, what the
// learner said, the camera views, and for a re-plan the plan so far) plus what a correct plan must
// do. Runs are the planner's answers to it, graded by the tester and optionally by a judge model.
// A development tool: none of this is recorded in episodes.

const seg = encodeURIComponent;

export const BenchPaths = {
  models: '/api/bench/models',
  plan: '/api/bench/plan',
  check: '/api/bench/check',
  scenarios: '/api/bench/scenarios',
  scenario: (id: string) => `/api/bench/scenarios/${seg(id)}`,
  scenarioView: (id: string, n: number) => `/api/bench/scenarios/${seg(id)}/views/${n}`,
  scenarioRuns: (id: string) => `/api/bench/scenarios/${seg(id)}/runs`,
  scenarioRun: (id: string, runId: string) => `/api/bench/scenarios/${seg(id)}/runs/${seg(runId)}`,
  scenarioRunJudge: (id: string, runId: string) =>
    `/api/bench/scenarios/${seg(id)}/runs/${seg(runId)}/judge`,
} as const;

const ModelNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/, 'use a Gemini model name, e.g. "gemini-3.5-flash"');

export const BenchModelsResponseSchema = z.object({
  plannerModel: z.string().describe('The model the headset plans with (GEMINI_PLANNER_MODEL)'),
  judgeModel: z.string().describe('The default judge (GEMINI_JUDGE_MODEL)'),
  models: z.array(z.string()).describe('Gemini models this key can run'),
});

const BudgetSchema = z
  .number()
  .int()
  .min(10_000)
  .max(300_000)
  .describe("Time for the draft and its retry; the headset's is 40 s");

/** A plan request from the bench: the headset's request plus the model to ask. */
export const BenchPlanRequestSchema = PlanRequestSchema.extend({
  model: ModelNameSchema.optional().describe('Defaults to the planner model'),
  budgetMs: BudgetSchema.optional(),
});
export const BenchCheckRequestSchema = StepCheckRequestSchema.extend({
  model: ModelNameSchema.optional().describe('Defaults to the planner model'),
});

export const BenchGradeSchema = z.enum(['pass', 'partial', 'fail']);

export const BenchVerdictSchema = z
  .object({
    grade: BenchGradeSchema,
    notes: z.string().max(2000).optional(),
    at: z.iso.datetime(),
  })
  .describe("The tester's grade for one run");

export const BenchJudgementSchema = z
  .object({
    model: z.string(),
    latencyMs: z.number().nonnegative(),
    at: z.iso.datetime(),
    criteria: z.array(z.object({ expectation: z.string(), met: z.boolean(), reason: z.string() })),
    issues: z.array(z.string()).describe('Other serious problems the judge noticed'),
    passed: z.boolean().describe('Every expectation is met'),
  })
  .describe("A judge model's reading of one run against the scenario's expectations");

export const BenchRunResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    planId: z.string(),
    procedure: ProcedureSchema,
    warnings: z.array(z.string()),
    outlineFrom: z.number().int().nonnegative().optional(),
    sightings: z.array(PlanSightingSchema).optional(),
  }),
  z.object({
    ok: z.literal(false),
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
]);

export const BenchRunSchema = z.object({
  id: z.string(),
  createdAt: z.iso.datetime(),
  model: z.string(),
  latencyMs: z.number().nonnegative(),
  budgetMs: z.number().int().optional().describe('Set when the run had more time than the headset'),
  attempts: z
    .number()
    .int()
    .nonnegative()
    .describe('Planner calls: 2 when the first draft failed validation and was retried'),
  firstAttemptErrors: z
    .string()
    .optional()
    .describe('Why the first draft failed validation, when it was retried'),
  request: z
    .object({
      goal: z.string(),
      context: z.string().optional(),
      revise: z
        .object({ fromStepIndex: z.number().int().nonnegative(), reason: z.string() })
        .optional(),
      stage: PlanStageSchema.optional(),
      views: z.number().int().nonnegative(),
    })
    .describe('What was asked, as it was asked'),
  result: BenchRunResultSchema,
  verdict: BenchVerdictSchema.optional(),
  judgement: BenchJudgementSchema.optional(),
});

/** A re-plan: the plan so far, and from which step it changes. */
export const BenchReviseSchema = z.object({
  base: ProcedureSchema.describe('The plan being revised, done and skipped steps first'),
  fromStepIndex: z.number().int().nonnegative(),
  reason: z.string().min(1).max(300),
  skippedStepIds: z.array(z.string()).optional(),
});

const ExpectSchema = z
  .array(z.string().trim().min(1).max(300))
  .max(20)
  .describe('What a correct plan must (or must not) do in this scene, one per line');

export const BenchScenarioSchema = z.object({
  id: SlugSchema,
  title: z.string().trim().min(1).max(120),
  goal: z.string().min(3).max(300),
  context: z.string().max(2000).optional(),
  revise: BenchReviseSchema.optional(),
  expect: ExpectSchema,
  tags: z.array(SlugSchema).max(10),
  views: z.array(z.object({ file: z.string(), mimeType: ImagePayloadSchema.shape.mimeType })),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const BenchScenarioCreateSchema = z.object({
  title: BenchScenarioSchema.shape.title,
  goal: BenchScenarioSchema.shape.goal,
  context: BenchScenarioSchema.shape.context,
  revise: BenchReviseSchema.optional(),
  expect: ExpectSchema.default([]),
  tags: z.array(SlugSchema).max(10).default([]),
  images: z.array(ImagePayloadSchema).min(1).max(3),
  runs: z.array(BenchRunSchema).max(50).default([]).describe('Runs made before it was saved'),
});

export const BenchScenarioUpdateSchema = z.object({
  title: BenchScenarioSchema.shape.title.optional(),
  goal: BenchScenarioSchema.shape.goal.optional(),
  context: z.string().max(2000).nullable().optional().describe('null clears it'),
  expect: ExpectSchema.optional(),
  tags: z.array(SlugSchema).max(10).optional(),
});

export const BenchScenarioSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  goal: z.string(),
  tags: z.array(z.string()),
  revising: z.boolean(),
  expectCount: z.number().int(),
  views: z.number().int(),
  createdAt: z.string(),
  runCount: z.number().int(),
  lastRun: z
    .object({
      model: z.string(),
      createdAt: z.string(),
      ok: z.boolean(),
      grade: BenchGradeSchema.optional(),
      judged: z.boolean(),
      passed: z.boolean().optional(),
    })
    .nullable(),
});

export const BenchScenarioListResponseSchema = z.object({
  scenarios: z.array(BenchScenarioSummarySchema),
});
export const BenchScenarioDetailSchema = z.object({
  scenario: BenchScenarioSchema,
  runs: z.array(BenchRunSchema).describe('Newest first'),
});

export const BenchRunScenarioRequestSchema = z.object({
  model: ModelNameSchema.optional(),
  budgetMs: BudgetSchema.optional(),
});
export const BenchRunUpdateSchema = z.object({
  verdict: BenchVerdictSchema.omit({ at: true }).nullable().describe('null clears it'),
});
export const BenchJudgeRequestSchema = z.object({ model: ModelNameSchema.optional() });

export type BenchModelsResponse = z.infer<typeof BenchModelsResponseSchema>;
export type BenchPlanRequest = z.input<typeof BenchPlanRequestSchema>;
export type BenchCheckRequest = z.input<typeof BenchCheckRequestSchema>;
export type BenchGrade = z.infer<typeof BenchGradeSchema>;
export type BenchVerdict = z.infer<typeof BenchVerdictSchema>;
export type BenchJudgement = z.infer<typeof BenchJudgementSchema>;
export type BenchRunResult = z.output<typeof BenchRunResultSchema>;
export type BenchRun = z.output<typeof BenchRunSchema>;
export type BenchRevise = z.output<typeof BenchReviseSchema>;
export type BenchScenario = z.output<typeof BenchScenarioSchema>;
export type BenchScenarioCreate = z.input<typeof BenchScenarioCreateSchema>;
export type BenchScenarioUpdate = z.input<typeof BenchScenarioUpdateSchema>;
export type BenchScenarioSummary = z.infer<typeof BenchScenarioSummarySchema>;
export type BenchScenarioListResponse = z.infer<typeof BenchScenarioListResponseSchema>;
export type BenchScenarioDetail = z.output<typeof BenchScenarioDetailSchema>;
export type BenchRunUpdate = z.input<typeof BenchRunUpdateSchema>;

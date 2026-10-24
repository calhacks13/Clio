import type {
  BenchJudgement,
  BenchRun,
  BenchRunResult,
  BenchScenario,
  ImagePayload,
} from '@clio/protocol';
import { ApiError, upstreamFailed } from '../errors';
import { newRunId } from '../ids';
import { describeError } from '../log';
import type { ProcedureStore } from '../storage/procedure-store';
import { type BenchJudge, parseJudgement } from './bench-judge';
import type { GenerateContentApi, ModelListApi } from './gemini';
import { createGeminiJudge } from './gemini-judge';
import { createGeminiPlanner, type GeminiPlannerOptions } from './gemini-planner';
import type { RestPartReport } from './plan-rest';
import { generatePlan, type PlanRequestBody, type RestMode } from './plan-service';
import type { Planner } from './planner';

// The planner bench (docs/planner-bench.md): runs the headset's own planning path (prompt,
// validation, retry) with any model and records what happened, so a failure is a result to look
// at rather than an error. Used by the /api/bench routes and by `pnpm bench`.

/** The Gemini side of the bench: a planner or a judge on any model, and the models to offer. */
export interface BenchModels {
  /** The model the headset plans with. */
  readonly plannerModel: string;
  readonly judgeModel: string;
  planner(model: string, options?: GeminiPlannerOptions): Planner;
  judge(model: string): BenchJudge;
  /** Models this key can plan with, newest first. */
  list(): Promise<string[]>;
}

const MODEL_LIST_TTL_MS = 10 * 60_000;
/** Speech, image, music and agent models can't write a plan. */
const NOT_FOR_PLANNING =
  /tts|image|banana|lyria|transcribe|live|embedding|computer-use|deep-research|antigravity|aqa|omni/;

/** Gemini text models from a model listing, plus `always` (the configured ones), newest first. */
export function plannerModelNames(names: Iterable<string>, always: readonly string[]): string[] {
  const keep = new Set(always);
  for (const raw of names) {
    const name = raw.replace(/^models\//, '');
    if (name.startsWith('gemini-') && !NOT_FOR_PLANNING.test(name)) keep.add(name);
  }
  return [...keep].sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
}

export function createBenchModels(
  ai: GenerateContentApi & ModelListApi,
  models: { plannerModel: string; judgeModel: string },
): BenchModels {
  const { plannerModel, judgeModel } = models;
  let cached: { at: number; names: string[] } | null = null;
  return {
    plannerModel,
    judgeModel,
    planner: (model, options) => createGeminiPlanner(ai, model, options),
    judge: (model) => createGeminiJudge(ai, model),
    async list() {
      if (cached && Date.now() - cached.at < MODEL_LIST_TTL_MS) return cached.names;
      const names: string[] = [];
      for await (const m of await ai.models.list({ config: { pageSize: 200 } })) {
        if (m.name && m.supportedActions?.includes('generateContent')) names.push(m.name);
      }
      cached = { at: Date.now(), names: plannerModelNames(names, [plannerModel, judgeModel]) };
      return cached.names;
    },
  };
}

export interface BenchPlanDeps {
  planner: Planner;
  /** Where the bench's plans are stored, apart from the headset's. */
  plans: ProcedureStore;
  now: () => Date;
  rand?: () => number;
  /** More time than the headset's 40 s, for slow models. */
  budgetMs?: number;
  /** How stage rest is written, to compare one call with the parallel parts. */
  rest?: RestMode;
  onRestPart?: (report: RestPartReport) => void;
}

/**
 * One planner request through the same path as POST /api/plans. A plan the server rejects (twice
 * invalid, timed out, upstream error) is a failed run, not a thrown error.
 */
export async function benchPlan(deps: BenchPlanDeps, body: PlanRequestBody): Promise<BenchRun> {
  const { planner, calls } = counting(deps.planner);
  const started = deps.now();
  let result: BenchRunResult;
  try {
    const plan = await generatePlan(
      {
        planner,
        procedures: deps.plans,
        now: deps.now,
        budgetMs: deps.budgetMs,
        rest: deps.rest,
        onRestPart: deps.onRestPart,
      },
      body,
    );
    const { planId, procedure, warnings, outlineFrom, sightings } = plan;
    result = {
      ok: true,
      planId,
      procedure,
      warnings,
      ...(outlineFrom === undefined ? {} : { outlineFrom }),
      ...(sightings ? { sightings } : {}),
    };
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    result = { ok: false, code: error.code, message: error.message };
    if (error.details !== undefined) result.details = error.details;
  }
  const { goal, context, revise, images, stage } = body;
  return {
    id: newRunId(started, deps.rand),
    createdAt: started.toISOString(),
    model: deps.planner.model,
    latencyMs: Math.max(0, deps.now().getTime() - started.getTime()),
    ...(deps.budgetMs === undefined ? {} : { budgetMs: deps.budgetMs }),
    attempts: calls.attempts,
    ...(calls.firstErrors === undefined ? {} : { firstAttemptErrors: calls.firstErrors }),
    request: {
      goal,
      ...(context ? { context } : {}),
      ...(revise ? { revise: { fromStepIndex: revise.fromStepIndex, reason: revise.reason } } : {}),
      ...(stage === 'full' ? {} : { stage }),
      views: images.length,
    },
    result,
  };
}

/** Counts the planner's calls and keeps the validation errors that caused a retry. */
function counting(inner: Planner) {
  const calls: { attempts: number; firstErrors?: string } = { attempts: 0 };
  const planner: Planner = {
    model: inner.model,
    draft(request) {
      calls.attempts++;
      if (request.retry && calls.firstErrors === undefined)
        calls.firstErrors = request.retry.errors;
      return inner.draft(request);
    },
  };
  return { planner, calls };
}

/**
 * The scenario as the headset would have asked it: the whole plan, or with `staged` its first
 * stage (a re-plan scenario is always asked whole, as revise_plan does).
 */
export function scenarioPlanRequest(
  scenario: BenchScenario,
  images: ImagePayload[],
  { staged = false } = {},
): PlanRequestBody {
  const { goal, context, revise } = scenario;
  return {
    goal,
    ...(context ? { context } : {}),
    images,
    stage: staged && !revise ? 'first' : 'full',
    ...(revise
      ? {
          revise: {
            planId: revise.base.id,
            fromStepIndex: revise.fromStepIndex,
            reason: revise.reason,
            ...(revise.skippedStepIds ? { skippedStepIds: revise.skippedStepIds } : {}),
            base: revise.base,
          },
        }
      : {}),
  };
}

/**
 * After a stage first run with an outline, the stage rest request the headset sends while the
 * learner does the first step; null when there is nothing to write out.
 */
export function restPlanRequest(first: PlanRequestBody, run: BenchRun): PlanRequestBody | null {
  const { result } = run;
  if (!result.ok || result.outlineFrom === undefined) return null;
  return {
    goal: first.goal,
    ...(first.context ? { context: first.context } : {}),
    images: first.images,
    stage: 'rest',
    revise: {
      planId: result.planId,
      fromStepIndex: result.outlineFrom,
      reason: 'Write the outline steps in full while the learner does the first step',
      base: result.procedure,
    },
  };
}

/** Grades a run's plan against the scenario's expectations, as they stand now. */
export async function judgeRun(
  judge: BenchJudge,
  scenario: BenchScenario,
  run: BenchRun,
  images: ImagePayload[],
  now: () => Date,
): Promise<BenchJudgement> {
  if (!run.result.ok) {
    throw new ApiError(409, 'nothing_to_judge', 'This run has no plan to judge');
  }
  if (!scenario.expect.length) {
    throw new ApiError(
      409,
      'no_expectations',
      'The scenario has no expectations: write what a correct plan must do first',
    );
  }
  const started = now();
  let text: string;
  try {
    text = await judge.judge({
      scenario,
      procedure: run.result.procedure,
      warnings: run.result.warnings,
      images,
    });
  } catch (error) {
    throw upstreamFailed(`The judge failed: ${describeError(error)}`);
  }
  let answer: ReturnType<typeof parseJudgement>;
  try {
    answer = parseJudgement(text, scenario.expect);
  } catch (error) {
    throw upstreamFailed(`The judge gave an unusable answer: ${describeError(error)}`);
  }
  return {
    model: judge.model,
    latencyMs: Math.max(0, now().getTime() - started.getTime()),
    at: started.toISOString(),
    ...answer,
  };
}

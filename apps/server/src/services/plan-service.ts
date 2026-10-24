import {
  type PlanRequestSchema,
  type PlanResponse,
  type PlanSighting,
  type Procedure,
  safeParseProcedure,
} from '@clio/protocol';
import type { z } from 'zod';
import { ApiError, notFound, upstreamFailed } from '../errors';
import { describeError } from '../log';
import type { ProcedureStore } from '../storage/procedure-store';
import { parseModelJson } from './model-json';
import {
  buildFirstStageCandidate,
  buildPlanCandidate,
  type Candidate,
  mergeRevision,
} from './plan-build';
import { goalIdCandidates, revisionIdCandidates, slugFromGoal } from './plan-ids';
import type { Planner, PlannerRequest } from './planner';

// POST /api/plans: ask the planner, validate with the procedure schema, retry once with the
// readable errors, and store the plan under a fresh id. Revisions keep the steps already done or
// skipped, of the plan as the headset sends it (`revise.base`, with the coach's edits) or as
// stored. The draft and its retry share one time budget.
//
// A plan comes whole (stage full) or in two stages: stage first writes the first step in full and
// the rest as an outline, so the lesson starts quickly; stage rest then writes the outline in full
// as a revision of that plan, while the learner works on the first step (docs/coach-plan.md).

export type PlanRequestBody = z.output<typeof PlanRequestSchema>;

export interface PlanServiceDeps {
  planner: Planner;
  procedures: ProcedureStore;
  now: () => Date;
  /** The draft and its retry together; the planner bench may allow slow models more. */
  budgetMs?: number;
}

/**
 * One POST /api/plans, draft and retry together. The headset gives up 5 s later (45 s from the
 * coach's call, which also covers capturing and uploading the camera views), so this answers first.
 */
export const PLAN_BUDGET_MS = 40_000;
/** Stage rest: nobody waits for it, so it has time to think and still retry. */
export const REST_BUDGET_MS = 60_000;
/** With less of the budget left than this, an invalid draft fails instead of being retried. */
export const MIN_RETRY_MS = 10_000;

interface Drafted {
  procedure: Procedure;
  warnings: string[];
  sightings: PlanSighting[];
  outlineFrom?: number;
}

type Checked = ({ ok: true } & Drafted) | { ok: false; error: string };

export async function generatePlan(
  deps: PlanServiceDeps,
  body: PlanRequestBody,
): Promise<PlanResponse> {
  const { planner, procedures } = deps;
  const { stage } = body;
  if (stage === 'rest' && !body.revise) {
    throw new ApiError(400, 'invalid_stage', 'Stage "rest" needs revise: the plan to write out');
  }
  if (stage === 'first' && body.revise) {
    throw new ApiError(400, 'invalid_stage', 'Stage "first" starts a plan; it cannot revise one');
  }
  const started = deps.now();
  const createdAt = started.toISOString();
  const budget = deps.budgetMs ?? (stage === 'rest' ? REST_BUDGET_MS : PLAN_BUDGET_MS);
  const deadline = started.getTime() + budget;
  const timeLeft = () => deadline - deps.now().getTime();
  const request: PlannerRequest = { goal: body.goal, images: body.images };
  if (body.context) request.context = body.context;
  if (stage !== 'full') request.stage = stage;

  if (!body.revise) {
    const ctx = {
      id: slugFromGoal(body.goal),
      goal: body.goal,
      model: planner.model,
      createdAt,
      views: body.images.length,
    };
    const build = stage === 'first' ? buildFirstStageCandidate : buildPlanCandidate;
    const draft = await draftValidPlan(planner, request, timeLeft, (output) => build(output, ctx));
    const saved = await procedures.savePlan(draft.procedure, goalIdCandidates(ctx.id));
    return {
      planId: saved.id,
      procedure: saved,
      warnings: draft.warnings,
      ...(draft.outlineFrom === undefined ? {} : { outlineFrom: draft.outlineFrom }),
      sightings: draft.sightings,
    };
  }

  const { planId, fromStepIndex, reason, skippedStepIds = [] } = body.revise;
  const base = body.revise.base ?? (await procedures.get(planId));
  if (!base) throw notFound(`No plan "${planId}" to revise`);
  const from = Math.min(fromStepIndex, base.steps.length);
  const notes =
    from < fromStepIndex
      ? [`fromStepIndex ${fromStepIndex} is past the end of the plan; kept all ${from} steps`]
      : [];
  const ctx = {
    // A valid slug for validation; savePlan picks the final free id. Named after the plan being
    // revised: a sent base keeps the id its lesson started with.
    id: revisionIdCandidates(planId).next().value,
    goal: body.goal,
    model: planner.model,
    createdAt,
    revisionOf: planId,
  };
  const draft = await draftValidPlan(
    planner,
    { ...request, revision: { reason, base, fromStepIndex: from, skippedStepIds } },
    timeLeft,
    (output) => mergeRevision(base, output, from, ctx),
  );
  const saved = await procedures.savePlan(draft.procedure, revisionIdCandidates(planId));
  return { planId: saved.id, procedure: saved, warnings: [...notes, ...draft.warnings] };
}

async function draftValidPlan(
  planner: Planner,
  request: PlannerRequest,
  timeLeft: () => number,
  build: (output: unknown) => Candidate,
): Promise<Drafted> {
  const first = await ask(planner, { ...request, timeoutMs: timeLeft() });
  const checked = check(first, build);
  if (checked.ok) return checked;
  const timeoutMs = timeLeft();
  if (timeoutMs < MIN_RETRY_MS) {
    throw new ApiError(
      504,
      'plan_timeout',
      'The planner ran out of time: its plan was invalid and too little time was left to retry',
      { errors: checked.error },
    );
  }
  const second = await ask(planner, {
    ...request,
    timeoutMs,
    retry: { previousText: first, errors: checked.error },
  });
  const rechecked = check(second, build);
  if (rechecked.ok) return rechecked;
  throw new ApiError(502, 'plan_invalid', 'The planner returned an invalid plan twice', {
    errors: rechecked.error,
  });
}

function check(text: string, build: (output: unknown) => Candidate): Checked {
  const json = parseModelJson(text);
  if (!json.ok) return json;
  const { candidate, ...beside } = build(json.value);
  const parsed = safeParseProcedure(candidate);
  return parsed.ok
    ? { ok: true, procedure: parsed.procedure, ...beside }
    : { ok: false, error: parsed.error };
}

async function ask(planner: Planner, request: PlannerRequest): Promise<string> {
  try {
    return await planner.draft(request);
  } catch (error) {
    throw upstreamFailed(`Planner request failed: ${describeError(error)}`);
  }
}

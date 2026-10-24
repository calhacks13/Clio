import {
  type PlanRequestSchema,
  type PlanResponse,
  type Procedure,
  safeParseProcedure,
} from '@clio/protocol';
import type { z } from 'zod';
import { ApiError, notFound, upstreamFailed } from '../errors';
import { describeError } from '../log';
import type { ProcedureStore } from '../storage/procedure-store';
import { parseModelJson } from './model-json';
import { buildPlanCandidate, type Candidate, mergeRevision } from './plan-build';
import { goalIdCandidates, revisionIdCandidates, slugFromGoal } from './plan-ids';
import type { Planner, PlannerRequest } from './planner';

// POST /api/plans: ask the planner, validate with the procedure schema, retry once with the
// readable errors, and store the plan under a fresh id. Revisions keep the steps already done.

export type PlanRequestBody = z.output<typeof PlanRequestSchema>;

export interface PlanServiceDeps {
  planner: Planner;
  procedures: ProcedureStore;
  now: () => Date;
}

type Checked =
  | { ok: true; procedure: Procedure; warnings: string[] }
  | { ok: false; error: string };

export async function generatePlan(
  deps: PlanServiceDeps,
  body: PlanRequestBody,
): Promise<PlanResponse> {
  const { planner, procedures } = deps;
  const createdAt = deps.now().toISOString();
  const request: PlannerRequest = { goal: body.goal, images: body.images };
  if (body.context) request.context = body.context;

  if (!body.revise) {
    const ctx = { id: slugFromGoal(body.goal), goal: body.goal, model: planner.model, createdAt };
    const draft = await draftValidPlan(planner, request, (output) =>
      buildPlanCandidate(output, ctx),
    );
    const saved = await procedures.savePlan(draft.procedure, goalIdCandidates(ctx.id));
    return { planId: saved.id, procedure: saved, warnings: draft.warnings };
  }

  const { planId, fromStepIndex, reason } = body.revise;
  const base = await procedures.get(planId);
  if (!base) throw notFound(`No plan "${planId}" to revise`);
  const from = Math.min(fromStepIndex, base.steps.length);
  const notes =
    from < fromStepIndex
      ? [`fromStepIndex ${fromStepIndex} is past the end of the plan; kept all ${from} steps`]
      : [];
  const ctx = {
    // A valid slug for validation; savePlan picks the final free id.
    id: revisionIdCandidates(base.id).next().value,
    goal: body.goal,
    model: planner.model,
    createdAt,
    revisionOf: base.id,
  };
  const draft = await draftValidPlan(
    planner,
    { ...request, revision: { reason, base, fromStepIndex: from } },
    (output) => mergeRevision(base, output, from, ctx),
  );
  const saved = await procedures.savePlan(draft.procedure, revisionIdCandidates(base.id));
  return { planId: saved.id, procedure: saved, warnings: [...notes, ...draft.warnings] };
}

async function draftValidPlan(
  planner: Planner,
  request: PlannerRequest,
  build: (output: unknown) => Candidate,
): Promise<{ procedure: Procedure; warnings: string[] }> {
  const first = await ask(planner, request);
  const checked = check(first, build);
  if (checked.ok) return checked;
  const second = await ask(planner, {
    ...request,
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
  const { candidate, warnings } = build(json.value);
  const parsed = safeParseProcedure(candidate);
  return parsed.ok
    ? { ok: true, procedure: parsed.procedure, warnings }
    : { ok: false, error: parsed.error };
}

async function ask(planner: Planner, request: PlannerRequest): Promise<string> {
  try {
    return await planner.draft(request);
  } catch (error) {
    throw upstreamFailed(`Planner request failed: ${describeError(error)}`);
  }
}

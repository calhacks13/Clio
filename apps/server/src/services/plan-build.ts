import { PROCEDURE_SCHEMA_ID, type Procedure, type Step } from '@clio/protocol';
import { isRecord, type Json } from './model-json';

// Pure: turns the planner model's JSON into a procedure candidate for safeParseProcedure.
// The server owns identity and provenance (schema, id, version, origin); the model owns content.

export interface PlanContext {
  id: string;
  goal: string;
  model: string;
  createdAt: string;
  revisionOf?: string;
}

export interface Candidate {
  /** Not yet validated: run it through safeParseProcedure. */
  candidate: Record<string, unknown>;
  /** The model's safety caveats and assumptions. */
  warnings: string[];
}

const DEFAULT_WORKSPACE = { size: [0.8, 0.6] };

function provenance(ctx: PlanContext) {
  const origin: Json = {
    kind: 'generated',
    goal: ctx.goal,
    model: ctx.model,
    createdAt: ctx.createdAt,
  };
  if (ctx.revisionOf) origin.revisionOf = ctx.revisionOf;
  return { schema: PROCEDURE_SCHEMA_ID, id: ctx.id, version: 1, origin };
}

function modelWarnings(output: Json): string[] {
  if (!Array.isArray(output.warnings)) return [];
  return output.warnings
    .filter((w): w is string => typeof w === 'string')
    .map((w) => w.trim())
    .filter((w) => w !== '');
}

/** A new task has no measured layout, so every object is found by the camera. */
function detected(object: unknown): unknown {
  if (!isRecord(object)) return object;
  const placement = isRecord(object.placement) ? object.placement : {};
  const hint = typeof placement.hint === 'string' ? placement.hint.trim() : '';
  return { ...object, placement: hint ? { method: 'detect', hint } : { method: 'detect' } };
}

export function buildPlanCandidate(output: unknown, ctx: PlanContext): Candidate {
  const o = isRecord(output) ? output : {};
  const { warnings: _w, schema: _s, id: _i, version: _v, origin: _o, ...content } = o;
  return {
    candidate: {
      ...provenance(ctx),
      ...content,
      workspace: isRecord(content.workspace) ? content.workspace : DEFAULT_WORKSPACE,
      objects: Array.isArray(content.objects) ? content.objects.map(detected) : content.objects,
    },
    warnings: modelWarnings(o),
  };
}

/** Renames new steps whose id is already used (by a kept step or an earlier new one). */
function uniqueStepIds(kept: readonly Step[], fresh: readonly unknown[]): unknown[] {
  const taken = new Set(kept.map((s) => s.id));
  return fresh.map((step) => {
    if (!isRecord(step) || typeof step.id !== 'string') return step;
    let id = step.id;
    for (let n = 2; taken.has(id); n++) id = `${step.id}-${n}`;
    taken.add(id);
    return id === step.id ? step : { ...step, id };
  });
}

/**
 * Revision: the base plan's steps before `fromStepIndex` stay verbatim, the model's steps follow.
 * Objects are the base objects plus any new ids the model declared. Everything else (title,
 * workspace, coach) comes from the base plan.
 */
export function mergeRevision(
  base: Procedure,
  output: unknown,
  fromStepIndex: number,
  ctx: PlanContext,
): Candidate {
  const o = isRecord(output) ? output : {};
  const known = new Set(base.objects.map((obj) => obj.id));
  const added = (Array.isArray(o.objects) ? o.objects : []).map(detected).filter((obj) => {
    if (!isRecord(obj) || typeof obj.id !== 'string') return true;
    if (known.has(obj.id)) return false;
    known.add(obj.id);
    return true;
  });
  const kept = base.steps.slice(0, fromStepIndex);
  return {
    candidate: {
      ...provenance(ctx),
      title: base.title,
      summary: base.summary,
      domain: base.domain,
      workspace: base.workspace,
      objects: [...base.objects, ...added],
      // A missing steps array stays invalid so validation (and the retry) catches it.
      steps: Array.isArray(o.steps) ? [...kept, ...uniqueStepIds(kept, o.steps)] : o.steps,
      coach: base.coach,
    },
    warnings: modelWarnings(o),
  };
}

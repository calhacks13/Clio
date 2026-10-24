import { type PlanSighting, PROCEDURE_SCHEMA_ID, type Procedure, type Step } from '@clio/protocol';
import { isRecord, type Json } from './model-json';
import { boxCenter, fromGeminiBox, fromGeminiPoint } from './vision';

// Pure: turns the planner model's JSON into a procedure candidate for safeParseProcedure.
// The server owns identity and provenance (schema, id, version, origin); the model owns content.
// What is not part of the procedure (warnings, where objects were seen) is kept beside it.

export interface PlanContext {
  id: string;
  goal: string;
  model: string;
  createdAt: string;
  revisionOf?: string;
  /** How many camera views the model was shown, to check the views its sightings name. */
  views?: number;
}

export interface Candidate {
  /** Not yet validated: run it through safeParseProcedure. */
  candidate: Record<string, unknown>;
  /** The model's safety caveats and assumptions. */
  warnings: string[];
  /** Where the model saw its declared objects, in our convention. */
  sightings: PlanSighting[];
  /** Steps from this index are an outline, written in full by a later stage "rest" request. */
  outlineFrom?: number;
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

/**
 * The model's sightings of declared objects in our convention: views numbered from 0, a point
 * [x, y] and a box in 0..1. Sightings of undeclared objects, or in views it wasn't shown, go.
 */
function modelSightings(output: Json, views: number): PlanSighting[] {
  if (!Array.isArray(output.sightings) || !Array.isArray(output.objects)) return [];
  const declared = new Set(
    output.objects.map((o) => (isRecord(o) && typeof o.id === 'string' ? o.id : null)),
  );
  return output.sightings.flatMap((raw): PlanSighting[] => {
    if (!isRecord(raw) || typeof raw.object !== 'string' || !declared.has(raw.object)) return [];
    const view = typeof raw.view === 'number' ? raw.view - 1 : -1;
    const box = fromGeminiBox(raw.box_2d);
    const point = fromGeminiPoint(raw.point) ?? (box ? boxCenter(box) : null);
    if (!Number.isInteger(view) || view < 0 || view >= views || !point) return [];
    return [{ objectId: raw.object, view, point, box }];
  });
}

export function buildPlanCandidate(output: unknown, ctx: PlanContext): Candidate {
  const o = isRecord(output) ? output : {};
  const {
    warnings: _w,
    sightings: _g,
    schema: _s,
    id: _i,
    version: _v,
    origin: _o,
    ...content
  } = o;
  return {
    candidate: {
      ...provenance(ctx),
      ...content,
      workspace: isRecord(content.workspace) ? content.workspace : DEFAULT_WORKSPACE,
      objects: Array.isArray(content.objects) ? content.objects.map(detected) : content.objects,
    },
    warnings: modelWarnings(o),
    sightings: modelSightings(o, ctx.views ?? 0),
  };
}

/** An outline line as a valid step: confirmed by its done-when, with nothing to outline yet. */
function outlineStep(line: unknown): unknown {
  if (!isRecord(line)) return line;
  const { id, instruction, doneWhen, targets } = line;
  const prompt = typeof doneWhen === 'string' ? { prompt: doneWhen } : {};
  return { id, instruction, doneWhen, targets, success: { type: 'confirm', ...prompt } };
}

/**
 * Stage first: `firstStep` written in full, then the rest of the `outline` (whose first line is
 * that same step) as plain steps, until a stage "rest" request writes them in full. So steps[n]
 * is outline[n] for every n after the first, which keeps validation paths readable.
 */
export function buildFirstStageCandidate(output: unknown, ctx: PlanContext): Candidate {
  const { outline, firstStep, ...o } = isRecord(output) ? output : {};
  const later = Array.isArray(outline) ? outline.slice(1).map(outlineStep) : [];
  const built = buildPlanCandidate({ ...o, steps: [firstStep, ...later] }, ctx);
  return later.length ? { ...built, outlineFrom: 1 } : built;
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
    sightings: [],
  };
}

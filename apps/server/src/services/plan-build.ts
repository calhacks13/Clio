import {
  actionObjectRefs,
  checkObjectRefs,
  type ObjectSpec,
  ObjectSpecSchema,
  type PlanSighting,
  PROCEDURE_SCHEMA_ID,
  type Procedure,
  SlugSchema,
  type Step,
  safeParseProcedure,
} from '@clio/protocol';
import { isRecord, type Json } from './model-json';
import type { RestLine, RestObject } from './planner';
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

/**
 * An outline line as a valid step: confirmed by what it says to do, with nothing to outline yet.
 * A done-when or targets, when the line has them, are kept.
 */
function outlineStep(line: unknown): unknown {
  if (!isRecord(line)) return line;
  const { id, instruction, doneWhen, targets } = line;
  const prompt = typeof doneWhen === 'string' ? doneWhen : instruction;
  return {
    id,
    instruction,
    ...(typeof doneWhen === 'string' ? { doneWhen } : {}),
    ...(Array.isArray(targets) ? { targets } : {}),
    success: { type: 'confirm', ...(typeof prompt === 'string' ? { prompt } : {}) },
  };
}

/**
 * A first-stage object card as an object spec: its look is what the camera looks for. Its kind
 * and size take the defaults until stage rest writes it in full (mergeRevision's `upgrade`).
 */
export function cardObject(card: unknown): unknown {
  if (!isRecord(card)) return card;
  const { id, label, look, moves } = card;
  return {
    id,
    label,
    kind: 'item',
    placement: { method: 'detect' },
    tracking: { query: look, moves: moves === true },
  };
}

const trimmed = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
/** Lowercase words without the punctuation, to compare two sentences. */
const words = (value: unknown): string =>
  trimmed(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * The first step's card in full: it outlines each object it shows (once) by that object's phrase
 * and look, each mistake made with another declared object is caught by a hand lingering near it,
 * and the step is confirmed by its done-when (the coach and the step watcher judge it from the
 * camera). A mistake made with an object the step itself uses is dropped: its hand_near rule
 * would go off during the right action.
 */
export function cardStep(card: unknown, objects: readonly unknown[]): unknown {
  if (!isRecord(card)) return card;
  const { show, mistakes, ...step } = card;
  const cards = new Map<string, { phrase: string; look: string }>();
  for (const o of objects) {
    if (!isRecord(o) || typeof o.id !== 'string' || typeof o.look !== 'string') continue;
    const phrase = trimmed(o.phrase) || trimmed(o.label) || o.id;
    if (!cards.has(o.id)) cards.set(o.id, { phrase, look: o.look });
  }
  const shown: { object: string; phrase: string; description: string }[] = [];
  for (const id of Array.isArray(show) ? show : []) {
    const seen = typeof id === 'string' ? cards.get(id) : undefined;
    if (!seen || shown.some((item) => item.object === id)) continue;
    shown.push({
      object: id,
      phrase: seen.phrase.slice(0, 60),
      description: seen.look.slice(0, 300),
    });
  }
  const action = isRecord(step.action) ? step.action : {};
  const own = new Set<unknown>([
    ...(Array.isArray(step.targets) ? step.targets : []),
    ...shown.map((item) => item.object),
    action.object,
    action.target,
  ]);
  const rules = (Array.isArray(mistakes) ? mistakes : []).flatMap((m) =>
    isRecord(m) && typeof m.object === 'string' && cards.has(m.object) && !own.has(m.object)
      ? [
          {
            kind: m.kind,
            message: m.message,
            when: { type: 'hand_near', object: m.object, dwellMs: 700 },
          },
        ]
      : [],
  );
  const doneWhen = typeof step.doneWhen === 'string' ? step.doneWhen : undefined;
  return {
    ...step,
    show: shown,
    mistakes: rules,
    success: { type: 'confirm', ...(doneWhen ? { prompt: doneWhen } : {}) },
  };
}

/**
 * The outline without the first step, which the card writes: the line with the card's id,
 * wherever it is. With no such line, outline[0] is taken for the first step only when it says
 * the same thing; otherwise every line stays, since a step done twice is plain to see and a
 * dropped one is not.
 */
function laterLines(outline: readonly unknown[], first: unknown): unknown[] {
  const id = isRecord(first) && typeof first.id === 'string' ? first.id : undefined;
  const at = id ? outline.findIndex((line) => isRecord(line) && line.id === id) : -1;
  if (at >= 0) return outline.filter((_, i) => i !== at);
  const [head, ...rest] = outline;
  const said = isRecord(first) ? words(first.instruction) : '';
  return said && isRecord(head) && words(head.instruction) === said ? rest : [...outline];
}

/**
 * Stage first: the first step's card in full, then the other lines of the `outline` as plain
 * steps, in order, until a stage "rest" request writes them in full. When outline[0] is the
 * first step, as asked, steps[n] is outline[n] for every n after the first, which keeps
 * validation paths readable.
 */
export function buildFirstStageCandidate(output: unknown, ctx: PlanContext): Candidate {
  const {
    outline,
    firstStep,
    objects,
    done: _done,
    todo: _todo,
    ...o
  } = isRecord(output) ? output : {};
  const cards = Array.isArray(objects) ? objects : [];
  const later = Array.isArray(outline) ? laterLines(outline, firstStep).map(outlineStep) : [];
  const built = buildPlanCandidate(
    { ...o, objects: cards.map(cardObject), steps: [cardStep(firstStep, cards), ...later] },
    ctx,
  );
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
 * An object stage rest wrote again in full, over the one the first stage's card declared: its
 * kind, size, description, where to look and how to track it replace the card's defaults, and its
 * id and label (the learner may have heard it) stay. A declaration that does not make a valid
 * object leaves the card's as it was.
 */
function upgraded(card: ObjectSpec, full: Json): ObjectSpec {
  const { id: _id, label: _label, hidden: _hidden, ...spec } = full;
  const tracking = isRecord(spec.tracking) ? spec.tracking : {};
  const r = ObjectSpecSchema.safeParse({
    ...card,
    ...spec,
    placement: card.placement.method === 'detect' ? spec.placement : card.placement,
    tracking: { ...card.tracking, ...tracking },
  });
  return r.success ? r.data : card;
}

/**
 * Revision: the base plan's steps before `fromStepIndex` stay verbatim, the model's steps follow.
 * Objects are the base objects plus any new ids the model declared. A base object the model
 * declares again is ignored, unless `upgrade` (stage rest, writing out a first stage's cards):
 * then its spec is filled in from the new one. Everything else (title, workspace, coach) comes
 * from the base plan.
 */
export function mergeRevision(
  base: Procedure,
  output: unknown,
  fromStepIndex: number,
  ctx: PlanContext,
  options: { upgrade?: boolean } = {},
): Candidate {
  const o = isRecord(output) ? output : {};
  const known = new Set(base.objects.map((obj) => obj.id));
  const redeclared = new Map<string, Json>();
  const added = (Array.isArray(o.objects) ? o.objects : []).map(detected).filter((obj) => {
    if (!isRecord(obj) || typeof obj.id !== 'string') return true;
    if (known.has(obj.id)) {
      if (!redeclared.has(obj.id)) redeclared.set(obj.id, obj);
      return false;
    }
    known.add(obj.id);
    return true;
  });
  const objects = base.objects.map((obj) => {
    const full = options.upgrade ? redeclared.get(obj.id) : undefined;
    return full ? upgraded(obj, full) : obj;
  });
  const kept = base.steps.slice(0, fromStepIndex);
  return {
    candidate: {
      ...provenance(ctx),
      title: base.title,
      summary: base.summary,
      domain: base.domain,
      workspace: base.workspace,
      objects: [...objects, ...added],
      // A missing steps array stays invalid so validation (and the retry) catches it.
      steps: Array.isArray(o.steps) ? [...kept, ...uniqueStepIds(kept, o.steps)] : o.steps,
      coach: base.coach,
    },
    warnings: modelWarnings(o),
    sightings: [],
  };
}

// Stage rest in parallel (plan-rest.ts): the checked outline is read into lines and new object
// cards, every line is written in full by its own call and checked on its own, and the parts
// are merged here in the outline's order. A line whose writer failed stays an outline step.

/** The checked outline: the steps to write, and the objects they need that are not declared. */
export interface CheckedOutline {
  lines: RestLine[];
  /** New objects, as first-stage cards (id, label, phrase, look, moves). */
  cards: Json[];
  /** How the review read the scene: the parts done, the parts left, the control. */
  reading: { done: string[]; todo: string[]; control: string };
  /** The lesson's summary as it now goes, when the review wrote one. */
  summary?: string;
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(trimmed).filter((v) => v !== '') : [];

const isSlug = (value: unknown): value is string => SlugSchema.safeParse(value).success;

/** "Add Base!" → "add-base", for an id the model wrote loosely. */
function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 60);
}

/**
 * The review's answer as lines to write and the new objects they use; an error when it has no
 * outline to write. Loose ids become slugs, a line id the kept steps or an earlier line use gets
 * a suffix, a new object that redeclares a known id is dropped, and `uses` keeps known ids only.
 */
export function readCheckedOutline(
  output: unknown,
  base: Procedure,
  from: number,
): { ok: true; outline: CheckedOutline } | { ok: false; error: string } {
  const o = isRecord(output) ? output : {};
  if (!Array.isArray(o.outline)) return { ok: false, error: 'The answer has no `outline` array' };
  const known = new Set(base.objects.map((obj) => obj.id));
  const cards: Json[] = [];
  for (const card of Array.isArray(o.objects) ? o.objects : []) {
    if (!isRecord(card) || typeof card.id !== 'string') continue;
    const id = slug(card.id);
    const look = trimmed(card.look);
    if (!isSlug(id) || known.has(id) || !look) continue;
    known.add(id);
    cards.push({ ...card, id, label: trimmed(card.label) || id, look });
  }
  const taken = new Set(base.steps.slice(0, from).map((s) => s.id));
  const lines: RestLine[] = [];
  for (const raw of o.outline) {
    if (!isRecord(raw)) continue;
    const instruction = trimmed(raw.instruction);
    if (!instruction) continue;
    const given = typeof raw.id === 'string' ? slug(raw.id) : '';
    const root = isSlug(given) ? given : `step-${from + lines.length + 1}`;
    let id = root;
    for (let n = 2; taken.has(id); n++) id = `${root}-${n}`;
    taken.add(id);
    const doneWhen = trimmed(raw.doneWhen);
    const uses = Array.isArray(raw.uses)
      ? [...new Set(raw.uses.filter((u): u is string => typeof u === 'string' && known.has(u)))]
      : [];
    lines.push({
      id,
      instruction: instruction.slice(0, 200),
      ...(doneWhen.length >= 3 && doneWhen.length <= 200 ? { doneWhen } : {}),
      uses,
    });
  }
  if (o.outline.length && !lines.length) {
    return { ok: false, error: 'No outline line has an instruction' };
  }
  const reading = { done: strings(o.done), todo: strings(o.todo), control: trimmed(o.control) };
  const summary = trimmed(o.summary);
  return { ok: true, outline: { lines, cards, reading, ...(summary ? { summary } : {}) } };
}

/** Every object a step writer may use: the plan's, then the checked outline's new ones. */
export function restObjects(base: Procedure, outline: CheckedOutline): RestObject[] {
  return [
    ...base.objects.map((o) => ({
      id: o.id,
      label: o.label,
      look: o.tracking?.query ?? o.description ?? o.label,
    })),
    ...outline.cards.map((c) => ({
      id: String(c.id),
      label: String(c.label),
      look: String(c.look),
    })),
  ];
}

/** Which new objects each line declares in full: those no earlier line uses. */
export function restDeclarations(outline: CheckedOutline): string[][] {
  const fresh = new Set(outline.cards.map((c) => String(c.id)));
  return outline.lines.map((line) =>
    line.uses.filter((id) => {
      if (!fresh.has(id)) return false;
      fresh.delete(id);
      return true;
    }),
  );
}

/**
 * The objects a step writer's answer is checked against: the plan's, then the new ones, each in
 * full where `declared` has it and as its card otherwise (under the card's id and label), then
 * any other object `declared` adds.
 */
export function writerObjects(
  objects: readonly unknown[],
  outline: CheckedOutline,
  declared: readonly unknown[],
): unknown[] {
  const known = new Set(objects.map((o) => (isRecord(o) ? o.id : undefined)));
  const own = new Map<unknown, Json>();
  for (const d of declared) if (isRecord(d) && !own.has(d.id)) own.set(d.id, d);
  const fresh = outline.cards.map((card) => {
    known.add(card.id);
    const full = own.get(card.id);
    return full ? detected({ ...full, id: card.id, label: card.label }) : cardObject(card);
  });
  const extra = [...own.values()].filter((d) => isSlug(d.id) && !known.has(d.id)).map(detected);
  return [...objects, ...fresh, ...extra];
}

/** One step with the objects it may use, validated as a plan of its own. */
export function checkStep(
  step: unknown,
  objects: readonly unknown[],
  ctx: PlanContext,
): { ok: true; step: Step } | { ok: false; error: string } {
  const parsed = safeParseProcedure({
    ...provenance(ctx),
    title: 'One step',
    summary: 'One step',
    workspace: DEFAULT_WORKSPACE,
    objects,
    steps: [step],
  });
  if (!parsed.ok) return parsed;
  const [checked] = parsed.procedure.steps;
  return checked ? { ok: true, step: checked } : { ok: false, error: 'No step' };
}

/**
 * A written step without two slips the card avoids by construction: a mistake that fires on an
 * object the step itself uses (it would go off during the right action) and an action whose
 * target is the object it acts on.
 */
export function tidyStep(step: Step): Step {
  const own = new Set([...step.targets, ...step.show.map((item) => item.object)]);
  if (step.action) own.add(step.action.object ?? '');
  const mistakes = step.mistakes.filter((m) => !checkObjectRefs(m.when).some((id) => own.has(id)));
  const action =
    step.action?.target !== undefined && step.action.target === step.action.object
      ? (({ target: _target, ...rest }) => rest)(step.action)
      : step.action;
  return { ...step, mistakes, ...(action ? { action } : {}) };
}

/** A step a writer wrote that passed its check, with the objects it declared in full. */
export interface WrittenStep {
  step: Step;
  objects: Json[];
}

export interface ParallelRest {
  outline: CheckedOutline;
  /** Per line: the step its writer wrote, or null when that failed. */
  written: readonly (WrittenStep | null)[];
  /** The plan's objects written again in full; [] when that call failed. */
  upgrades: readonly unknown[];
  warnings: readonly string[];
}

function stepObjectRefs(step: Step): string[] {
  return [
    ...step.targets,
    ...checkObjectRefs(step.success),
    ...(step.action ? actionObjectRefs(step.action) : []),
    ...step.show.map((item) => item.object),
    ...step.mistakes.flatMap((m) => checkObjectRefs(m.when)),
  ];
}

/**
 * Stage rest from its parts, as mergeRevision builds it from one answer: the kept steps, then
 * each line as its writer wrote it (or as an outline step), with the plan's objects upgraded
 * from their full declarations and each new one from the first writer that declared it. A
 * written step that does not fit the merged objects stays an outline step, and a new object no
 * step uses is left out.
 */
export function mergeParallelRest(
  base: Procedure,
  from: number,
  rest: ParallelRest,
  ctx: PlanContext,
): Candidate {
  const { outline, written } = rest;
  const full = new Map<string, Json>();
  for (const o of rest.upgrades) {
    if (isRecord(o) && typeof o.id === 'string' && !full.has(o.id)) full.set(o.id, o);
  }
  const upgradedBase = base.objects.map((obj) => {
    const spec = full.get(obj.id);
    return spec ? upgraded(obj, spec) : obj;
  });
  const objects = writerObjects(
    upgradedBase,
    outline,
    written.flatMap((w) => w?.objects ?? []),
  );
  const kept = base.steps.slice(0, fromIndex(base, from));
  const used = new Set(kept.flatMap(stepObjectRefs));
  const steps = outline.lines.map((line, i) => {
    const step = written[i]?.step;
    const checked = step ? checkStep({ ...step, id: line.id }, objects, ctx) : null;
    if (!checked?.ok)
      return outlineStep({ id: line.id, instruction: line.instruction, doneWhen: line.doneWhen });
    for (const id of stepObjectRefs(checked.step)) used.add(id);
    return checked.step;
  });
  const baseIds = new Set(base.objects.map((o) => o.id));
  return {
    candidate: {
      ...provenance(ctx),
      title: base.title,
      summary: outline.summary ?? base.summary,
      domain: base.domain,
      workspace: base.workspace,
      objects: objects.filter(
        (o) => isRecord(o) && typeof o.id === 'string' && (baseIds.has(o.id) || used.has(o.id)),
      ),
      steps: [...kept, ...uniqueStepIds(kept, steps)],
      coach: base.coach,
    },
    warnings: [...rest.warnings],
    sightings: [],
  };
}

const fromIndex = (base: Procedure, from: number) => Math.min(from, base.steps.length);

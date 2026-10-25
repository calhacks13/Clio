import { isRecord, type Json, parseModelJson } from './model-json';
import {
  type Candidate,
  type CheckedOutline,
  checkWrittenStep,
  mergeParallelRest,
  type PlanContext,
  readCheckedOutline,
  restDeclarations,
  restObjects,
  tidyStep,
  type WrittenStep,
  writerObjects,
} from './plan-build';
import type { Planner, PlannerRequest, RestPart } from './planner';

// Stage rest in parallel (docs/coach-plan.md, "Who writes the first draft"). One call used to
// write the first stage's quick outline in full (11 to 44 s on the bench) and kept whatever the
// outline got wrong. Here the work is split by what it needs:
// - one call reviews the outline against the scene and the goal (what is done, what is left,
//   the control), where the lesson's shape is decided, writing little; it names the new objects
//   the lines use;
// - meanwhile another writes the first stage's object cards in full, with the hazards in view;
// - then every checked line is written in full at once, each by its own call, from the whole
//   checked outline and one table of objects, so the steps fit together and share ids.
// Each step is checked on its own and retried once with its errors; one that still fails stays
// an outline step. Without a usable review the caller falls back to the single call.

/** What a part of a parallel stage rest did, for the bench and the logs. */
export interface RestPartReport {
  kind: RestPart['kind'];
  /** The line a step writer wrote. */
  index?: number;
  ms: number;
  ok: boolean;
  attempts: number;
  /** The review's reading of the scene and its lines, in words. */
  detail?: string;
}

export interface ParallelRestDeps {
  planner: Planner;
  now: () => Date;
  /** What is left of the request's budget. */
  timeLeft: () => number;
  onPart?: (report: RestPartReport) => void;
}

type Revising = PlannerRequest & { revision: NonNullable<PlannerRequest['revision']> };

/** The review gives up early enough to leave the single call time to write the rest instead. */
export const REVIEW_TIMEOUT_MS = 30_000;
/** One step writer: a straggler stays an outline line rather than hold up the others. */
export const STEP_TIMEOUT_MS = 25_000;
/** A failed part is asked again only with this much time left. */
const RETRY_MIN_MS = 8_000;

/**
 * Stage rest written in parallel, as a candidate for validation; null when the outline could not
 * be checked, so the caller writes the rest in one call instead.
 */
export async function draftRestInParallel(
  deps: ParallelRestDeps,
  request: Revising,
  ctx: PlanContext,
): Promise<Candidate | null> {
  const { base, fromStepIndex: from } = request.revision;
  const objects = writeObjects(deps, request);
  const checked = await part(
    deps,
    request,
    { kind: 'review' },
    REVIEW_TIMEOUT_MS,
    (json) => {
      const read = readCheckedOutline(json, base, from);
      return read.ok ? { ok: true, value: read.outline } : read;
    },
    describeReview,
  );
  if (!checked) return null;
  const outline = checked.value;
  const declare = restDeclarations(outline);
  const table = restObjects(base, outline);
  const written = await Promise.all(
    outline.lines.map(async (_, index) => {
      const step: RestPart = {
        kind: 'step',
        index,
        lines: outline.lines,
        objects: table,
        declare: declare[index] ?? [],
        reading: { done: outline.reading.done, control: outline.reading.control },
      };
      const done = await part(deps, request, step, STEP_TIMEOUT_MS, (json) =>
        readWrittenStep(json, base.objects, outline, ctx, outline.lines[index]?.id ?? ''),
      );
      return done?.value ?? null;
    }),
  );
  const { upgrades, warnings } = await objects;
  return mergeParallelRest(base, from, { outline, written, upgrades, warnings }, ctx);
}

/** "done: … | todo: … | control: … | line / line", for the bench and the logs. */
function describeReview({ reading, lines }: CheckedOutline): string {
  const { done, todo, control } = reading;
  return (
    `done: ${done.join('; ') || '-'} | todo: ${todo.join('; ') || '-'} | control: ` +
    `${control || '-'} | ${lines.map((l) => l.instruction).join(' / ')}`
  );
}

/** The first stage's objects in full, and the warnings; none when the call fails. */
async function writeObjects(
  deps: ParallelRestDeps,
  request: Revising,
): Promise<{ upgrades: unknown[]; warnings: string[] }> {
  const done = await part(deps, request, { kind: 'objects' }, STEP_TIMEOUT_MS, (json) =>
    isRecord(json) && Array.isArray(json.objects)
      ? { ok: true, value: json }
      : { ok: false, error: 'The answer has no `objects` array' },
  );
  const answer: Json = done?.value ?? {};
  return {
    upgrades: Array.isArray(answer.objects) ? answer.objects : [],
    warnings: Array.isArray(answer.warnings)
      ? answer.warnings
          .filter((w): w is string => typeof w === 'string')
          .map((w) => w.trim())
          .filter((w) => w !== '')
      : [],
  };
}

/** A step writer's answer, checked with the objects it may use; its id is the line's. */
function readWrittenStep(
  json: unknown,
  objects: readonly unknown[],
  outline: CheckedOutline,
  ctx: PlanContext,
  id: string,
): { ok: true; value: WrittenStep } | { ok: false; error: string } {
  if (!isRecord(json) || !isRecord(json.step)) {
    return { ok: false, error: 'The answer has no `step`' };
  }
  const declared = (Array.isArray(json.objects) ? json.objects : []).filter(isRecord);
  const checked = checkWrittenStep(
    { ...json.step, id },
    writerObjects(objects, outline, declared),
    ctx,
  );
  return checked.ok
    ? { ok: true, value: { step: tidyStep(checked.step), objects: declared } }
    : checked;
}

/**
 * One part: asked, read, and asked once more with the errors when the answer is unusable or the
 * call failed, if time allows. Null when it never gave a usable answer.
 */
async function part<T>(
  deps: ParallelRestDeps,
  request: Revising,
  which: RestPart,
  timeoutMs: number,
  read: (json: unknown) => { ok: true; value: T } | { ok: false; error: string },
  describe?: (value: T) => string,
): Promise<{ value: T } | null> {
  const started = deps.now().getTime();
  let attempts = 0;
  let retry: PlannerRequest['retry'];
  let result: { value: T } | null = null;
  while (attempts < 2 && result === null) {
    const left = Math.min(timeoutMs - (deps.now().getTime() - started), deps.timeLeft());
    if (left <= 0 || (attempts > 0 && left < RETRY_MIN_MS)) break;
    attempts++;
    let text: string;
    try {
      text = await deps.planner.draft({
        ...request,
        part: which,
        timeoutMs: left,
        ...(retry ? { retry } : {}),
      });
    } catch {
      // A failed call (an outage, or out of time) is asked again from scratch if time allows.
      retry = undefined;
      continue;
    }
    const json = parseModelJson(text);
    const answer = json.ok ? read(json.value) : json;
    if (answer.ok) result = { value: answer.value };
    else retry = { previousText: text, errors: answer.error };
  }
  deps.onPart?.({
    kind: which.kind,
    ...(which.kind === 'step' ? { index: which.index } : {}),
    ms: deps.now().getTime() - started,
    ok: result !== null,
    attempts,
    ...(result && describe ? { detail: describe(result.value) } : {}),
  });
  return result;
}

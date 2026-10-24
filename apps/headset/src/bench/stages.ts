import type { BenchRevise, BenchRun } from '@clio/protocol';

// Pure: plans in two stages on the planner bench. Stage "first" writes step 1 in full and the
// other steps as an outline, so a lesson can start quickly; stage "rest" then rewrites the outline
// in full while the learner works on step 1. Each stage is a run of its own; these pair them up
// again and say how long each took.

/** What the bench tells the planner when it asks for the rest of a plan. */
export const REFINE_REASON = 'Refine the outline while the learner does step 1';

/** The re-plan that asks for the rest of a stage-first plan, or null when there is none to ask. */
export function restRevise(first: BenchRun): BenchRevise | null {
  const { result } = first;
  if (!result.ok || result.outlineFrom === undefined) return null;
  if (result.outlineFrom >= result.procedure.steps.length) return null;
  return { base: result.procedure, fromStepIndex: result.outlineFrom, reason: REFINE_REASON };
}

const byTime = (a: BenchRun, b: BenchRun) =>
  a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1;

/**
 * Stage-first runs and the stage-rest runs that refined them: first run id → its rest. A rest
 * belongs to the latest unpaired first run before it with the same model and goal whose outline
 * starts where the rest was asked to start.
 */
export function pairStages(runs: readonly BenchRun[]): Map<string, BenchRun> {
  const pairs = new Map<string, BenchRun>();
  const ordered = [...runs].sort(byTime);
  for (const [i, rest] of ordered.entries()) {
    if (rest.request.stage !== 'rest') continue;
    const from = rest.request.revise?.fromStepIndex;
    const first = ordered
      .slice(0, i)
      .reverse()
      .find(
        (r) =>
          r.request.stage === 'first' &&
          r.model === rest.model &&
          r.request.goal === rest.request.goal &&
          r.result.ok &&
          r.result.outlineFrom === from &&
          !pairs.has(r.id),
      );
    if (first) pairs.set(first.id, rest);
  }
  return pairs;
}

/** The run a stage-rest run refined, if it is in `pairs`. */
export function firstOf(pairs: ReadonlyMap<string, BenchRun>, rest: BenchRun): string | null {
  for (const [firstId, r] of pairs) if (r.id === rest.id) return firstId;
  return null;
}

const endsAt = (run: BenchRun) => Date.parse(run.createdAt) + run.latencyMs;

/** Step 1 was ready after `firstMs`; the refined rest came `restMs` after that. */
export function stageTiming(first: BenchRun, rest: BenchRun): { firstMs: number; restMs: number } {
  return { firstMs: first.latencyMs, restMs: Math.max(0, endsAt(rest) - endsAt(first)) };
}

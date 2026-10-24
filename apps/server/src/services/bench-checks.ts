import type {
  BenchCheckAnswer,
  BenchCheckExpect,
  BenchCheckRun,
  BenchCheckTest,
  ImagePayload,
  StepCheckRequest,
  StepCriteriaRequest,
} from '@clio/protocol';
import { ApiError } from '../errors';
import { newRunId } from '../ids';
import type { StepChecker } from './step-check';
import { askStepCheck } from './step-check-service';

// The planner bench's watcher tests (docs/planner-bench.md): a look of the step watcher, saved
// with the answer it should have given, asked again with any model. Used by the
// /api/bench/checks routes and by `pnpm bench --checks`.

/** The frames of a watcher test, as stored. */
export interface CheckTestFrames {
  before: ImagePayload[];
  now: ImagePayload[];
}

/** Whether an answer meets the expectation. A "done" that also names a mistake is not done. */
export function checkPasses(expect: BenchCheckExpect, answer: BenchCheckAnswer): boolean {
  const wrong = Boolean(answer.wrong?.trim());
  const done = answer.verdict === 'done' && !wrong;
  switch (expect) {
    case 'done':
      return done;
    case 'not_done':
      return !done;
    case 'wrong':
      return wrong && answer.verdict !== 'done';
    case 'unsure':
      return answer.verdict === 'unsure' && !wrong;
  }
}

/** The answer said done (cleanly) when the test expected anything else: the costly mistake. */
export function falseDone(expect: BenchCheckExpect, answer: BenchCheckAnswer): boolean {
  return expect !== 'done' && answer.verdict === 'done' && !answer.wrong?.trim();
}

/** The test as the step watcher would have asked it, with the step's criteria if it has some. */
export function checkTestRequest(
  test: BenchCheckTest,
  frames: CheckTestFrames,
  criteria: readonly string[] = [],
): StepCheckRequest {
  return {
    goal: test.goal,
    step: test.step,
    images: frames.now,
    ...(frames.before.length ? { before: frames.before } : {}),
    ...(test.objects.length ? { objects: test.objects } : {}),
    ...(test.confusions.length ? { confusions: test.confusions } : {}),
    ...(criteria.length ? { criteria: [...criteria] } : {}),
  };
}

/**
 * The criteria question the step watcher asks when the test's step gains focus: with the views
 * from the start of the step (`seen`), as the headset does, or from the words alone, as could be
 * done when a plan arrives.
 */
export function criteriaTestRequest(
  test: BenchCheckTest,
  frames: CheckTestFrames,
  { seen = true } = {},
): StepCriteriaRequest {
  return {
    goal: test.goal,
    step: test.step,
    ...(test.objects.length ? { objects: test.objects } : {}),
    ...(test.confusions.length ? { confusions: test.confusions } : {}),
    ...(seen && frames.before.length ? { images: frames.before } : {}),
  };
}

export interface CheckRunDeps {
  checker: StepChecker;
  now: () => Date;
  rand?: () => number;
}

export interface CheckRunOptions {
  /** The step's criteria, asked beforehand (askStepCriteria). */
  criteria?: readonly string[];
  /** Ask it as a quick look, as the watcher does while a step is far from done. */
  quick?: boolean;
  /** How it was asked, when not the headset's way, e.g. "thinking minimal". */
  variant?: string;
}

/** One answer to a watcher test. A model that fails is a failed run, not a thrown error. */
export async function runCheckTest(
  deps: CheckRunDeps,
  test: BenchCheckTest,
  frames: CheckTestFrames,
  options: CheckRunOptions = {},
): Promise<BenchCheckRun> {
  const started = deps.now();
  let result: BenchCheckRun['result'];
  try {
    const request = {
      ...checkTestRequest(test, frames, options.criteria),
      ...(options.quick ? { quick: true } : {}),
    };
    const { answer } = await askStepCheck(deps.checker, request, deps.now);
    result = { ok: true, answer };
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    result = { ok: false, code: error.code, message: error.message };
  }
  return {
    id: newRunId(started, deps.rand),
    createdAt: started.toISOString(),
    model: deps.checker.model,
    ...(options.variant ? { variant: options.variant } : {}),
    latencyMs: Math.max(0, deps.now().getTime() - started.getTime()),
    expect: test.expect,
    result,
    passed: result.ok && checkPasses(test.expect, result.answer),
  };
}

/** "done", "not done", "wrong", "unsure": for logs and the CLI. */
export const expectLabel = (expect: BenchCheckExpect) =>
  expect === 'not_done' ? 'not done' : expect;

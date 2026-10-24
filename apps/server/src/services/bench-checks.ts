import type {
  BenchCheckAnswer,
  BenchCheckExpect,
  BenchCheckRun,
  BenchCheckTest,
  ImagePayload,
  StepCheckRequest,
} from '@clio/protocol';
import { ApiError, geminiNotConfigured, upstreamFailed } from '../errors';
import { newRunId } from '../ids';
import { describeError } from '../log';
import type { Planner } from './planner';
import { parseStepCheck } from './step-check';

// The planner bench's watcher tests (docs/planner-bench.md): a look of the step watcher, saved
// with the answer it should have given, asked again with any model. Used by the
// /api/bench/checks routes and by `pnpm bench --checks`.

/** The frames of a watcher test, as stored. */
export interface CheckTestFrames {
  before: ImagePayload[];
  now: ImagePayload[];
}

/**
 * Asks the step watcher's question once. Throws a 502 ApiError when the model fails or its
 * answer can't be read, and a 503 when the planner can't check steps.
 */
export async function askStepCheck(
  planner: Planner,
  request: StepCheckRequest,
  now: () => Date,
): Promise<{ answer: BenchCheckAnswer; latencyMs: number }> {
  if (!planner.checkStep) throw geminiNotConfigured('Step checks');
  const started = now().getTime();
  let text: string;
  try {
    text = await planner.checkStep(request);
  } catch (error) {
    throw upstreamFailed(`Step check failed: ${describeError(error)}`);
  }
  const latencyMs = Math.max(0, now().getTime() - started);
  try {
    return { answer: parseStepCheck(text), latencyMs };
  } catch (error) {
    throw upstreamFailed(`Step check gave an unusable answer: ${describeError(error)}`);
  }
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
  }
}

/** The test as the step watcher would have asked it. */
export function checkTestRequest(test: BenchCheckTest, frames: CheckTestFrames): StepCheckRequest {
  return {
    goal: test.goal,
    step: test.step,
    images: frames.now,
    ...(frames.before.length ? { before: frames.before } : {}),
    ...(test.objects.length ? { objects: test.objects } : {}),
    ...(test.confusions.length ? { confusions: test.confusions } : {}),
  };
}

export interface CheckRunDeps {
  planner: Planner;
  now: () => Date;
  rand?: () => number;
}

/** One answer to a watcher test. A model that fails is a failed run, not a thrown error. */
export async function runCheckTest(
  deps: CheckRunDeps,
  test: BenchCheckTest,
  frames: CheckTestFrames,
): Promise<BenchCheckRun> {
  const started = deps.now();
  let result: BenchCheckRun['result'];
  try {
    const { answer } = await askStepCheck(deps.planner, checkTestRequest(test, frames), deps.now);
    result = { ok: true, answer };
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    result = { ok: false, code: error.code, message: error.message };
  }
  return {
    id: newRunId(started, deps.rand),
    createdAt: started.toISOString(),
    model: deps.planner.model,
    latencyMs: Math.max(0, deps.now().getTime() - started.getTime()),
    expect: test.expect,
    result,
    passed: result.ok && checkPasses(test.expect, result.answer),
  };
}

/** "done", "not done", "wrong": for logs and the CLI. */
export const expectLabel = (expect: BenchCheckExpect) =>
  expect === 'not_done' ? 'not done' : expect;

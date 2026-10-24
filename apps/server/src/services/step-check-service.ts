import type { StepCheckRequest, StepCriteriaRequest } from '@clio/protocol';
import { upstreamFailed } from '../errors';
import { describeError } from '../log';
import { parseStepCheck, type StepCheckAnswer, type StepChecker } from './step-check';
import { parseStepCriteria } from './step-criteria';

// The step watcher's two questions, asked of a StepChecker and read: used by POST
// /api/plans/check and /api/plans/criteria, and by the planner bench's watcher tests.

/**
 * Asks the step watcher's question once. Throws a 502 ApiError when the model fails or its
 * answer can't be read.
 */
export async function askStepCheck(
  checker: StepChecker,
  request: StepCheckRequest,
  now: () => Date,
): Promise<{ answer: StepCheckAnswer; latencyMs: number }> {
  const started = now().getTime();
  let text: string;
  try {
    text = await checker.check(request);
  } catch (error) {
    throw upstreamFailed(`Step check failed: ${describeError(error)}`);
  }
  const latencyMs = Math.max(0, now().getTime() - started);
  try {
    return { answer: parseStepCheck(text, request.criteria), latencyMs };
  } catch (error) {
    throw upstreamFailed(`Step check gave an unusable answer: ${describeError(error)}`);
  }
}

/** Asks for a step's criteria once. Throws a 502 ApiError like askStepCheck. */
export async function askStepCriteria(
  checker: StepChecker,
  request: StepCriteriaRequest,
  now: () => Date,
): Promise<{ criteria: string[]; latencyMs: number }> {
  const started = now().getTime();
  let text: string;
  try {
    text = await checker.criteria(request);
  } catch (error) {
    throw upstreamFailed(`Step criteria failed: ${describeError(error)}`);
  }
  const latencyMs = Math.max(0, now().getTime() - started);
  try {
    return { criteria: parseStepCriteria(text), latencyMs };
  } catch (error) {
    throw upstreamFailed(`Step criteria gave an unusable answer: ${describeError(error)}`);
  }
}

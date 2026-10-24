import type { GenerateContentParameters } from '@google/genai';
import type { GenerateContentApi } from './gemini';
import { PLANNER_SYSTEM_INSTRUCTION, plannerContents } from './plan-prompt';
import { buildPlanJsonSchema } from './plan-schema';
import type { Planner } from './planner';
import { STEP_CHECK_INSTRUCTION, stepCheckContents, stepCheckJsonSchema } from './step-check';

/** A planner draft whose request sets no `timeoutMs`. */
export const PLAN_TIMEOUT_MS = 45_000;
/** One step check. The step watcher asks again a few seconds later anyway. */
export const STEP_CHECK_TIMEOUT_MS = 8_000;

/** The planner on Gemini structured output: JSON constrained by the hand-built plan schema. */
export function createGeminiPlanner(ai: GenerateContentApi, model: string): Planner {
  return {
    model,
    draft: (request) =>
      generateJson(
        ai,
        {
          model,
          contents: plannerContents(request),
          config: {
            systemInstruction: PLANNER_SYSTEM_INSTRUCTION,
            responseMimeType: 'application/json',
            responseJsonSchema: buildPlanJsonSchema(request.revision ? 'revision' : 'plan'),
          },
        },
        request.timeoutMs ?? PLAN_TIMEOUT_MS,
      ),
    checkStep: (request) =>
      generateJson(
        ai,
        {
          model,
          contents: stepCheckContents(request),
          config: {
            systemInstruction: STEP_CHECK_INSTRUCTION,
            responseMimeType: 'application/json',
            responseJsonSchema: stepCheckJsonSchema(),
          },
        },
        STEP_CHECK_TIMEOUT_MS,
      ),
  };
}

/** One call that gives up after `timeoutMs` and says so. Returns the response text. */
async function generateJson(
  ai: GenerateContentApi,
  params: GenerateContentParameters,
  timeoutMs: number,
): Promise<string> {
  const abortSignal = AbortSignal.timeout(timeoutMs);
  let text: string | undefined;
  try {
    ({ text } = await ai.models.generateContent({
      ...params,
      config: { ...params.config, abortSignal },
    }));
  } catch (error) {
    if (abortSignal.aborted) {
      throw new Error(`Gemini did not answer within ${Math.round(timeoutMs / 1000)} s`);
    }
    throw error;
  }
  if (!text) throw new Error('Gemini returned an empty response');
  return text;
}

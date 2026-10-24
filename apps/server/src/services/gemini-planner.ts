import type { PlanStage } from '@clio/protocol';
import type { GenerateContentParameters } from '@google/genai';
import { type GenerateContentApi, type Thinking, thinkingConfig } from './gemini';
import { PLANNER_SYSTEM_INSTRUCTION, plannerContents } from './plan-prompt';
import { buildPlanJsonSchema, type PlanSchemaKind } from './plan-schema';
import type { Planner, PlannerRequest } from './planner';
import { STEP_CHECK_INSTRUCTION, stepCheckContents, stepCheckJsonSchema } from './step-check';

/** A planner draft whose request sets no `timeoutMs`. */
export const PLAN_TIMEOUT_MS = 45_000;
/** One step check. The step watcher asks again as soon as it has an answer, so don't wait long. */
export const STEP_CHECK_TIMEOUT_MS = 6_000;
/**
 * Measured on Robotics-ER 2 (docs/coach-plan.md, the step watcher): low never called a step done
 * that wasn't, in about 1.6 s. Minimal, 0.5 s faster, once took the dropper for the knife and
 * called that step done, said "not done" for an object out of view, and missed more mix-ups.
 */
export const STEP_CHECK_THINKING: Thinking = 'low';

/** Thinking per stage, where null leaves the model its own default. */
export type StageThinking = Record<PlanStage, Thinking | null>;

/**
 * How hard the planner thinks at each stage, chosen by judged quality and latency on Robotics-ER 2
 * (docs/coach-plan.md): more thinking is not always better. The first stage is what the learner
 * waits for; the rest has time. A revise_plan thinks like a full plan: the learner waits for both.
 */
export const PLAN_THINKING: StageThinking = { full: 'low', first: 'low', rest: 'medium' };

export interface GeminiPlannerOptions {
  /** Overrides PLAN_THINKING, e.g. to compare levels on the bench. */
  thinking?: Partial<StageThinking>;
}

function schemaKind(request: PlannerRequest): PlanSchemaKind {
  if (request.revision) return 'revision';
  return request.stage === 'first' ? 'first' : 'plan';
}

/** The planner on Gemini structured output: JSON constrained by the hand-built plan schema. */
export function createGeminiPlanner(
  ai: GenerateContentApi,
  model: string,
  options: GeminiPlannerOptions = {},
): Planner {
  const thinking: StageThinking = { ...PLAN_THINKING, ...options.thinking };
  return {
    model,
    draft: (request) => {
      const level = thinking[request.stage ?? 'full'];
      return generateJson(
        ai,
        {
          model,
          contents: plannerContents(request),
          config: {
            systemInstruction: PLANNER_SYSTEM_INSTRUCTION,
            responseMimeType: 'application/json',
            responseJsonSchema: buildPlanJsonSchema(schemaKind(request)),
            ...(level ? thinkingConfig(model, level) : {}),
          },
        },
        request.timeoutMs ?? PLAN_TIMEOUT_MS,
      );
    },
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
            ...thinkingConfig(model, STEP_CHECK_THINKING),
          },
        },
        STEP_CHECK_TIMEOUT_MS,
      ),
  };
}

/** One call that gives up after `timeoutMs` and says so. Returns the response text. */
export async function generateJson(
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

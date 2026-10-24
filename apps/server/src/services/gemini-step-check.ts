import { type GenerateContentApi, type Thinking, thinkingConfig } from './gemini';
import { generateJson } from './gemini-planner';
import {
  STEP_CHECK_INSTRUCTION,
  type StepChecker,
  stepCheckContents,
  stepCheckJsonSchema,
} from './step-check';
import {
  STEP_CRITERIA_INSTRUCTION,
  stepCriteriaContents,
  stepCriteriaJsonSchema,
} from './step-criteria';

/** One step check. The step watcher asks again as soon as it has an answer, so don't wait long. */
export const STEP_CHECK_TIMEOUT_MS = 6_000;
/** A step's criteria, asked once when it gains focus, while the first look waits anyway. */
export const STEP_CRITERIA_TIMEOUT_MS = 8_000;
/**
 * Measured on Robotics-ER 2 (docs/robotics-er.md, the step check): low never called a step done
 * that wasn't. Minimal is about 0.5 s faster and as right on done, not done and wrong in our 30
 * hard cases, but it fills in what a hand hides ("cup A is still purple"), and it once took the
 * dropper for the knife and called that step done. So a quick look thinks at minimal and only
 * notices a change; the look that confirms it thinks at low.
 */
export const STEP_CHECK_THINKING: Thinking = 'low';
export const STEP_CHECK_QUICK_THINKING: Thinking = 'minimal';
export const STEP_CRITERIA_THINKING: Thinking = 'low';

export interface GeminiStepCheckerOptions {
  /** Overrides STEP_CHECK_THINKING, e.g. to compare levels on the bench; null: the model's own. */
  thinking?: Thinking | null;
  /** Overrides STEP_CHECK_QUICK_THINKING, for quick looks; null: the model's own. */
  quickThinking?: Thinking | null;
  /** Overrides STEP_CRITERIA_THINKING; null: the model's own. */
  criteriaThinking?: Thinking | null;
  /** With no criteria in the request, the model writes its own and judges them. */
  inline?: boolean;
}

/** The step watcher's model on Gemini structured output (the planner's model by default). */
export function createGeminiStepChecker(
  ai: GenerateContentApi,
  model: string,
  options: GeminiStepCheckerOptions = {},
): StepChecker {
  const thinking = options.thinking === undefined ? STEP_CHECK_THINKING : options.thinking;
  const quickThinking =
    options.quickThinking === undefined ? STEP_CHECK_QUICK_THINKING : options.quickThinking;
  const criteriaThinking =
    options.criteriaThinking === undefined ? STEP_CRITERIA_THINKING : options.criteriaThinking;
  const inline = options.inline ?? false;
  return {
    model,
    check: (request) => {
      const given = request.criteria?.length ?? 0;
      const level = request.quick ? quickThinking : thinking;
      return generateJson(
        ai,
        {
          model,
          contents: stepCheckContents(request, { inline: inline && !given }),
          config: {
            systemInstruction: STEP_CHECK_INSTRUCTION,
            responseMimeType: 'application/json',
            responseJsonSchema: stepCheckJsonSchema(given || (inline ? 'inline' : 0)),
            ...(level ? thinkingConfig(model, level) : {}),
          },
        },
        STEP_CHECK_TIMEOUT_MS,
      );
    },
    criteria: (request) =>
      generateJson(
        ai,
        {
          model,
          contents: stepCriteriaContents(request),
          config: {
            systemInstruction: STEP_CRITERIA_INSTRUCTION,
            responseMimeType: 'application/json',
            responseJsonSchema: stepCriteriaJsonSchema(),
            ...(criteriaThinking ? thinkingConfig(model, criteriaThinking) : {}),
          },
        },
        STEP_CRITERIA_TIMEOUT_MS,
      ),
  };
}

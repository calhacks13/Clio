import {
  FOCUS_INSTRUCTION,
  type FocusFinder,
  focusContents,
  focusJsonSchema,
  parseFocusAnswer,
} from './focus';
import { type GenerateContentApi, thinkingConfig } from './gemini';
import { generateJson } from './gemini-planner';
import { uniqueById } from './vision';

/**
 * One look. The headset looks again 5 s later while the step stays focused, and the tracker
 * follows the objects meanwhile, so an answer later than this is not worth waiting for.
 */
export const FOCUS_TIMEOUT_MS = 8_000;

/**
 * The action focus on Gemini structured output: Robotics-ER 2 by default, always at minimal
 * thinking, where its boxes and pointing are as accurate as at high (docs/robotics-er.md).
 */
export function createGeminiFocusFinder(ai: GenerateContentApi, model: string): FocusFinder {
  return {
    model,
    async focus(request) {
      const objects = uniqueById(request.objects);
      const text = await generateJson(
        ai,
        {
          model,
          contents: focusContents({ ...request, objects }),
          config: {
            systemInstruction: FOCUS_INSTRUCTION,
            responseMimeType: 'application/json',
            responseJsonSchema: focusJsonSchema(objects.map((o) => o.id)),
            ...thinkingConfig(model, 'minimal'),
          },
        },
        FOCUS_TIMEOUT_MS,
      );
      return parseFocusAnswer(text, objects);
    },
  };
}

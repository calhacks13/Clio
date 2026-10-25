import type { FocusObject, FocusRequest, NormalizedBox } from '@clio/protocol';
import {
  COUNT_INSTRUCTION,
  countContents,
  countJsonSchema,
  FOCUS_INSTRUCTION,
  type FocusFinder,
  focusContents,
  focusJsonSchema,
  parseCount,
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
      // The step's own object is counted among its look-alikes beside the look (focus.ts).
      const own = objects[0];
      const [text, counted] = await Promise.all([
        generateJson(
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
        ),
        own ? count(ai, model, request.image, own) : Promise.resolve(null),
      ]);
      return parseFocusAnswer(text, objects, new Map(own && counted ? [[own.id, counted]] : []));
    },
  };
}

/** Every look-alike of `object` in the frame, the object included; null when the count fails. */
async function count(
  ai: GenerateContentApi,
  model: string,
  image: FocusRequest['image'],
  object: FocusObject,
): Promise<NormalizedBox[] | null> {
  try {
    const text = await generateJson(
      ai,
      {
        model,
        contents: countContents(image, object),
        config: {
          systemInstruction: COUNT_INSTRUCTION,
          responseMimeType: 'application/json',
          responseJsonSchema: countJsonSchema(),
          // Counting takes a little thought: at minimal it found two of three chargers as often
          // as three, look to look.
          ...thinkingConfig(model, 'low'),
        },
      },
      FOCUS_TIMEOUT_MS,
    );
    return parseCount(text);
  } catch {
    // The look still answers: its own look-alikes count the object instead.
    return null;
  }
}

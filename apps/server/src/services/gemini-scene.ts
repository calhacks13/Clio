import { type GenerateContentApi, type Thinking, thinkingConfig } from './gemini';
import { generateJson } from './gemini-planner';
import {
  parseSceneAnswer,
  SCENE_INSTRUCTION,
  type SceneAsker,
  sceneContents,
  sceneJsonSchema,
} from './scene';

/** One closer look. The voice has already said it is looking, so a slow answer is still wanted. */
export const SCENE_TIMEOUT_MS = 8_000;

/** The smart model's closer look, on Gemini structured output (Robotics-ER 2 by default). */
export function createGeminiSceneAsker(
  ai: GenerateContentApi,
  model: string,
  thinking: Thinking = 'minimal',
): SceneAsker {
  return {
    model,
    async ask(request) {
      const text = await generateJson(
        ai,
        {
          model,
          contents: sceneContents(request),
          config: {
            systemInstruction: SCENE_INSTRUCTION,
            responseMimeType: 'application/json',
            responseJsonSchema: sceneJsonSchema(),
            ...thinkingConfig(model, thinking),
          },
        },
        SCENE_TIMEOUT_MS,
      );
      return parseSceneAnswer(
        text,
        (request.objects ?? []).map((o) => o.id),
      );
    },
  };
}

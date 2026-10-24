import type { GenerateContentApi } from './gemini';
import { PLANNER_SYSTEM_INSTRUCTION, plannerContents } from './plan-prompt';
import { buildPlanJsonSchema } from './plan-schema';
import type { Planner } from './planner';

/** The planner on Gemini structured output: JSON constrained by the hand-built plan schema. */
export function createGeminiPlanner(ai: GenerateContentApi, model: string): Planner {
  return {
    model,
    async draft(request) {
      const response = await ai.models.generateContent({
        model,
        contents: plannerContents(request),
        config: {
          systemInstruction: PLANNER_SYSTEM_INSTRUCTION,
          responseMimeType: 'application/json',
          responseJsonSchema: buildPlanJsonSchema(request.revision ? 'revision' : 'plan'),
        },
      });
      if (!response.text) throw new Error('Gemini returned an empty response');
      return response.text;
    },
  };
}

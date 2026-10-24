import { type BenchJudge, JUDGE_INSTRUCTION, judgeContents, judgeJsonSchema } from './bench-judge';
import type { GenerateContentApi } from './gemini';
import { generateJson } from './gemini-planner';

/** One judgement. Strong models think for a while, and nobody is waiting on a headset. */
export const JUDGE_TIMEOUT_MS = 120_000;

/** The planner bench's judge on Gemini structured output. */
export function createGeminiJudge(ai: GenerateContentApi, model: string): BenchJudge {
  return {
    model,
    judge: (request) =>
      generateJson(
        ai,
        {
          model,
          contents: judgeContents(request),
          config: {
            systemInstruction: JUDGE_INSTRUCTION,
            responseMimeType: 'application/json',
            responseJsonSchema: judgeJsonSchema(),
          },
        },
        JUDGE_TIMEOUT_MS,
      ),
  };
}

import type { GenerateContentParameters } from '@google/genai';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  createGeminiStepChecker,
  STEP_CHECK_QUICK_THINKING,
  STEP_CHECK_THINKING,
  STEP_CHECK_TIMEOUT_MS,
  STEP_CRITERIA_THINKING,
  STEP_CRITERIA_TIMEOUT_MS,
} from '../src/services/gemini-step-check';
import {
  STEP_CHECK_INSTRUCTION,
  stepCheckContents,
  stepCheckJsonSchema,
} from '../src/services/step-check';
import {
  STEP_CRITERIA_INSTRUCTION,
  stepCriteriaContents,
  stepCriteriaJsonSchema,
} from '../src/services/step-criteria';

// The step watcher's model on Gemini: the check and the criteria, each with its schema, thinking
// level and timeout.

const IMAGE = { mimeType: 'image/jpeg' as const, data: '/9j/4AAQSkZJRgABAQ' };
const CHECK = {
  goal: 'Refill the washer fluid',
  step: {
    id: 'open-cap',
    instruction: 'Flip open the blue washer fluid cap.',
    doneWhen: 'The blue cap is flipped open.',
  },
  images: [IMAGE],
};

function fakeAi(text: string | undefined) {
  const calls: GenerateContentParameters[] = [];
  return {
    calls,
    models: {
      generateContent: async (params: GenerateContentParameters) => {
        calls.push(params);
        const signal = params.config?.abortSignal;
        if (signal?.aborted) throw signal.reason;
        return { text };
      },
    },
  };
}

describe('createGeminiStepChecker', () => {
  it('checks a step with the model, the views and the step-check schema', async () => {
    const answer = '{"verdict":"done","observation":"The blue cap is open."}';
    const ai = fakeAi(answer);
    const checker = createGeminiStepChecker(ai, 'checker-x', { thinking: null });
    expect(checker.model).toBe('checker-x');
    expect(await checker.check(CHECK)).toBe(answer);
    expect(ai.calls).toEqual([
      {
        model: 'checker-x',
        contents: stepCheckContents(CHECK),
        config: {
          systemInstruction: STEP_CHECK_INSTRUCTION,
          responseMimeType: 'application/json',
          responseJsonSchema: stepCheckJsonSchema(),
          abortSignal: expect.any(AbortSignal),
        },
      },
    ]);
  });

  it('asks for one judgement per given criterion, or criteria of its own when inline', async () => {
    const ai = fakeAi('{}');
    const criteria = ['The blue cap is open.', 'The red cap is still closed.'];
    await createGeminiStepChecker(ai, 'm').check({ ...CHECK, criteria });
    expect(ai.calls[0]?.config?.responseJsonSchema).toEqual(stepCheckJsonSchema(2));
    expect(ai.calls[0]?.contents).toEqual(stepCheckContents({ ...CHECK, criteria }));

    await createGeminiStepChecker(ai, 'm', { inline: true }).check(CHECK);
    expect(ai.calls[1]?.config?.responseJsonSchema).toEqual(stepCheckJsonSchema('inline'));
    expect(ai.calls[1]?.contents).toEqual(stepCheckContents(CHECK, { inline: true }));

    // Given criteria win over inline ones.
    await createGeminiStepChecker(ai, 'm', { inline: true }).check({ ...CHECK, criteria });
    expect(ai.calls[2]?.config?.responseJsonSchema).toEqual(stepCheckJsonSchema(2));
  });

  it('writes criteria with the views from the start of the step and the criteria schema', async () => {
    const ai = fakeAi('{"criteria":["The blue cap is open."]}');
    const request = { goal: CHECK.goal, step: CHECK.step, images: [IMAGE] };
    await createGeminiStepChecker(ai, 'checker-x', { criteriaThinking: null }).criteria(request);
    expect(ai.calls).toEqual([
      {
        model: 'checker-x',
        contents: stepCriteriaContents(request),
        config: {
          systemInstruction: STEP_CRITERIA_INSTRUCTION,
          responseMimeType: 'application/json',
          responseJsonSchema: stepCriteriaJsonSchema(),
          abortSignal: expect.any(AbortSignal),
        },
      },
    ]);
  });

  it('thinks at low by default on Gemini 3 models, Robotics-ER 2 among them', async () => {
    expect([STEP_CHECK_THINKING, STEP_CRITERIA_THINKING]).toEqual(['low', 'low']);
    for (const [model, level] of [
      ['gemini-robotics-er-2-preview', 'LOW'],
      ['gemini-3.5-flash-lite', 'LOW'],
      ['gemini-2.5-flash', undefined],
    ] as const) {
      const ai = fakeAi('{}');
      const checker = createGeminiStepChecker(ai, model);
      await checker.check(CHECK);
      await checker.criteria(CHECK);
      expect(ai.calls.map((c) => c.config?.thinkingConfig?.thinkingLevel)).toEqual([level, level]);
    }
    const ai = fakeAi('{}');
    await createGeminiStepChecker(ai, 'gemini-robotics-er-2-preview', {
      thinking: 'minimal',
    }).check(CHECK);
    expect(ai.calls[0]?.config?.thinkingConfig?.thinkingLevel).toBe('MINIMAL');
  });

  it('thinks at minimal for a quick look', async () => {
    expect(STEP_CHECK_QUICK_THINKING).toBe('minimal');
    const ai = fakeAi('{}');
    const checker = createGeminiStepChecker(ai, 'gemini-robotics-er-2-preview');
    await checker.check({ ...CHECK, quick: true });
    await checker.check({ ...CHECK, quick: false });
    expect(ai.calls.map((c) => c.config?.thinkingConfig?.thinkingLevel)).toEqual([
      'MINIMAL',
      'LOW',
    ]);
  });

  it('gives a check 6 s and the criteria 8 s, and says so when Gemini is late', async () => {
    const spy = vi.spyOn(AbortSignal, 'timeout');
    onTestFinished(() => spy.mockRestore());
    const checker = createGeminiStepChecker(fakeAi('{}'), 'm');
    await checker.check(CHECK);
    await checker.criteria(CHECK);
    expect([STEP_CHECK_TIMEOUT_MS, STEP_CRITERIA_TIMEOUT_MS]).toEqual([6_000, 8_000]);
    expect(spy.mock.calls).toEqual([[6_000], [8_000]]);

    spy.mockImplementation(() =>
      AbortSignal.abort(new DOMException('The operation timed out.', 'TimeoutError')),
    );
    await expect(checker.check(CHECK)).rejects.toThrow('Gemini did not answer within 6 s');
  });

  it('fails when Gemini returns no text', async () => {
    await expect(createGeminiStepChecker(fakeAi(undefined), 'm').check(CHECK)).rejects.toThrow(
      /empty/,
    );
  });
});

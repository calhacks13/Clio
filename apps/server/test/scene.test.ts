import {
  ApiErrorSchema,
  ApiPaths,
  type SceneAskRequest,
  SceneAskResponseSchema,
} from '@clio/protocol';
import type { GenerateContentParameters } from '@google/genai';
import { describe, expect, it } from 'vitest';
import { createGeminiSceneAsker } from '../src/services/gemini-scene';
import {
  MAX_ANSWER_CHARS,
  MAX_HAZARD_CHARS,
  parseSceneAnswer,
  SCENE_INSTRUCTION,
  type SceneAsker,
  sceneContents,
  sceneJsonSchema,
} from '../src/services/scene';
import { harness, steppingClock } from './harness';

// The voice coach's closer look: the smart model answers in words for the voice, and says where
// the things it points out are, for the AR layer only.

const IMAGE = { mimeType: 'image/jpeg' as const, data: '/9j/4AAQSkZJRgABAQ' };
const REQUEST: SceneAskRequest = {
  question: 'Which cup is still empty?',
  goal: 'Test an acid and a base with red-cabbage indicator',
  step: { instruction: 'Add vinegar to cup A.', doneWhen: 'cup A has turned pink' },
  objects: [
    { id: 'cup_a', label: 'cup A', look: 'clear cup with a big letter A' },
    { id: 'cup_c', label: 'cup C' },
  ],
  images: [IMAGE],
};

function fakeAi(text: string | undefined) {
  const calls: GenerateContentParameters[] = [];
  return {
    calls,
    models: {
      generateContent: async (params: GenerateContentParameters) => {
        calls.push(params);
        return { text };
      },
    },
  };
}

describe('the closer look prompt', () => {
  it('sends the views first, then the goal, the step, the materials and the question', () => {
    expect(sceneContents(REQUEST)).toEqual([
      {
        role: 'user',
        parts: [
          { inlineData: IMAGE },
          {
            text:
              'Goal: Test an acid and a base with red-cabbage indicator\n' +
              'Step now: Add vinegar to cup A. Done when: cup A has turned pink\n' +
              'Materials:\n' +
              '- cup_a: cup A (clear cup with a big letter A)\n' +
              '- cup_c: cup C\n' +
              "Attached: 1 camera view from the learner's headset, newest last.\n" +
              'Question: Which cup is still empty?',
          },
        ],
      },
    ]);
  });

  it('asks only the question when no lesson is running', () => {
    const [content] = sceneContents({ question: 'What is this?', images: [IMAGE, IMAGE] });
    expect(content?.parts?.at(-1)).toEqual({
      text: "Attached: 2 camera views from the learner's headset, newest last.\nQuestion: What is this?",
    });
  });

  it('keeps the answer short and coordinates out of it', () => {
    expect(SCENE_INSTRUCTION).toContain('at most two short sentences');
    expect(SCENE_INSTRUCTION).toContain('never as numbers');
  });

  it('looks for a hazard first, whatever the question', () => {
    // Asked "which cup is empty and is it safe?", Robotics-ER 2 at minimal thinking named the knife
    // 1 time in 4 when hazards were a line of the prompt, and 4 in 4 as their own field.
    expect(SCENE_INSTRUCTION).toContain('`hazard`: first, whatever the question');
    const schema = sceneJsonSchema() as { properties: object; required: string[] };
    expect(Object.keys(schema.properties)).toEqual(['hazard', 'answer', 'refs']);
    expect(schema.required).toEqual(['hazard', 'answer', 'refs']);
  });
});

describe('parseSceneAnswer', () => {
  it("converts the refs to our convention and keeps only the request's object ids", () => {
    const text = JSON.stringify({
      hazard: '',
      answer: 'Cup C, on the right, is empty.',
      refs: [
        { label: 'cup C', id: 'cup_c', point: [730, 480], box_2d: [640, 430, 830, 530] },
        { label: 'knife', id: 'knife', point: [400, 200], box_2d: [350, 0, 450, 380] },
      ],
    });
    expect(parseSceneAnswer(text, ['cup_a', 'cup_c'])).toEqual({
      hazard: null,
      answer: 'Cup C, on the right, is empty.',
      refs: [
        { label: 'cup C', objectId: 'cup_c', point: [0.48, 0.73], box: [0.43, 0.64, 0.53, 0.83] },
        { label: 'knife', objectId: null, point: [0.2, 0.4], box: [0, 0.35, 0.38, 0.45] },
      ],
    });
  });

  it('uses the box center without a point, and drops refs with neither', () => {
    const text = JSON.stringify({
      answer: 'There.',
      refs: [
        { label: 'a', id: null, point: null, box_2d: [0, 0, 500, 500] },
        { label: 'b', id: null, point: 'here', box_2d: null },
      ],
    });
    expect(parseSceneAnswer(text, []).refs).toEqual([
      { label: 'a', objectId: null, point: [0.25, 0.25], box: [0, 0, 0.5, 0.5] },
    ]);
  });

  it('strips coordinates from the words the coach hears, and caps their length', () => {
    const coords = parseSceneAnswer(
      '{"hazard":"knife [400, 200] by the cups","answer":"The cap [240, 720] is blue.","refs":[]}',
      [],
    );
    expect(coords).toMatchObject({ hazard: 'knife by the cups', answer: 'The cap is blue.' });
    const long = parseSceneAnswer(
      JSON.stringify({ hazard: 'h'.repeat(500), answer: 'x'.repeat(500), refs: [] }),
      [],
    );
    expect(long.answer).toHaveLength(MAX_ANSWER_CHARS);
    expect(long.hazard).toHaveLength(MAX_HAZARD_CHARS);
  });

  it('caps the refs and rejects answers without words', () => {
    const ref = { label: 'r', id: null, point: [1, 1], box_2d: null };
    const many = JSON.stringify({ answer: 'a', refs: [ref, ref, ref, ref, ref] });
    expect(parseSceneAnswer(many, []).refs).toHaveLength(3);
    expect(() => parseSceneAnswer('{"answer":"  ","refs":[]}', [])).toThrow(/no answer/);
    expect(() => parseSceneAnswer('not json', [])).toThrow(/not valid JSON/);
  });
});

describe('createGeminiSceneAsker', () => {
  it('asks with structured output and minimal thinking, and reads the answer', async () => {
    const ai = fakeAi('{"hazard":"","answer":"Cup C.","refs":[]}');
    const asker = createGeminiSceneAsker(ai, 'gemini-robotics-er-2-preview');
    expect(asker.model).toBe('gemini-robotics-er-2-preview');
    expect(await asker.ask(REQUEST)).toEqual({ hazard: null, answer: 'Cup C.', refs: [] });
    expect(ai.calls[0]).toMatchObject({
      model: 'gemini-robotics-er-2-preview',
      contents: sceneContents(REQUEST),
      config: {
        systemInstruction: SCENE_INSTRUCTION,
        responseMimeType: 'application/json',
        responseJsonSchema: sceneJsonSchema(),
        thinkingConfig: { thinkingLevel: 'MINIMAL' },
      },
    });
  });
});

describe('POST /api/scene/ask', () => {
  const asker = (answer: SceneAsker['ask']): SceneAsker => ({
    model: 'scene-test',
    ask: answer,
  });

  it('answers 503 without a Gemini key', async () => {
    const h = await harness();
    const res = await h.request('POST', ApiPaths.sceneAsk, REQUEST);
    expect(res.status).toBe(503);
    expect(ApiErrorSchema.parse(await res.json()).error.code).toBe('gemini_not_configured');
  });

  it('returns the answer, the model and the measured latency', async () => {
    const seen: unknown[] = [];
    const scene: SceneAsker = {
      model: 'scene-test',
      async ask(request) {
        seen.push(request);
        return {
          hazard: 'a knife by the cups',
          answer: 'Cup C is empty.',
          refs: [{ label: 'cup C', objectId: 'cup_c', point: [0.5, 0.7], box: null }],
        };
      },
    };
    const h = await harness({ scene, now: steppingClock('2026-10-24T03:15:02.000Z', 900) });
    const res = await h.request('POST', ApiPaths.sceneAsk, REQUEST);
    expect(res.status).toBe(200);
    expect(SceneAskResponseSchema.parse(await res.json())).toEqual({
      hazard: 'a knife by the cups',
      answer: 'Cup C is empty.',
      refs: [{ label: 'cup C', objectId: 'cup_c', point: [0.5, 0.7], box: null }],
      model: 'scene-test',
      latencyMs: 900,
    });
    expect(seen).toEqual([REQUEST]);
  });

  it('answers 502 when the smart model fails', async () => {
    const scene = asker(async () => {
      throw new Error('Gemini did not answer within 8 s');
    });
    const h = await harness({ scene });
    const res = await h.request('POST', ApiPaths.sceneAsk, REQUEST);
    expect(res.status).toBe(502);
    expect(ApiErrorSchema.parse(await res.json()).error).toEqual({
      code: 'upstream_failed',
      message: 'Closer look failed: Gemini did not answer within 8 s',
    });
  });

  it('validates the request', async () => {
    const h = await harness({
      scene: asker(async () => ({ hazard: null, answer: 'a', refs: [] })),
    });
    const post = (body: unknown) => h.request('POST', ApiPaths.sceneAsk, body);
    expect((await post({ ...REQUEST, images: [] })).status).toBe(400);
    expect((await post({ ...REQUEST, images: [IMAGE, IMAGE, IMAGE] })).status).toBe(400);
    expect((await post({ ...REQUEST, question: '?' })).status).toBe(400);
  });
});

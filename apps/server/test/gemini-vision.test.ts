import type { GenerateContentParameters } from '@google/genai';
import { describe, expect, it } from 'vitest';
import { createGeminiLocator, locateJsonSchema, locatePrompt } from '../src/services/gemini-vision';

const IMAGE = { mimeType: 'image/jpeg' as const, data: '/9j/4AAQSkZJRgABAQ' };
const OBJECTS = [
  { id: 'cap', query: 'blue cap with a windshield symbol' },
  { id: 'jug', query: 'blue jug of washer fluid' },
];

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

const ANSWER = JSON.stringify([
  { id: 'cap', found: true, point: [500, 250], box_2d: [100, 200, 300, 400], confidence: 0.9 },
  { id: 'jug', found: false, point: null, box_2d: null, confidence: 0.1 },
]);

describe('createGeminiLocator', () => {
  it('sends the image and the objects, and converts the answer to our convention', async () => {
    const ai = fakeAi(ANSWER);
    const locator = createGeminiLocator(ai, 'vision-x');
    const answer = await locator.locate({ image: IMAGE, objects: OBJECTS });
    expect(answer.model).toBe('vision-x');
    expect(answer.detections).toEqual([
      {
        id: 'cap',
        found: true,
        point: [0.25, 0.5],
        box: [0.2, 0.1, 0.4, 0.3],
        outline: null,
        confidence: 0.9,
      },
      { id: 'jug', found: false, point: null, box: null, outline: null, confidence: 0 },
    ]);
    expect(ai.calls).toEqual([
      {
        model: 'vision-x',
        contents: [
          {
            role: 'user',
            parts: [
              { inlineData: { mimeType: 'image/jpeg', data: '/9j/4AAQSkZJRgABAQ' } },
              { text: locatePrompt(OBJECTS) },
            ],
          },
        ],
        config: {
          responseMimeType: 'application/json',
          responseJsonSchema: locateJsonSchema(['cap', 'jug']),
          abortSignal: expect.any(AbortSignal),
        },
      },
    ]);
  });

  it('thinks minimally on Gemini 3 models, Robotics-ER 2 among them, and not on older ones', async () => {
    for (const [model, level] of [
      ['gemini-robotics-er-2-preview', 'MINIMAL'],
      ['gemini-3.5-flash-lite', 'MINIMAL'],
      ['gemini-2.5-flash', undefined],
    ] as const) {
      const ai = fakeAi(ANSWER);
      await createGeminiLocator(ai, model).locate({ image: IMAGE, objects: OBJECTS });
      expect(ai.calls[0]?.config?.thinkingConfig?.thinkingLevel).toBe(level);
    }
  });

  it('accepts the list wrapped in an object', async () => {
    const ai = fakeAi(JSON.stringify({ detections: JSON.parse(ANSWER) }));
    const { detections } = await createGeminiLocator(ai, 'v').locate({
      image: IMAGE,
      objects: OBJECTS,
    });
    expect(detections.map((d) => d.id)).toEqual(['cap', 'jug']);
  });

  it('fails on an empty or non-JSON answer', async () => {
    const request = { image: IMAGE, objects: OBJECTS };
    await expect(createGeminiLocator(fakeAi(undefined), 'v').locate(request)).rejects.toThrow(
      /empty/,
    );
    await expect(createGeminiLocator(fakeAi('I see a cap'), 'v').locate(request)).rejects.toThrow(
      /not valid JSON/,
    );
  });
});

describe('locatePrompt', () => {
  it('asks for the graspable center of each object in Gemini coordinates', () => {
    const prompt = locatePrompt(OBJECTS);
    expect(prompt).toContain('- cap: blue cap with a windshield symbol');
    expect(prompt).toContain('- jug: blue jug of washer fluid');
    expect(prompt).toContain('center of the visible, graspable part');
    expect(prompt).toContain('[y, x]');
    expect(prompt).toContain('[ymin, xmin, ymax, xmax]');
    expect(prompt).toContain('0 to 1000');
  });

  it('names each object by its short phrase too, when there is one', () => {
    const prompt = locatePrompt([
      {
        id: 'cap',
        query: 'Round blue cap, front left of the engine bay',
        phrase: 'blue washer cap',
      },
      { id: 'jug', query: 'blue jug of washer fluid' },
    ]);
    expect(prompt).toContain(
      '- cap (blue washer cap): Round blue cap, front left of the engine bay',
    );
    expect(prompt).toContain('- jug: blue jug of washer fluid');
  });
});

describe('locateJsonSchema', () => {
  it('constrains ids to the requested ones and asks for one entry each', () => {
    const schema = locateJsonSchema(['cap', 'jug']) as {
      minItems: number;
      maxItems: number;
      items: { properties: Record<string, unknown>; required: string[] };
    };
    expect(schema).toMatchObject({ type: 'array', minItems: 2, maxItems: 2 });
    expect(schema.items.properties.id).toEqual({ type: 'string', enum: ['cap', 'jug'] });
    expect(schema.items.required).toEqual(['id', 'found', 'point', 'box_2d', 'confidence']);
    expect(schema.items.properties.point).toMatchObject({
      type: ['array', 'null'],
      minItems: 2,
      maxItems: 2,
    });
  });
});

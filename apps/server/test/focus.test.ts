import { ApiErrorSchema, ApiPaths, type FocusRequest, FocusResponseSchema } from '@clio/protocol';
import type { GenerateContentParameters } from '@google/genai';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  COUNT_INSTRUCTION,
  countContents,
  countJsonSchema,
  FOCUS_INSTRUCTION,
  type FocusAnswer,
  type FocusFinder,
  focusContents,
  focusJsonSchema,
  MAX_DESCRIPTION_CHARS,
  parseCount,
  parseFocusAnswer,
  placeAmong,
  withoutPlace,
} from '../src/services/focus';
import { GeminiTimeoutError } from '../src/services/gemini';
import { createGeminiFocusFinder, FOCUS_TIMEOUT_MS } from '../src/services/gemini-focus';
import type { JsonSchema } from '../src/services/plan-schema';
import { harness, steppingClock } from './harness';

// The action focus: Robotics-ER 2 boxes the step's objects in one sharp frame, rewrites what jev
// is told about each, and names the one thing the learner should touch next.

const IMAGE = { mimeType: 'image/jpeg' as const, data: '/9j/4AAQSkZJRgABAQ' };
const REQUEST: FocusRequest = {
  image: IMAGE,
  goal: 'Test an acid and a base with red-cabbage indicator',
  step: { instruction: 'Squeeze the base into cup B.', doneWhen: 'cup B has turned green' },
  objects: [
    {
      id: 'cup_b',
      label: 'cup B',
      phrase: 'white paper cup',
      query: 'White paper cup with a large black letter B, in the middle of three cups',
    },
    { id: 'base_bottle', label: 'base bottle', query: 'Clear squeeze bottle labeled BASE' },
  ],
};
const IDS = ['cup_b', 'base_bottle'];

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

const found = (id: string, box: number[], extra: object = {}) => ({
  id,
  found: true,
  box_2d: box,
  point: [(box[0] ?? 0) / 2 + (box[2] ?? 0) / 2, (box[1] ?? 0) / 2 + (box[3] ?? 0) / 2],
  confidence: 0.9,
  description: `${id} as it looks now`,
  ...extra,
});

const ANSWER = JSON.stringify({
  objects: [
    found('cup_b', [340, 480, 680, 680], { point: [510, 580] }),
    found('base_bottle', [10, 700, 400, 830], { point: [200, 760] }),
  ],
  action: { id: 'base_bottle' },
});

describe('the focus prompt', () => {
  it('sends the frame first, then the goal, the step and the listed objects', () => {
    expect(focusContents(REQUEST)).toEqual([
      {
        role: 'user',
        parts: [
          { inlineData: IMAGE },
          {
            text:
              'Goal: Test an acid and a base with red-cabbage indicator\n' +
              'Step now: Squeeze the base into cup B. Done when: cup B has turned green\n' +
              "Listed objects, the step's own first:\n" +
              '- cup_b (cup B, white paper cup): White paper cup with a large black letter B, ' +
              'in the middle of three cups\n' +
              '- base_bottle (base bottle): Clear squeeze bottle labeled BASE',
          },
        ],
      },
    ]);
  });

  it('says so when no objects are listed, and leaves out what the request omits', () => {
    const [content] = focusContents({
      image: IMAGE,
      step: { instruction: 'Press the red button.' },
      objects: [],
    });
    expect(content?.parts?.at(-1)).toEqual({
      text: 'Step now: Press the red button.\nNo objects are listed.',
    });
  });

  it.each([
    // Gemini's spatial convention, which the answer is converted from.
    '[ymin, xmin, ymax, xmax]',
    '[y, x]',
    'integers from 0 to 1000',
    'center of its graspable part',
    // The look-alike rule (docs/robotics-er.md): never a thing that merely looks similar.
    'never box something else that merely looks similar or could serve the same purpose',
    'Not visible means `found` false',
    // The description is all the detector is told: where it is in the picture and next to what.
    'one short standalone sentence of at most 30 words',
    'a detector given only these words and this picture can check at a glance',
    'what it is and its color',
    'any text or markings',
    'its state',
    'always, both where it is in this picture',
    'and where it is relative to other things in it',
    '"White charger brick at the bottom right, the bottom one of the three chargers, left of the laptop."',
    'Never just a name.',
    'You are asked again every few seconds, so the words follow the view',
    'Relate it to whole things, not to parts of them',
    'correct what the image contradicts',
    // The look-alikes, boxed so Clio counts the object's place among them.
    '(those go in `look_alikes`)',
    'the box_2d of every other thing in the image that a detector could take for it',
    'the two other chargers in a row beside the one listed',
    'so miss none',
    'No actions, no steps',
    // The action: what the hands act on, a listed id, or words of its own.
    'the one physical thing the learner should touch, move or operate next',
    'not where it goes or what holds it',
    '`id` is null',
    'color or material, then the noun',
    'never a position or a state',
    '`action` is null when the step needs nothing touched',
  ])('covers %j', (phrase) => {
    expect(FOCUS_INSTRUCTION).toContain(phrase);
  });
});

describe('focusJsonSchema', () => {
  const props = (s: JsonSchema) => s.properties as Record<string, JsonSchema>;

  it('asks for one entry per listed id, then the action', () => {
    const schema = focusJsonSchema(IDS);
    expect(Object.keys(props(schema))).toEqual(['objects', 'action']);
    expect(schema.required).toEqual(['objects', 'action']);
    const objects = props(schema).objects as JsonSchema;
    expect(objects).toMatchObject({ type: 'array', minItems: 2, maxItems: 2 });
    const item = objects.items as JsonSchema;
    expect(props(item).id).toEqual({ type: 'string', enum: IDS });
    expect(item.required).toEqual([
      'id',
      'found',
      'box_2d',
      'point',
      'confidence',
      'description',
      'look_alikes',
    ]);
    expect(props(item).look_alikes).toMatchObject({ type: 'array', items: { minItems: 4 } });
    expect(props(item).box_2d).toMatchObject({ type: ['array', 'null'], minItems: 4 });
    expect(props(item).description).toMatchObject({ type: ['string', 'null'] });
  });

  it('lets the action be null, or name a listed id, or null for something unlisted', () => {
    const action = props(focusJsonSchema(IDS)).action as JsonSchema;
    expect(action.type).toEqual(['object', 'null']);
    expect(action.required).toEqual(['id']);
    expect(props(action).id).toMatchObject({ type: ['string', 'null'], enum: [...IDS, null] });
    expect(Object.keys(props(action))).toEqual([
      'id',
      'label',
      'phrase',
      'description',
      'found',
      'box_2d',
      'point',
      'confidence',
      'look_alikes',
    ]);
  });

  it('asks only for the action when no objects are listed', () => {
    const schema = focusJsonSchema([]);
    expect(Object.keys(props(schema))).toEqual(['action']);
    expect(props(props(schema).action as JsonSchema).id).toEqual({ type: 'null' });
  });
});

describe('the count', () => {
  it('asks for every thing a detector after the named one could box, count first', () => {
    for (const phrase of [
      'Box every thing in it that a detector looking for the named thing could box',
      'whatever its size, brand or what it is plugged into or sitting on',
      'the one described included',
      'three chargers in a row are three boxes',
      '`count` is how many there are',
      '[ymin, xmin, ymax, xmax]',
    ]) {
      expect(COUNT_INSTRUCTION).toContain(phrase);
    }
    const schema = countJsonSchema();
    expect(Object.keys(schema.properties as object)).toEqual(['count', 'boxes']);
    expect(schema.required).toEqual(['count', 'boxes']);
  });

  it('names the thing by its phrase, without the place an earlier look counted', () => {
    const cup = {
      ...(REQUEST.objects[0] as FocusRequest['objects'][0]),
      query: 'The bottom one of the two white paper cups. White paper cup with a large black B.',
    };
    const [turn] = countContents(IMAGE, cup);
    expect(turn?.parts?.[1]).toEqual({
      text: 'Named thing: white paper cup\nThe one described: White paper cup with a large black B.',
    });
    // The look is asked about the same words, its count to make again.
    const text = focusContents({ ...REQUEST, objects: [cup] })[0]?.parts?.[1]?.text;
    expect(text).toContain(
      '- cup_b (cup B, white paper cup): White paper cup with a large black B.',
    );
  });

  it("reads the count's boxes, and none from an answer it can't read", () => {
    expect(parseCount(JSON.stringify({ count: 1, boxes: [[100, 200, 300, 400]] }))).toEqual([
      [0.2, 0.1, 0.4, 0.3],
    ]);
    expect(parseCount('three')).toEqual([]);
    expect(parseCount(JSON.stringify({ count: 2 }))).toEqual([]);
  });

  it('strips only the place sentence Clio wrote', () => {
    expect(withoutPlace('The rightmost of the three white charger blocks. On the stool.')).toBe(
      'On the stool.',
    );
    expect(withoutPlace('The second from the left of the four glasses. Tall.')).toBe('Tall.');
    expect(withoutPlace('The white cup of the set, on the left.')).toBe(
      'The white cup of the set, on the left.',
    );
  });
});

describe('placeAmong', () => {
  // Boxes in a row left to right, and in a column top to bottom.
  const row = [0.1, 0.4, 0.7, 0.9].map((x): [number, number, number, number] => [
    x,
    0.5,
    x + 0.08,
    0.6,
  ]);
  const column = [0.1, 0.4].map((y): [number, number, number, number] => [0.5, y, 0.6, y + 0.1]);
  const [a, b, c, d] = row as [(typeof row)[0], (typeof row)[0], (typeof row)[0], (typeof row)[0]];

  it('counts the object among look-alikes along the way they spread out', () => {
    expect(placeAmong(c, [a, b], 'white charger block')).toBe(
      'the rightmost of the three white charger blocks',
    );
    expect(placeAmong(a, [b, c], 'white charger block')).toBe(
      'the leftmost of the three white charger blocks',
    );
    expect(placeAmong(b, [a, c], 'paper cup')).toBe('the middle one of the three paper cups');
    expect(placeAmong(c, [a, b, d], 'glass')).toBe('the second from the right of the four glasses');
    expect(placeAmong(b, [a, c, d], 'battery')).toBe(
      'the second from the left of the four batteries',
    );
    const [top, bottom] = column as [(typeof row)[0], (typeof row)[0]];
    expect(placeAmong(bottom, [top], 'drawer')).toBe('the bottom one of the two drawers');
    expect(placeAmong(top, [bottom], 'drawer')).toBe('the top one of the two drawers');
  });

  it('has nothing to say without look-alikes, and ignores the object boxed twice', () => {
    expect(placeAmong(a, [], 'cup')).toBeNull();
    expect(placeAmong(a, [[0.11, 0.5, 0.18, 0.6]], 'cup')).toBeNull();
  });
});

describe('parseFocusAnswer', () => {
  it("puts the object's place among its look-alikes first in what jev is told", () => {
    const charger = {
      id: 'cup_b',
      found: true,
      box_2d: [500, 700, 600, 780],
      point: [550, 740],
      confidence: 0.9,
      description: 'White paper cup on the bench, left of the laptop.',
      // [ymin, xmin, ymax, xmax]: two more cups to its left.
      look_alikes: [
        [500, 100, 600, 180],
        [500, 400, 600, 480],
      ],
    };
    const text = JSON.stringify({ objects: [charger], action: null });
    expect(parseFocusAnswer(text, REQUEST.objects).detections[0]?.description).toBe(
      'The rightmost of the three white paper cups. White paper cup on the bench, left of the laptop.',
    );
    // Already said (the listed words carried it back): not twice.
    const again = {
      ...charger,
      description: 'The rightmost of the three white paper cups, on the bench.',
    };
    const repeated = JSON.stringify({ objects: [again], action: null });
    expect(parseFocusAnswer(repeated, REQUEST.objects).detections[0]?.description).toBe(
      'The rightmost of the three white paper cups, on the bench.',
    );
    // An object listed without a phrase is counted by its label.
    const bottle = { ...charger, id: 'base_bottle' };
    const byLabel = JSON.stringify({ objects: [bottle], action: null });
    expect(parseFocusAnswer(byLabel, REQUEST.objects).detections[1]?.description).toMatch(
      /^The rightmost of the three base bottles\. /,
    );
  });

  it('converts boxes and points to our convention, with each description', () => {
    expect(parseFocusAnswer(ANSWER, REQUEST.objects).detections).toEqual([
      {
        id: 'cup_b',
        found: true,
        box: [0.48, 0.34, 0.68, 0.68],
        point: [0.58, 0.51],
        confidence: 0.9,
        description: 'cup_b as it looks now',
      },
      {
        id: 'base_bottle',
        found: true,
        box: [0.7, 0.01, 0.83, 0.4],
        point: [0.76, 0.2],
        confidence: 0.9,
        description: 'base_bottle as it looks now',
      },
    ]);
  });

  it('clamps coordinates and confidence, and takes the box center without a point', () => {
    const text = JSON.stringify({
      objects: [found('cup_b', [-20, 900, 1200, 1100], { point: null, confidence: 1.7 })],
      action: null,
    });
    expect(parseFocusAnswer(text, REQUEST.objects).detections[0]).toEqual({
      id: 'cup_b',
      found: true,
      box: [0.9, 0, 1, 1],
      point: [1, 0.59],
      confidence: 1,
      description: 'cup_b as it looks now',
    });
  });

  it('answers every listed object once, in order, and drops ids that were not listed', () => {
    const text = JSON.stringify({
      objects: [
        found('ghost', [0, 0, 100, 100]),
        found('base_bottle', [10, 700, 400, 830], { confidence: 0.4 }),
        found('base_bottle', [10, 600, 400, 700], { confidence: 0.8 }),
      ],
      action: null,
    });
    const { detections } = parseFocusAnswer(text, REQUEST.objects);
    expect(detections.map((d) => [d.id, d.found, d.confidence])).toEqual([
      ['cup_b', false, 0],
      ['base_bottle', true, 0.8],
    ]);
  });

  it('gives an object it did not find no place and no words, and cuts long words', () => {
    const text = JSON.stringify({
      objects: [
        { id: 'cup_b', found: false, box_2d: [1, 2, 3, 4], point: null, confidence: 0.3 },
        found('base_bottle', [10, 700, 400, 830], { description: `  ${'w'.repeat(400)} ` }),
      ],
      action: null,
    });
    const [cup, bottle] = parseFocusAnswer(text, REQUEST.objects).detections;
    expect(cup).toEqual({
      id: 'cup_b',
      found: false,
      box: null,
      point: null,
      confidence: 0,
      description: null,
    });
    expect(bottle?.description).toHaveLength(MAX_DESCRIPTION_CHARS);
  });

  it("lights a listed action item with the request's names and its own detection", () => {
    expect(parseFocusAnswer(ANSWER, REQUEST.objects).action).toEqual({
      id: 'base_bottle',
      label: 'base bottle',
      // The request gave no phrase, and neither did the model: the label stands in.
      phrase: 'base bottle',
      description: 'base_bottle as it looks now',
      found: true,
      box: [0.7, 0.01, 0.83, 0.4],
      point: [0.76, 0.2],
      confidence: 0.9,
    });
    const cup = JSON.stringify({
      objects: [{ id: 'cup_b', found: false, box_2d: null, point: null, confidence: 0 }],
      action: { id: 'cup_b', phrase: 'paper cup', box_2d: [0, 0, 500, 500], found: true },
    });
    // A new phrase would start the tracker's track over, and a box beside the detection's
    // would disagree with it.
    expect(parseFocusAnswer(cup, REQUEST.objects).action).toEqual({
      id: 'cup_b',
      label: 'cup B',
      phrase: 'white paper cup',
      description: REQUEST.objects[0]?.query,
      found: false,
      box: null,
      point: null,
      confidence: 0,
    });
  });

  it('takes an item the request omits with words of its own, and an unknown id as one', () => {
    const omitted = {
      label: 'reset button',
      phrase: 'red plastic button',
      description: 'Small round red button left of the power switch',
      found: true,
      box_2d: [100, 200, 300, 400],
      point: [200, 300],
      confidence: 0.8,
    };
    for (const id of [null, 'reset_button']) {
      const text = JSON.stringify({ objects: [], action: { id, ...omitted } });
      expect(parseFocusAnswer(text, REQUEST.objects).action).toEqual({
        id: null,
        label: 'reset button',
        phrase: 'red plastic button',
        description: 'Small round red button left of the power switch',
        found: true,
        box: [0.2, 0.1, 0.4, 0.3],
        point: [0.3, 0.2],
        confidence: 0.8,
      });
    }
  });

  it('has no action when the step needs nothing touched, or an omitted item has no words', () => {
    const action = (value: unknown) =>
      parseFocusAnswer(JSON.stringify({ objects: [], action: value }), REQUEST.objects).action;
    expect(action(null)).toBeNull();
    expect(action('base_bottle')).toBeNull();
    expect(
      action({ id: null, label: 'button', phrase: 'red button', description: ' ' }),
    ).toBeNull();
    expect(parseFocusAnswer(JSON.stringify({ objects: [] }), REQUEST.objects).action).toBeNull();
  });

  it('rejects an answer that is not a JSON object', () => {
    expect(() => parseFocusAnswer('I see a cup', REQUEST.objects)).toThrow(/not valid JSON/);
    expect(() => parseFocusAnswer('[]', REQUEST.objects)).toThrow(/not an object/);
  });
});

describe('createGeminiFocusFinder', () => {
  it('asks Robotics-ER 2 at minimal thinking, with structured output, and reads the answer', async () => {
    const ai = fakeAi(ANSWER);
    const finder = createGeminiFocusFinder(ai, 'gemini-robotics-er-2-preview');
    expect(finder.model).toBe('gemini-robotics-er-2-preview');
    const answer = await finder.focus(REQUEST);
    expect(answer).toEqual(parseFocusAnswer(ANSWER, REQUEST.objects));
    expect(ai.calls).toEqual([
      {
        model: 'gemini-robotics-er-2-preview',
        contents: focusContents(REQUEST),
        config: {
          systemInstruction: FOCUS_INSTRUCTION,
          responseMimeType: 'application/json',
          responseJsonSchema: focusJsonSchema(IDS),
          thinkingConfig: { thinkingLevel: 'MINIMAL' },
          abortSignal: expect.any(AbortSignal),
        },
      },
      // Beside it, the step's own object counted among its look-alikes.
      {
        model: 'gemini-robotics-er-2-preview',
        contents: countContents(IMAGE, REQUEST.objects[0] as FocusRequest['objects'][0]),
        config: {
          systemInstruction: COUNT_INSTRUCTION,
          responseMimeType: 'application/json',
          responseJsonSchema: countJsonSchema(),
          thinkingConfig: { thinkingLevel: 'LOW' },
          abortSignal: expect.any(AbortSignal),
        },
      },
    ]);
  });

  it("counts the step's own object among every look-alike the count boxed, past the look's", async () => {
    // The look saw one other charger of three; the count, asked only that, saw all three.
    const look = JSON.stringify({
      objects: [
        found('cup_b', [700, 450, 800, 550], {
          description: 'The bottom one of the two white paper cups. White paper cup on the stool.',
          look_alikes: [[400, 450, 500, 550]],
        }),
      ],
      action: null,
    });
    const counted = JSON.stringify({
      count: 3,
      boxes: [
        [100, 450, 200, 550],
        [400, 450, 500, 550],
        [700, 450, 800, 550],
      ],
    });
    const ai = {
      calls: [] as GenerateContentParameters[],
      models: {
        generateContent: async (params: GenerateContentParameters) => {
          ai.calls.push(params);
          return { text: params.config?.systemInstruction === COUNT_INSTRUCTION ? counted : look };
        },
      },
    };
    const { detections } = await createGeminiFocusFinder(ai, 'v').focus(REQUEST);
    expect(detections[0]?.description).toBe(
      'The bottom one of the three white paper cups. White paper cup on the stool.',
    );
    // A failed count leaves the look's own look-alikes.
    ai.models.generateContent = async (params: GenerateContentParameters) => {
      if (params.config?.systemInstruction === COUNT_INSTRUCTION) throw new Error('quota');
      return { text: look };
    };
    const fallback = await createGeminiFocusFinder(ai, 'v').focus(REQUEST);
    expect(fallback.detections[0]?.description).toBe(
      'The bottom one of the two white paper cups. White paper cup on the stool.',
    );
  });

  it('asks about an object listed twice once', async () => {
    const ai = fakeAi(ANSWER);
    const [cup, bottle] = REQUEST.objects;
    if (!cup || !bottle) throw new Error('fixture');
    const { detections } = await createGeminiFocusFinder(ai, 'v').focus({
      ...REQUEST,
      objects: [cup, bottle, { ...cup, query: 'another cup' }],
    });
    expect(detections.map((d) => d.id)).toEqual(IDS);
    expect(ai.calls[0]?.config?.responseJsonSchema).toEqual(focusJsonSchema(IDS));
  });

  it('gives up after 8 s with a timeout the route can tell apart', async () => {
    const spy = vi
      .spyOn(AbortSignal, 'timeout')
      .mockImplementation(() =>
        AbortSignal.abort(new DOMException('The operation timed out.', 'TimeoutError')),
      );
    onTestFinished(() => spy.mockRestore());
    const focus = createGeminiFocusFinder(fakeAi(ANSWER), 'v').focus(REQUEST);
    await expect(focus).rejects.toThrow(GeminiTimeoutError);
    await expect(focus).rejects.toThrow('Gemini did not answer within 8 s');
    expect(spy.mock.calls).toEqual([[FOCUS_TIMEOUT_MS], [FOCUS_TIMEOUT_MS]]);
  });

  it('fails on an empty or unreadable answer', async () => {
    await expect(createGeminiFocusFinder(fakeAi(undefined), 'v').focus(REQUEST)).rejects.toThrow(
      /empty/,
    );
    await expect(createGeminiFocusFinder(fakeAi('a cup'), 'v').focus(REQUEST)).rejects.toThrow(
      /not valid JSON/,
    );
  });
});

describe('POST /api/vision/focus', () => {
  const finder = (focus: FocusFinder['focus']): FocusFinder => ({ model: 'focus-test', focus });
  const ANSWERED: FocusAnswer = parseFocusAnswer(ANSWER, REQUEST.objects);

  it('answers 503 without a Gemini key', async () => {
    const h = await harness();
    const res = await h.request('POST', ApiPaths.visionFocus, REQUEST);
    expect(res.status).toBe(503);
    expect(ApiErrorSchema.parse(await res.json()).error.code).toBe('gemini_not_configured');
  });

  it('returns the detections, the action, the model and the measured latency', async () => {
    const seen: FocusRequest[] = [];
    const focus = finder(async (request) => {
      seen.push(request);
      return ANSWERED;
    });
    const h = await harness({ focus, now: steppingClock('2026-10-24T03:15:02.000Z', 2400) });
    const res = await h.request('POST', ApiPaths.visionFocus, REQUEST);
    expect(res.status).toBe(200);
    expect(FocusResponseSchema.parse(await res.json())).toEqual({
      ...ANSWERED,
      model: 'focus-test',
      latencyMs: 2400,
    });
    expect(seen).toEqual([REQUEST]);
  });

  it('asks the focus, not the object finder at CLIO_VISION_URL', async () => {
    const locator = {
      locate: async () => {
        throw new Error('the tracker was asked');
      },
    };
    const h = await harness({ locator, focus: finder(async () => ANSWERED) });
    expect((await h.request('POST', ApiPaths.visionFocus, REQUEST)).status).toBe(200);
  });

  it('answers 504 past its deadline and 502 when the model fails', async () => {
    const timedOut = await harness({
      focus: finder(async () => {
        throw new GeminiTimeoutError(FOCUS_TIMEOUT_MS);
      }),
    });
    const late = await timedOut.request('POST', ApiPaths.visionFocus, REQUEST);
    expect(late.status).toBe(504);
    expect(ApiErrorSchema.parse(await late.json()).error).toEqual({
      code: 'upstream_timeout',
      message: 'Action focus timed out: Gemini did not answer within 8 s',
    });

    const failing = await harness({
      focus: finder(async () => {
        throw new Error('The response was not valid JSON');
      }),
    });
    const bad = await failing.request('POST', ApiPaths.visionFocus, REQUEST);
    expect(bad.status).toBe(502);
    expect(ApiErrorSchema.parse(await bad.json()).error).toEqual({
      code: 'upstream_failed',
      message: 'Action focus failed: The response was not valid JSON',
    });
  });

  it('validates the request', async () => {
    const h = await harness({ focus: finder(async () => ANSWERED) });
    const post = (body: unknown) => h.request('POST', ApiPaths.visionFocus, body);
    const object = REQUEST.objects[0];
    expect((await post({ ...REQUEST, step: { instruction: '' } })).status).toBe(400);
    expect((await post({ ...REQUEST, objects: new Array(9).fill(object) })).status).toBe(400);
    expect((await post({ ...REQUEST, objects: [{ id: 'x', label: 'x', query: '' }] })).status).toBe(
      400,
    );
    expect((await post({ ...REQUEST, image: { mimeType: 'image/gif', data: 'x' } })).status).toBe(
      400,
    );
    expect((await h.request('POST', ApiPaths.visionFocus, '{')).status).toBe(400);
  });
});

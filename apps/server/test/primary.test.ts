import { ApiErrorSchema, type PrimaryRequest, PrimaryResponseSchema } from '@clio/protocol';
import type { GenerateContentParameters } from '@google/genai';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import type { Logger } from '../src/log';
import { createGeminiLocator } from '../src/services/gemini-vision';
import { createHttpLocator } from '../src/services/http-vision';
import {
  createGeminiPrimaryPicker,
  createPrimaryObjectFinder,
  PRIMARY_JSON_SCHEMA,
  type PrimaryObjectFinder,
  primaryPrompt,
} from '../src/services/primary-object';
import { captureLogger, harness, steppingClock } from './harness';

// The primary-object demo: Gemini names the main object in a camera frame, then the object
// finder (jev boxes refined by SAM 2.1) outlines it, with Gemini's locator standing in when the
// finder is down. Gemini and the finder's network are fakes; everything between them is real.

const PATH = '/api/vision/primary';
const FINDER_URL = 'http://127.0.0.1:8790/locate';
const IMAGE = { mimeType: 'image/jpeg' as const, data: '/9j/4AAQSkZJRgABAQ' };
const NAME = 'red screwdriver';
const DESCRIPTION =
  'Red plastic screwdriver handle with a silver steel shaft, lying diagonally just right of ' +
  'the center of the frame';
const PICKED = JSON.stringify({ present: true, name: NAME, description: DESCRIPTION });
const NOTHING = JSON.stringify({ present: false, name: '', description: '' });

/** Never answers: like the real client, it rejects only when its abortSignal aborts. */
const STALL = Symbol('stall');

/** Answers each generateContent call with the next text, and records the calls. */
function fakeGemini(...texts: (string | Error | typeof STALL)[]) {
  const calls: GenerateContentParameters[] = [];
  return {
    calls,
    prompts: () =>
      calls.map((call) => {
        const [content] = call.contents as { parts: { text?: string }[] }[];
        return content?.parts.find((p) => p.text !== undefined)?.text ?? '';
      }),
    models: {
      generateContent: async (params: GenerateContentParameters) => {
        calls.push(params);
        const text = texts.shift();
        if (text instanceof Error) throw text;
        if (text === STALL) {
          return new Promise<never>((_, reject) => {
            const signal = params.config?.abortSignal;
            signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          });
        }
        return { text };
      },
    },
  };
}

/** A finder at FINDER_URL: answers with `respond`, or refuses connections like a stopped server. */
function fakeFinder(respond: (() => Response) | 'down') {
  const bodies: unknown[] = [];
  const fetch = async (_input: string | URL | Request, init: RequestInit = {}) => {
    bodies.push(JSON.parse(String(init.body)));
    if (respond === 'down') {
      throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED') });
    }
    return respond();
  };
  return { bodies, fetch: fetch as typeof globalThis.fetch };
}

const json = (body: unknown) => () =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

const OUTLINE: [number, number][] = [
  [0.52, 0.4],
  [0.66, 0.44],
  [0.64, 0.6],
  [0.5, 0.56],
];
const FINDER_ANSWER = {
  model: 'jev+sam2.1',
  detections: [{ id: 'primary', outline: OUTLINE, point: [0.58, 0.5], confidence: 0.82 }],
};

function primaryFinder(
  gemini: ReturnType<typeof fakeGemini>,
  finder: ReturnType<typeof fakeFinder>,
  logger: Logger = captureLogger(),
  geminiTimeoutMs?: number,
) {
  return createPrimaryObjectFinder({
    picker: createGeminiPrimaryPicker(gemini, 'vision-x'),
    finder: createHttpLocator({ url: FINDER_URL, fetch: finder.fetch }),
    fallback: createGeminiLocator(gemini, 'vision-x'),
    logger,
    now: steppingClock('2026-10-24T03:15:02.000Z', 250),
    ...(geminiTimeoutMs !== undefined && { geminiTimeoutMs }),
  });
}

async function setup(
  gemini: ReturnType<typeof fakeGemini>,
  finder: ReturnType<typeof fakeFinder>,
  logger: Logger = captureLogger(),
) {
  const h = await harness({ primary: primaryFinder(gemini, finder, logger), logger });
  return (body: unknown) => h.request('POST', PATH, body);
}

async function primaryAnswer(res: Response) {
  expect(res.status).toBe(200);
  return PrimaryResponseSchema.parse(await res.json());
}

describe('POST /api/vision/primary', () => {
  it('names the main object with Gemini and outlines it with the finder', async () => {
    const gemini = fakeGemini(PICKED);
    const finder = fakeFinder(json(FINDER_ANSWER));
    const post = await setup(gemini, finder);
    expect(await primaryAnswer(await post({ image: IMAGE }))).toEqual({
      name: NAME,
      description: DESCRIPTION,
      detection: {
        id: 'primary',
        found: true,
        point: [0.58, 0.5],
        box: [0.5, 0.4, 0.66, 0.6],
        outline: OUTLINE,
        confidence: 0.82,
      },
      model: { picker: 'vision-x', finder: 'jev+sam2.1' },
      timings: { pickMs: 250, findMs: 250 },
    });
    expect(gemini.calls).toEqual([
      {
        model: 'vision-x',
        contents: [
          {
            role: 'user',
            parts: [{ inlineData: IMAGE }, { text: primaryPrompt() }],
          },
        ],
        config: {
          responseMimeType: 'application/json',
          responseJsonSchema: PRIMARY_JSON_SCHEMA,
          abortSignal: expect.any(AbortSignal),
        },
      },
    ]);
    expect(finder.bodies).toEqual([
      { image: IMAGE, objects: [{ id: 'primary', query: DESCRIPTION, phrase: NAME }] },
    ]);
  });

  it('names nothing when no object stands out, and does not ask the finder', async () => {
    for (const answer of [NOTHING, JSON.stringify({ present: true, name: ' ', description: '' })]) {
      const finder = fakeFinder(json(FINDER_ANSWER));
      const post = await setup(fakeGemini(answer), finder);
      expect(await primaryAnswer(await post({ image: IMAGE }))).toEqual({
        name: null,
        description: null,
        detection: null,
        model: { picker: 'vision-x', finder: 'none' },
        timings: { pickMs: 250, findMs: 0 },
      });
      expect(finder.bodies).toEqual([]);
    }
  });

  it('asks Gemini to keep the previous name while that object is still in view', async () => {
    const gemini = fakeGemini(PICKED, PICKED);
    const post = await setup(gemini, fakeFinder(json(FINDER_ANSWER)));
    const request: PrimaryRequest = { image: IMAGE, previous: { name: NAME } };
    await primaryAnswer(await post(request));
    await primaryAnswer(await post({ image: IMAGE }));
    const [withPrevious, without] = gemini.prompts();
    expect(withPrevious).toBe(primaryPrompt({ name: NAME }));
    expect(withPrevious).toContain('The last object named was "red screwdriver"');
    expect(withPrevious).toContain('return exactly that name');
    expect(without).not.toContain('last object');
  });

  it('keeps a name whose object the finder could not find, with no detection', async () => {
    const gemini = fakeGemini(PICKED);
    const post = await setup(
      gemini,
      fakeFinder(json({ model: 'jev+sam2.1', detections: [{ id: 'primary', found: false }] })),
    );
    expect(await primaryAnswer(await post({ image: IMAGE }))).toMatchObject({
      name: NAME,
      detection: null,
      model: { picker: 'vision-x', finder: 'jev+sam2.1' },
    });
    expect(gemini.calls).toHaveLength(1);
  });

  it("boxes with Gemini's locator while the finder is down, and says so once", async () => {
    const located = JSON.stringify([
      {
        id: 'primary',
        found: true,
        point: [500, 580],
        box_2d: [400, 500, 600, 660],
        confidence: 0.7,
      },
    ]);
    const gemini = fakeGemini(PICKED, located, PICKED, located);
    const finder = fakeFinder('down');
    const logger = captureLogger();
    const post = await setup(gemini, finder, logger);
    for (let i = 0; i < 2; i++) {
      expect(await primaryAnswer(await post({ image: IMAGE }))).toEqual({
        name: NAME,
        description: DESCRIPTION,
        detection: {
          id: 'primary',
          found: true,
          point: [0.58, 0.5],
          box: [0.5, 0.4, 0.66, 0.6],
          outline: null,
          confidence: 0.7,
        },
        model: { picker: 'vision-x', finder: 'vision-x' },
        timings: { pickMs: 250, findMs: 250 },
      });
    }
    expect(finder.bodies).toHaveLength(2);
    expect(gemini.prompts()[1]).toContain(`- primary (${NAME}): ${DESCRIPTION}`);
    expect(logger.lines.filter((l) => l.startsWith('warn'))).toEqual([
      `warn primary: Object finder at ${FINDER_URL} is unreachable: connect ECONNREFUSED. ` +
        'Boxing with Gemini instead.',
    ]);
  });

  it('falls back when the finder answers with an error, and logs when it recovers', async () => {
    const gemini = fakeGemini(PICKED, '[]', PICKED);
    let status = 500;
    const finder = fakeFinder(() =>
      status === 500 ? new Response('CUDA out of memory', { status }) : json(FINDER_ANSWER)(),
    );
    const logger = captureLogger();
    const post = await setup(gemini, finder, logger);
    expect(await primaryAnswer(await post({ image: IMAGE }))).toMatchObject({
      detection: null,
      model: { finder: 'vision-x' },
    });
    status = 200;
    expect(await primaryAnswer(await post({ image: IMAGE }))).toMatchObject({
      model: { finder: 'jev+sam2.1' },
    });
    expect(logger.lines.filter((l) => l.includes('primary: '))).toEqual([
      'warn primary: Object finder answered 500: CUDA out of memory. Boxing with Gemini instead.',
      expect.stringContaining('info primary: "red screwdriver" not found'),
      'info primary: the object finder answers again',
      expect.stringContaining('info primary: "red screwdriver" found'),
    ]);
  });

  it('answers 502 when naming fails, or when the finder and the fallback both fail', async () => {
    const naming = await setup(fakeGemini(new Error('quota exceeded')), fakeFinder('down'));
    let res = await naming({ image: IMAGE });
    expect(res.status).toBe(502);
    expect(ApiErrorSchema.parse(await res.json()).error).toEqual({
      code: 'upstream_failed',
      message: 'Primary object request failed: Naming the main object failed: quota exceeded',
    });

    const finding = await setup(
      fakeGemini(PICKED, new Error('deadline exceeded')),
      fakeFinder('down'),
    );
    res = await finding({ image: IMAGE });
    expect(res.status).toBe(502);
    expect(ApiErrorSchema.parse(await res.json()).error.message).toBe(
      `Primary object request failed: Object finder at ${FINDER_URL} is unreachable: connect ` +
        'ECONNREFUSED, and the fallback failed too: deadline exceeded',
    );
  });

  it("passes the request's abort signal to the service", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const primary: PrimaryObjectFinder = {
      find: async (_request, signal) => {
        signals.push(signal);
        throw new Error('stop here');
      },
    };
    const h = await harness({ primary });
    expect((await h.request('POST', PATH, { image: IMAGE })).status).toBe(502);
    expect(signals).toEqual([expect.any(AbortSignal)]);
  });

  it('validates the request', async () => {
    const gemini = fakeGemini();
    const post = await setup(gemini, fakeFinder(json(FINDER_ANSWER)));
    for (const body of [
      {},
      { image: { ...IMAGE, mimeType: 'image/gif' } },
      { image: IMAGE, previous: { name: '' } },
      { image: IMAGE, previous: 'red screwdriver' },
    ]) {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(ApiErrorSchema.parse(await res.json()).error.code).toBe('validation_failed');
    }
    expect(gemini.calls).toEqual([]);
  });

  it('answers 503 without a Gemini key', async () => {
    const h = await harness();
    const res = await h.request('POST', PATH, { image: IMAGE });
    expect(res.status).toBe(503);
    expect(ApiErrorSchema.parse(await res.json()).error.code).toBe('gemini_not_configured');
  });
});

describe('createGeminiPrimaryPicker', () => {
  it('fails on an empty, non-JSON or misshapen answer', async () => {
    const pick = (text: string | undefined) =>
      createGeminiPrimaryPicker(fakeGemini(text as string), 'v').pick({ image: IMAGE });
    await expect(pick(undefined)).rejects.toThrow(/empty/);
    await expect(pick('a red screwdriver')).rejects.toThrow(/not valid JSON/);
    await expect(pick(JSON.stringify({ name: NAME }))).rejects.toThrow(/present/);
  });

  it('trims the answer and falls back to the name when the description is blank', async () => {
    const answer = JSON.stringify({ present: true, name: ` ${NAME} `, description: ' ' });
    expect(await createGeminiPrimaryPicker(fakeGemini(answer), 'v').pick({ image: IMAGE })).toEqual(
      { name: NAME, description: NAME },
    );
  });
});

describe('CLIO_PRIMARY_FINDER_URL', () => {
  it('defaults to the local jev + SAM service and must be an http(s) URL', () => {
    expect(loadConfig({}, '/repo').primaryFinderUrl).toBe(FINDER_URL);
    expect(loadConfig({ CLIO_PRIMARY_FINDER_URL: '' }, '/repo').primaryFinderUrl).toBe(FINDER_URL);
    expect(
      loadConfig({ CLIO_PRIMARY_FINDER_URL: ' http://10.0.0.5:9000/locate ' }, '/repo')
        .primaryFinderUrl,
    ).toBe('http://10.0.0.5:9000/locate');
    expect(() => loadConfig({ CLIO_PRIMARY_FINDER_URL: 'localhost:8790' }, '/repo')).toThrow(
      /CLIO_PRIMARY_FINDER_URL/,
    );
  });
});

describe('createPrimaryObjectFinder bounds', () => {
  it('gives up on a Gemini pick that takes too long, and cancels it', async () => {
    const gemini = fakeGemini(STALL);
    const finder = fakeFinder(json(FINDER_ANSWER));
    const primary = primaryFinder(gemini, finder, captureLogger(), 20);
    await expect(primary.find({ image: IMAGE })).rejects.toThrow(
      'Naming the main object failed: Gemini took longer than 20 ms',
    );
    expect(gemini.calls[0]?.config?.abortSignal?.aborted).toBe(true);
    expect(finder.bodies).toEqual([]);
  });

  it('gives up on a fallback that takes too long', async () => {
    const primary = primaryFinder(fakeGemini(PICKED, STALL), fakeFinder('down'), undefined, 20);
    await expect(primary.find({ image: IMAGE })).rejects.toThrow(
      'and the fallback failed too: Gemini took longer than 20 ms',
    );
  });

  it('does not ask the finder once the client has stopped waiting', async () => {
    const controller = new AbortController();
    const finder = fakeFinder(json(FINDER_ANSWER));
    const primary = createPrimaryObjectFinder({
      picker: {
        model: 'vision-x',
        pick: async () => {
          controller.abort();
          return { name: NAME, description: DESCRIPTION };
        },
      },
      finder: createHttpLocator({ url: FINDER_URL, fetch: finder.fetch }),
      fallback: createGeminiLocator(fakeGemini(), 'vision-x'),
      logger: captureLogger(),
    });
    await expect(primary.find({ image: IMAGE }, controller.signal)).rejects.toThrow(
      'the request was cancelled',
    );
    expect(finder.bodies).toEqual([]);
  });

  it('cancels a pick in flight when the client stops waiting', async () => {
    const controller = new AbortController();
    const gemini = fakeGemini(STALL);
    const finder = fakeFinder(json(FINDER_ANSWER));
    const found = primaryFinder(gemini, finder).find({ image: IMAGE }, controller.signal);
    controller.abort();
    await expect(found).rejects.toThrow('Naming the main object failed: the request was cancelled');
    expect(gemini.calls[0]?.config?.abortSignal?.aborted).toBe(true);
    expect(finder.bodies).toEqual([]);
  });
});

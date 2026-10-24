import type { LocateRequest, PrimaryRequest, PrimaryResponse } from '@clio/protocol';
import { prettifyError, z } from 'zod';
import { describeError, type Logger } from '../log';
import type { GenerateContentApi } from './gemini';
import { parseModelJson } from './model-json';
import type { JsonSchema } from './plan-schema';
import { alignDetections, type LocateAnswer, type VisionLocator } from './vision';

// The primary-object demo (POST /api/vision/primary). Gemini names the single most prominent
// object in a camera frame, then the object finder at CLIO_PRIMARY_FINDER_URL (tracker/: jev
// confirms it, YOLOE-26 outlines and follows it) finds it. While that finder is down or failing,
// Gemini's own locator boxes the object instead, so the headset draws corner brackets rather
// than nothing.

/** The id the finder is asked about, and the id of the returned detection. */
export const PRIMARY_ID = 'primary';
/** `model.finder` when nothing was named, so no finder was asked. */
export const NO_FINDER = 'none';
/**
 * The bound on each Gemini call (naming, and boxing while the finder is down). Naming, the
 * finder's own 15 s timeout and the fallback add up to under the headset's 30 s, so a request
 * it has given up on cannot still start a jev call afterwards.
 */
export const GEMINI_TIMEOUT_MS = 6_000;

export interface PrimaryPick {
  /** 2 to 4 word noun phrase, sent to the finder as the phrase. */
  name: string;
  /** Purely visual description, sent to the finder as the query. */
  description: string;
}

/** Port: names the main object in a frame, or null when nothing stands out. */
export interface PrimaryPicker {
  readonly model: string;
  /** `signal` aborts when the request is cancelled or takes too long. */
  pick(request: PrimaryRequest, signal?: AbortSignal): Promise<PrimaryPick | null>;
}

export function primaryPrompt(previous?: { name: string }): string {
  return [
    'This is a camera frame from a headset. Name the single most prominent physical object ' +
      'near the center of view that a person could pick up or work with. Ignore hands, arms, ' +
      'people, walls, the floor, the ceiling and the table surface itself.',
    ...(previous
      ? [
          `The last object named was ${JSON.stringify(previous.name)}. If it is still clearly ` +
            'in view, return exactly that name.',
        ]
      : []),
    '',
    'name is a 2 to 4 word noun phrase, such as "red screwdriver". description is 12 to 30 ' +
      'words and purely visual: the color, shape and material of the object, and where it is ' +
      'in the frame. If there is no such object, set present to false and name and description ' +
      'to empty strings.',
  ].join('\n');
}

export const PRIMARY_JSON_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    present: { type: 'boolean', description: 'Such an object is in view' },
    name: { type: 'string', description: '2 to 4 word noun phrase; empty when not present' },
    description: {
      type: 'string',
      description: '12 to 30 words: color, shape, material, where it is in the frame',
    },
  },
  required: ['present', 'name', 'description'],
};

const PickAnswerSchema = z.object({
  present: z.boolean(),
  name: z.string(),
  description: z.string(),
});

export function createGeminiPrimaryPicker(ai: GenerateContentApi, model: string): PrimaryPicker {
  return {
    model,
    async pick({ image, previous }, signal) {
      const response = await ai.models.generateContent({
        model,
        contents: [
          {
            role: 'user',
            parts: [
              { inlineData: { mimeType: image.mimeType, data: image.data } },
              { text: primaryPrompt(previous) },
            ],
          },
        ],
        config: {
          responseMimeType: 'application/json',
          responseJsonSchema: PRIMARY_JSON_SCHEMA,
          ...(signal && { abortSignal: signal }),
        },
      });
      if (!response.text) throw new Error('Gemini returned an empty response');
      const json = parseModelJson(response.text);
      if (!json.ok) throw new Error(json.error);
      const answer = PickAnswerSchema.safeParse(json.value);
      if (!answer.success) {
        throw new Error(
          `Gemini's answer is not { present, name, description }: ${prettifyError(answer.error)}`,
        );
      }
      const name = answer.data.name.trim();
      if (!answer.data.present || name === '') return null;
      return { name, description: answer.data.description.trim() || name };
    },
  };
}

// --- Pick, then find -------------------------------------------------------------------------

export interface PrimaryObjectFinder {
  /** `signal` aborts when the client stops waiting: no finder call starts after that. */
  find(request: PrimaryRequest, signal?: AbortSignal): Promise<PrimaryResponse>;
}

export interface PrimaryObjectOptions {
  picker: PrimaryPicker;
  /** The tracker (jev + YOLOE-26), through the HTTP locator: outlines clamped and simplified. */
  finder: VisionLocator;
  /** Gemini's locator: a box and a point, used when the finder is unreachable or fails. */
  fallback: VisionLocator;
  logger: Logger;
  now?: () => Date;
  geminiTimeoutMs?: number;
}

export function createPrimaryObjectFinder({
  picker,
  finder,
  fallback,
  logger,
  now = () => new Date(),
  geminiTimeoutMs = GEMINI_TIMEOUT_MS,
}: PrimaryObjectOptions): PrimaryObjectFinder {
  const since = (started: number) => Math.max(0, now().getTime() - started);
  // The headset asks every few seconds, so say when the finder goes down or comes back, not on
  // every request. jev calls are never retried: one that timed out may still be billed.
  let finderDown = false;

  async function locate(request: LocateRequest, signal?: AbortSignal): Promise<LocateAnswer> {
    throwIfCancelled(signal);
    let finderError: unknown;
    try {
      const answer = await finder.locate(request);
      if (finderDown) logger.info('primary: the object finder answers again');
      finderDown = false;
      return answer;
    } catch (error) {
      finderError = error;
      if (!finderDown) logger.warn(`primary: ${describeError(error)}. Boxing with Gemini instead.`);
      finderDown = true;
    }
    try {
      return await bounded('Gemini', geminiTimeoutMs, signal, () => fallback.locate(request));
    } catch (error) {
      throw new Error(
        `${describeError(finderError)}, and the fallback failed too: ${describeError(error)}`,
      );
    }
  }

  return {
    async find(request, signal) {
      const pickStarted = now().getTime();
      let pick: PrimaryPick | null;
      try {
        pick = await bounded('Gemini', geminiTimeoutMs, signal, (bound) =>
          picker.pick(request, bound),
        );
      } catch (error) {
        throw new Error(`Naming the main object failed: ${describeError(error)}`);
      }
      const pickMs = since(pickStarted);
      if (!pick) {
        return {
          name: null,
          description: null,
          detection: null,
          model: { picker: picker.model, finder: NO_FINDER },
          timings: { pickMs, findMs: 0 },
        };
      }
      const findStarted = now().getTime();
      const answer = await locate(
        {
          image: request.image,
          objects: [{ id: PRIMARY_ID, query: pick.description, phrase: pick.name }],
        },
        signal,
      );
      const findMs = since(findStarted);
      const [detection] = alignDetections([PRIMARY_ID], answer.detections);
      return {
        name: pick.name,
        description: pick.description,
        detection: detection?.found ? detection : null,
        model: { picker: picker.model, finder: answer.model },
        timings: { pickMs, findMs },
      };
    },
  };
}

// --- Cancellation ----------------------------------------------------------------------------

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error('the request was cancelled');
}

/**
 * `work` until it settles, `signal` aborts or `timeoutMs` passes, whichever is first. `work` gets
 * a signal that aborts on either, to cancel its own request; work that ignores it is abandoned.
 */
async function bounded<T>(
  what: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  throwIfCancelled(signal);
  const timeout = AbortSignal.timeout(timeoutMs);
  const bound = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let stop = () => {};
  const aborted = new Promise<never>((_, reject) => {
    const onAbort = () =>
      reject(
        new Error(
          timeout.aborted
            ? `${what} took longer than ${timeoutMs} ms`
            : 'the request was cancelled',
        ),
      );
    bound.addEventListener('abort', onAbort, { once: true });
    stop = () => bound.removeEventListener('abort', onAbort);
  });
  try {
    return await Promise.race([work(bound), aborted]);
  } finally {
    stop();
  }
}

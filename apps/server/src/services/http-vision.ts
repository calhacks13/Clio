import type { Detection, NormalizedPoint } from '@clio/protocol';
import { prettifyError, z } from 'zod';
import { describeError } from '../log';
import {
  boxCenter,
  clamp01,
  notFound,
  orderedBox,
  outlineBounds,
  simplifyOutline,
  type VisionLocator,
} from './vision';

// An external object finder behind CLIO_VISION_URL (jev, a segmenter on a GPU box, anything that
// speaks HTTP). Clio POSTs its LocateRequest as JSON and accepts { detections, model?,
// refreshMs? }. Each detection needs only an id and any of point, box or outline, in 0..1 of the
// image; Clio fills in the rest and simplifies long outlines. The contract is in
// docs/object-finder.md.

export interface HttpLocatorOptions {
  url: string;
  /** Sent as `Authorization: Bearer <token>` when set. */
  token?: string | null;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

/** Segmenters on a laptop GPU can take a few seconds per frame. */
export const DEFAULT_FINDER_TIMEOUT_MS = 15_000;
const FINDER = 'Object finder';

const PointSchema = z.tuple([z.number(), z.number()]);
const FinderDetectionSchema = z.object({
  id: z.string().min(1),
  found: z.boolean().optional(),
  point: PointSchema.nullish(),
  box: z.tuple([z.number(), z.number(), z.number(), z.number()]).nullish(),
  outline: z.array(PointSchema).nullish(),
  confidence: z.number().nullish(),
});
const FinderAnswerSchema = z.object({
  detections: z.array(FinderDetectionSchema),
  model: z.string().trim().min(1).optional(),
  refreshMs: z.number().int().nonnegative().max(60_000).optional(),
});
type FinderDetection = z.infer<typeof FinderDetectionSchema>;

export function createHttpLocator(options: HttpLocatorOptions): VisionLocator {
  const { url, token, timeoutMs = DEFAULT_FINDER_TIMEOUT_MS, fetch = globalThis.fetch } = options;
  return {
    async locate(request) {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (token) headers.authorization = `Bearer ${token}`;
      let status: number;
      let text: string;
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(timeoutMs),
        });
        status = response.status;
        text = await response.text();
      } catch (error) {
        throw new Error(requestFailure(error, url, timeoutMs));
      }
      if (status < 200 || status > 299) {
        throw new Error(`${FINDER} answered ${status}${text.trim() ? `: ${snippet(text)}` : ''}`);
      }
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        throw new Error(`${FINDER} answer is not valid JSON: ${snippet(text)}`);
      }
      const answer = FinderAnswerSchema.safeParse(body);
      if (!answer.success) {
        throw new Error(
          `${FINDER} answer is not { detections: [...] }: ${prettifyError(answer.error)}`,
        );
      }
      const { refreshMs } = answer.data;
      return {
        detections: answer.data.detections.map(fromFinderDetection),
        model: answer.data.model ?? 'http',
        ...(refreshMs !== undefined && { refreshMs }),
      };
    },
  };
}

/** Normalizes one finder detection: derives box and point from what it has, clamps, simplifies. */
export function fromFinderDetection(raw: FinderDetection): Detection {
  requireUnitCoordinates(raw);
  const outline = raw.outline ? simplifyOutline(raw.outline.map(clampPoint)) : null;
  const box = raw.box
    ? orderedBox([
        clamp01(raw.box[0]),
        clamp01(raw.box[1]),
        clamp01(raw.box[2]),
        clamp01(raw.box[3]),
      ])
    : outline && outlineBounds(outline);
  const point = raw.point ? clampPoint(raw.point) : box && boxCenter(box);
  if (raw.found === false || !point) return notFound(raw.id);
  return {
    id: raw.id,
    found: true,
    point,
    box,
    outline,
    confidence: clamp01(raw.confidence ?? 0.5),
  };
}

const clampPoint = ([x, y]: [number, number]): NormalizedPoint => [clamp01(x), clamp01(y)];

/** Slightly-off values are clamped; values far outside 0..1 mean the finder sent pixels. */
function requireUnitCoordinates(raw: FinderDetection): void {
  const values = [...(raw.point ?? []), ...(raw.box ?? []), ...(raw.outline ?? []).flat()];
  const bad = values.find((v) => v < -0.5 || v > 1.5);
  if (bad !== undefined) {
    throw new Error(
      `${FINDER} returned ${bad} for ${raw.id}, which looks like pixel coordinates: Clio expects ` +
        '0..1 of the image width and height',
    );
  }
}

function requestFailure(error: unknown, url: string, timeoutMs: number): string {
  const name =
    typeof error === 'object' && error !== null ? (error as { name?: unknown }).name : '';
  if (name === 'TimeoutError') return `${FINDER} timed out after ${timeoutMs} ms`;
  const cause = error instanceof Error ? error.cause : undefined;
  if (cause !== undefined) return `${FINDER} at ${url} is unreachable: ${describeError(cause)}`;
  return `${FINDER} request failed: ${describeError(error)}`;
}

const snippet = (text: string) => text.trim().replace(/\s+/g, ' ').slice(0, 200);

import type { Detection, LocateRequest } from '@clio/protocol';
import { isRecord } from './model-json';

// The vision port plus pure conversions. Gemini's spatial convention is integers in 0..1000 with
// y before x: point [y, x], box_2d [ymin, xmin, ymax, xmax]. Ours (LocateResponse) is 0..1 with
// x right and y down: point [x, y], box [x0, y0, x1, y1].

export interface VisionLocator {
  readonly model: string;
  /** Detections in our convention. May skip or repeat ids: the route aligns them to the request. */
  locate(request: LocateRequest): Promise<Detection[]>;
}

type Point = [number, number];
type Box = [number, number, number, number];

const SCALE = 1000;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const unit = (v: number) => clamp01(v / SCALE);
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function numbers(value: unknown, length: number): number[] | null {
  return Array.isArray(value) && value.length === length && value.every(isFiniteNumber)
    ? value
    : null;
}

export function fromGeminiPoint(point: unknown): Point | null {
  const p = numbers(point, 2);
  if (!p) return null;
  const [y = 0, x = 0] = p;
  return [unit(x), unit(y)];
}

export function fromGeminiBox(box: unknown): Box | null {
  const b = numbers(box, 4);
  if (!b) return null;
  const [ya = 0, xa = 0, yb = 0, xb = 0] = b;
  return [
    unit(Math.min(xa, xb)),
    unit(Math.min(ya, yb)),
    unit(Math.max(xa, xb)),
    unit(Math.max(ya, yb)),
  ];
}

function boxCenter(box: unknown): Point | null {
  const b = numbers(box, 4);
  if (!b) return null;
  const [ya = 0, xa = 0, yb = 0, xb = 0] = b;
  return fromGeminiPoint([(ya + yb) / 2, (xa + xb) / 2]);
}

export function notFound(id: string): Detection {
  return { id, found: false, point: null, box: null, outline: null, confidence: 0 };
}

/** One Gemini entry `{ id, found, point, box_2d, confidence }` → Detection (null without an id). */
export function fromGeminiDetection(raw: unknown): Detection | null {
  if (!isRecord(raw) || typeof raw.id !== 'string') return null;
  const point = fromGeminiPoint(raw.point) ?? boxCenter(raw.box_2d);
  if (raw.found !== true || !point) return notFound(raw.id);
  return {
    id: raw.id,
    found: true,
    point,
    box: fromGeminiBox(raw.box_2d),
    outline: null,
    confidence: isFiniteNumber(raw.confidence) ? clamp01(raw.confidence) : 0.5,
  };
}

/** Exactly one detection per requested id, in request order (first answer wins per id). */
export function alignDetections(ids: readonly string[], detections: readonly Detection[]) {
  const byId = new Map<string, Detection>();
  for (const d of detections) if (!byId.has(d.id)) byId.set(d.id, d);
  return [...new Set(ids)].map((id) => byId.get(id) ?? notFound(id));
}

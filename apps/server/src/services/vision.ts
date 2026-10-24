import type {
  Detection,
  LocateRequest,
  NormalizedBox,
  NormalizedPoint,
  NormalizedPolygon,
} from '@clio/protocol';
import { isRecord } from './model-json';

// The vision port plus pure conversions. Ours (LocateResponse) is 0..1 with x right and y down:
// point [x, y], box [x0, y0, x1, y1], outline [[x, y], ...]. Gemini's spatial convention is
// integers in 0..1000 with y before x: point [y, x], box_2d [ymin, xmin, ymax, xmax].

export interface LocateAnswer {
  /** In our convention. May skip or repeat ids: the route aligns them to the request. */
  detections: Detection[];
  /** The model that answered. The headset records it as each detection's source. */
  model: string;
  /** A tracking finder's hint: how soon to send the next frame. */
  refreshMs?: number;
}

/** Port: an object finder (Gemini, or an external service such as jev behind CLIO_VISION_URL). */
export interface VisionLocator {
  locate(request: LocateRequest): Promise<LocateAnswer>;
}

const SCALE = 1000;
export const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const unit = (v: number) => clamp01(v / SCALE);
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function numbers(value: unknown, length: number): number[] | null {
  return Array.isArray(value) && value.length === length && value.every(isFiniteNumber)
    ? value
    : null;
}

export function fromGeminiPoint(point: unknown): NormalizedPoint | null {
  const p = numbers(point, 2);
  if (!p) return null;
  const [y = 0, x = 0] = p;
  return [unit(x), unit(y)];
}

export function fromGeminiBox(box: unknown): NormalizedBox | null {
  const b = numbers(box, 4);
  if (!b) return null;
  const [ya = 0, xa = 0, yb = 0, xb = 0] = b;
  return orderedBox([unit(xa), unit(ya), unit(xb), unit(yb)]);
}

/** The box center, averaged in Gemini's integer space so it stays exact. */
function geminiBoxCenter(box: unknown): NormalizedPoint | null {
  const b = numbers(box, 4);
  if (!b) return null;
  const [ya = 0, xa = 0, yb = 0, xb = 0] = b;
  return fromGeminiPoint([(ya + yb) / 2, (xa + xb) / 2]);
}

/** [x0, y0, x1, y1] with x0 <= x1 and y0 <= y1, whichever corners it was given. */
export function orderedBox([xa, ya, xb, yb]: NormalizedBox): NormalizedBox {
  return [Math.min(xa, xb), Math.min(ya, yb), Math.max(xa, xb), Math.max(ya, yb)];
}

export function boxCenter([x0, y0, x1, y1]: NormalizedBox): NormalizedPoint {
  return [(x0 + x1) / 2, (y0 + y1) / 2];
}

export function outlineBounds(outline: NormalizedPolygon): NormalizedBox {
  const xs = outline.map((p) => p[0]);
  const ys = outline.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

export function notFound(id: string): Detection {
  return { id, found: false, point: null, box: null, outline: null, confidence: 0 };
}

/** One Gemini entry `{ id, found, point, box_2d, confidence }` → Detection (null without an id). */
export function fromGeminiDetection(raw: unknown): Detection | null {
  if (!isRecord(raw) || typeof raw.id !== 'string') return null;
  const point = fromGeminiPoint(raw.point) ?? geminiBoxCenter(raw.box_2d);
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

/**
 * Exactly one detection per requested id, in request order. When a finder answers an id more than
 * once (segmenters return every instance of a phrase), a found one beats a miss and the most
 * confident wins; ties keep the first.
 */
export function alignDetections(ids: readonly string[], detections: readonly Detection[]) {
  const best = new Map<string, Detection>();
  for (const d of detections) {
    const current = best.get(d.id);
    if (!current || rank(d) > rank(current)) best.set(d.id, d);
  }
  return [...new Set(ids)].map((id) => best.get(id) ?? notFound(id));
}

const rank = (d: Detection) => (d.found ? 1 + d.confidence : 0);

// --- Outlines ----------------------------------------------------------------------------------

/** Plenty for an AR outline, and it keeps each recorded object.detected event small. */
export const MAX_OUTLINE_POINTS = 64;

const same = (a: NormalizedPoint, b: NormalizedPoint) => a[0] === b[0] && a[1] === b[1];

/**
 * A closed outline with at most `maxPoints` vertices that keeps its shape (Douglas–Peucker, with
 * the tolerance doubled until it fits). Mask contours from a segmenter run to thousands of points.
 * Null when fewer than three distinct points remain.
 */
export function simplifyOutline(
  points: readonly NormalizedPoint[],
  maxPoints = MAX_OUTLINE_POINTS,
): NormalizedPolygon | null {
  const ring = points.filter((p, i) => i === 0 || !same(p, points[i - 1] as NormalizedPoint));
  while (ring.length > 1 && same(ring[0] as NormalizedPoint, ring.at(-1) as NormalizedPoint)) {
    ring.pop();
  }
  if (ring.length < 3) return null;
  if (ring.length <= maxPoints) return ring;
  for (let tolerance = 0.001; tolerance < 1; tolerance *= 2) {
    const simple = simplifyRing(ring, tolerance);
    if (simple.length < 3) break;
    if (simple.length <= maxPoints) return simple;
  }
  // A sliver that simplification collapses: fall back to evenly spaced vertices.
  const step = ring.length / maxPoints;
  return Array.from({ length: maxPoints }, (_, i) => ring[Math.floor(i * step)] as NormalizedPoint);
}

/** Splits the ring at its first point and the point farthest from it, and simplifies each half. */
function simplifyRing(ring: NormalizedPoint[], tolerance: number): NormalizedPoint[] {
  const first = ring[0] as NormalizedPoint;
  let far = 1;
  for (let i = 2; i < ring.length; i++) {
    if (distance(first, ring[i] as NormalizedPoint) > distance(first, ring[far] as NormalizedPoint))
      far = i;
  }
  const a = simplifyChain(ring.slice(0, far + 1), tolerance);
  const b = simplifyChain([...ring.slice(far), first], tolerance);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

/** Douglas–Peucker on an open chain; keeps both ends. Iterative, so long chains cannot overflow. */
function simplifyChain(chain: NormalizedPoint[], tolerance: number): NormalizedPoint[] {
  const keep = new Array<boolean>(chain.length).fill(false);
  keep[0] = true;
  keep[chain.length - 1] = true;
  const spans: [number, number][] = [[0, chain.length - 1]];
  for (let span = spans.pop(); span; span = spans.pop()) {
    const [from, to] = span;
    let worst = -1;
    let worstDistance = tolerance;
    for (let i = from + 1; i < to; i++) {
      const d = distanceToSegment(
        chain[i] as NormalizedPoint,
        chain[from] as NormalizedPoint,
        chain[to] as NormalizedPoint,
      );
      if (d > worstDistance) {
        worst = i;
        worstDistance = d;
      }
    }
    if (worst > 0) {
      keep[worst] = true;
      spans.push([from, worst], [worst, to]);
    }
  }
  return chain.filter((_, i) => keep[i]);
}

function distance(a: NormalizedPoint, b: NormalizedPoint): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function distanceToSegment(p: NormalizedPoint, a: NormalizedPoint, b: NormalizedPoint): number {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return distance(p, a);
  const s = clamp01(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSq);
  return Math.hypot(p[0] - (a[0] + s * dx), p[1] - (a[1] + s * dy));
}

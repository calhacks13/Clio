// Flat strokes for AR outlines: triangles along a 2D polyline lying in a plane (z = 0), a few
// millimeters wide. WebGL draws GL lines one pixel wide, which all but vanishes in a headset.

export type Point2 = readonly [number, number];

export interface Stroke {
  /** x, y, 0 for each vertex: two per input point. */
  positions: Float32Array;
  indices: Uint16Array;
}

export interface StrokeOptions {
  width: number;
  /** Join the last point back to the first. */
  closed: boolean;
  /** For a closed shape: lay the stroke just outside the line, so it never covers the object. */
  outside?: boolean;
  /** Longest corner extension, in half-widths, before a sharp corner is clipped. */
  miterLimit?: number;
}

const EMPTY: Stroke = { positions: new Float32Array(0), indices: new Uint16Array(0) };

/** The unit normal to the left of a → b. */
function leftOf(a: Point2, b: Point2): [number, number] {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = Math.hypot(dx, dy) || 1;
  return [-dy / length, dx / length];
}

/** Twice the signed area: positive when the polygon winds counterclockwise (y up). */
function windingArea(points: readonly Point2[]): number {
  let area = 0;
  for (const [i, [x, y]] of points.entries()) {
    const [nx, ny] = points[(i + 1) % points.length] as Point2;
    area += x * ny - nx * y;
  }
  return area;
}

export function strokePolyline(points: readonly Point2[], options: StrokeOptions): Stroke {
  const n = points.length;
  if (n < 2) return EMPTY;
  const { width, closed, miterLimit = 4 } = options;
  // Left normals point inside a counterclockwise polygon, so outside is against them.
  const outward = closed && options.outside ? (windingArea(points) > 0 ? -1 : 1) : 0;
  const positions = new Float32Array(n * 2 * 3);
  for (let i = 0; i < n; i++) {
    const p = points[i] as Point2;
    const prev = points[closed ? (i - 1 + n) % n : Math.max(i - 1, 0)] as Point2;
    const next = points[closed ? (i + 1) % n : Math.min(i + 1, n - 1)] as Point2;
    const before = closed || i > 0 ? leftOf(prev, p) : leftOf(p, next);
    const after = closed || i < n - 1 ? leftOf(p, next) : leftOf(prev, p);
    let mx = before[0] + after[0];
    let my = before[1] + after[1];
    const m = Math.hypot(mx, my);
    if (m < 1e-9) [mx, my] = before;
    else [mx, my] = [mx / m, my / m];
    // The miter grows as 1 / cos(half the turn); clip it at needle-sharp corners.
    const stretch = Math.min(1 / Math.max(mx * before[0] + my * before[1], 1e-6), miterLimit);
    const [from, to] = outward === 0 ? [-0.5, 0.5] : [outward, 0];
    positions.set(
      [p[0] + mx * from * width * stretch, p[1] + my * from * width * stretch, 0],
      i * 6,
    );
    positions.set(
      [p[0] + mx * to * width * stretch, p[1] + my * to * width * stretch, 0],
      i * 6 + 3,
    );
  }
  const segments = closed ? n : n - 1;
  const indices = new Uint16Array(segments * 6);
  for (let s = 0; s < segments; s++) {
    const a = s * 2;
    const b = ((s + 1) % n) * 2;
    indices.set([a, a + 1, b + 1, a, b + 1, b], s * 6);
  }
  return { positions, indices };
}

/** An L at each corner of a polygon (a box), along `share` of each adjacent edge. */
export function cornerBrackets(corners: readonly Point2[], share: number): Point2[][] {
  const along = (from: Point2, to: Point2): Point2 => [
    from[0] + (to[0] - from[0]) * share,
    from[1] + (to[1] - from[1]) * share,
  ];
  return corners.map((corner, i) => {
    const prev = corners[(i - 1 + corners.length) % corners.length] as Point2;
    const next = corners[(i + 1) % corners.length] as Point2;
    return [along(corner, prev), corner, along(corner, next)];
  });
}

/** Several strokes as one. */
export function mergeStrokes(strokes: readonly Stroke[]): Stroke {
  const positions = new Float32Array(strokes.reduce((n, s) => n + s.positions.length, 0));
  const indices = new Uint16Array(strokes.reduce((n, s) => n + s.indices.length, 0));
  let p = 0;
  let k = 0;
  for (const s of strokes) {
    positions.set(s.positions, p);
    indices.set(
      s.indices.map((index) => index + p / 3),
      k,
    );
    p += s.positions.length;
    k += s.indices.length;
  }
  return { positions, indices };
}

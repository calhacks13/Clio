// Plane polygons in their own 2D frame (WebXR plane space x and z, the normal along +y).

export type Point2 = readonly [number, number];

/** Area-weighted center; the vertex mean for a degenerate (zero-area) polygon. */
export function polygonCentroid(polygon: readonly Point2[]): [number, number] {
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (const [i, [x, y]] of polygon.entries()) {
    const [nx, ny] = polygon[(i + 1) % polygon.length] as Point2;
    const cross = x * ny - nx * y;
    area += cross;
    cx += (x + nx) * cross;
    cy += (y + ny) * cross;
  }
  if (Math.abs(area) > 1e-9) return [cx / (3 * area), cy / (3 * area)];
  const n = Math.max(polygon.length, 1);
  return [
    polygon.reduce((sum, p) => sum + p[0], 0) / n,
    polygon.reduce((sum, p) => sum + p[1], 0) / n,
  ];
}

/** Where the line `axis = c` crosses the polygon's edges, as the other coordinate, sorted. */
function crossings(polygon: readonly Point2[], axis: 0 | 1, c: number): number[] {
  const other = axis === 0 ? 1 : 0;
  const hits: number[] = [];
  for (const [i, a] of polygon.entries()) {
    const b = polygon[(i + 1) % polygon.length] as Point2;
    // Half-open, so a line through a vertex counts it once.
    if (a[axis] <= c === b[axis] <= c) continue;
    const t = (c - a[axis]) / (b[axis] - a[axis]);
    hits.push(a[other] + (b[other] - a[other]) * t);
  }
  return hits.sort((x, y) => x - y);
}

/**
 * Grid lines every `spacing` m along both axes, aligned to the plane's origin and clipped to the
 * polygon's inside (even-odd, so concave outlines work). Lines on the outline itself are left out.
 */
export function polygonGrid(polygon: readonly Point2[], spacing: number): [Point2, Point2][] {
  if (polygon.length < 3 || spacing <= 0) return [];
  const segments: [Point2, Point2][] = [];
  for (const axis of [0, 1] as const) {
    const values = polygon.map((p) => p[axis]);
    const first = Math.floor(Math.min(...values) / spacing + 1e-6) + 1;
    const last = Math.ceil(Math.max(...values) / spacing - 1e-6) - 1;
    for (let k = first; k <= last; k++) {
      const c = k * spacing;
      const hits = crossings(polygon, axis, c);
      for (let i = 0; i + 1 < hits.length; i += 2) {
        const from = hits[i] ?? 0;
        const to = hits[i + 1] ?? 0;
        segments.push(
          axis === 0
            ? [
                [c, from],
                [c, to],
              ]
            : [
                [from, c],
                [to, c],
              ],
        );
      }
    }
  }
  return segments;
}

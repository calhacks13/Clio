import { DataTexture, HalfFloatType, LinearFilter, RedFormat } from 'three';
import { INTERIOR_POINTS } from './glow/depth-occlusion';
import type { Point2 } from './stroke';

// The glow's only CPU work: the signed distance to the silhouette, rebuilt when a new mask
// arrives (~25 a second). Everything soft (the rim, the bloom, the depth) is shaped from it in
// the glow's fragment shader.
//
// The distance is exact, to a smooth curve, at every texel, so the light shows neither the texel
// grid nor the segmenter's straight facets:
//   - each contour is resampled to a point every few texels and rounded by Chaikin corner cutting
//     (two passes: a quadratic B-spline through the mask's polygon whose corners round off over a
//     few millimetres, so the shape itself is kept);
//   - each texel near a segment measures its exact distance to it, then two raster sweeps hand each
//     texel its neighbours' nearest segments and keep the closest (dead reckoning), so every
//     texel holds the true distance to a nearby segment of the curve, never a grid estimate;
//   - inside or outside comes from an even-odd scanline through the texel centres.
// One half-float channel stores distance / field size; WebGL2 filters R16F linearly at full
// precision (two packed 8-bit bytes do not: mobile GPUs filter them at 8 bits and the high byte
// steps between texels). Updates allocate nothing.

const SIZE = 192;
const FAR = 1e20;
const SMOOTHING_PASSES = 2;
/** Interior points are picked from a grid this many texels apart. */
const INTERIOR_STRIDE = 6;
/** Contours are resampled to this spacing (texels) first, so smoothing rounds corners locally. */
const SPACING = 3;
/** ...but to no more than this many points per contour. */
const MAX_POINTS = 2048;

/** Where the field lies on the outline's plane: a square of `size` metres centred on (x, y). */
export interface FieldBounds {
  x: number;
  y: number;
  size: number;
}

export class HighlightMask {
  static readonly SIZE = SIZE;
  private readonly halfs = new Uint16Array(SIZE * SIZE);
  /** Squared distance (texels) to the nearest segment found so far, and that segment. */
  private readonly best = new Float32Array(SIZE * SIZE);
  private readonly owner = new Int32Array(SIZE * SIZE);
  private readonly inside = new Uint8Array(SIZE * SIZE);
  /** Smoothed segments in texel units: start, direction, 1 / length squared. */
  private ax = new Float64Array(1024);
  private ay = new Float64Array(1024);
  private dx = new Float64Array(1024);
  private dy = new Float64Array(1024);
  private inv = new Float64Array(1024);
  /** The segments before and after each one along its contour. */
  private prev = new Int32Array(1024);
  private next = new Int32Array(1024);
  /** First segment of each path, and one past its last. */
  private pathStart = new Int32Array(16);
  private pathCount = 0;
  /** Chaikin ping-pong buffers (x, y interleaved). */
  private curveA = new Float64Array(2048);
  private curveB = new Float64Array(2048);
  private crossings = new Float64Array(256);
  /** Segments by the texel rows they cross: rowSegments[rowStart[r]..rowStart[r + 1]). */
  private readonly rowStart = new Int32Array(SIZE + 1);
  private rowSegments = new Int32Array(4096);
  /** best, read as float bits for the half-float conversion. */
  private readonly bits = new Uint32Array(this.best.buffer);
  /**
   * Up to INTERIOR_POINTS points well inside the silhouette, as (u, v) in the field (0..1): where
   * the glow reads the depth map for the object's own front (glow/depth-occlusion.ts).
   */
  readonly interior = new Float32Array(INTERIOR_POINTS * 2);
  interiorCount = 0;
  private readonly candidates = new Int32Array(Math.ceil(SIZE / INTERIOR_STRIDE) ** 2);
  private readonly bounds: FieldBounds = { x: 0, y: 0, size: 1 };
  readonly texture = new DataTexture(this.halfs, SIZE, SIZE, RedFormat, HalfFloatType);

  constructor() {
    this.texture.internalFormat = 'R16F';
    this.texture.minFilter = LinearFilter;
    this.texture.magFilter = LinearFilter;
    this.texture.generateMipmaps = false;
  }

  /**
   * The signed distance (positive inside) to the smoothed union of `paths`, over a square that
   * bounds them plus `padding` on every side. Returns that square (the same object every call),
   * or null for no shape. Corners round off over about `rounding` metres (at least a few texels):
   * the soft rim should not follow a crease sharper than itself.
   */
  update(paths: readonly (readonly Point2[])[], padding: number, rounding = 0): FieldBounds | null {
    let left = Number.POSITIVE_INFINITY;
    let right = Number.NEGATIVE_INFINITY;
    let bottom = Number.POSITIVE_INFINITY;
    let top = Number.NEGATIVE_INFINITY;
    let vertices = 0;
    let usable = 0;
    for (const path of paths) {
      if (path.length < 3) continue;
      usable++;
      vertices += path.length;
      for (const [x, y] of path) {
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < bottom) bottom = y;
        if (y > top) top = y;
      }
    }
    if (usable === 0 || !(right > left) || !(top > bottom)) {
      this.halfs.fill(0);
      this.interiorCount = 0;
      this.texture.needsUpdate = true;
      return null;
    }
    const size = Math.max(right - left, top - bottom) + padding * 2;
    const { bounds } = this;
    bounds.x = (left + right) / 2;
    bounds.y = (bottom + top) / 2;
    bounds.size = size;
    this.reserve((vertices + usable * MAX_POINTS) << SMOOTHING_PASSES, usable);
    const minX = bounds.x - size / 2;
    const segments = this.buildSegments(paths, minX, bounds.y - size / 2, size, rounding);
    this.classify(segments);
    this.best.fill(FAR);
    this.owner.fill(-1);
    for (let s = 0; s < segments; s++) this.seed(s);
    this.sweep(true);
    this.sweep(false);
    const { best, bits, inside, halfs } = this;
    const scale = 1 / SIZE;
    for (let i = 0; i < halfs.length; i++) {
      // Distance as a share of the field (within +-1, where half floats are finest near the edge),
      // converted to a half float from its float bits; below 2^-14 of the field it is 0.
      const d = Math.sqrt(best[i] as number) * scale;
      best[i] = inside[i] ? d : -d;
      const x = bits[i] as number;
      const exponent = ((x >>> 23) & 0xff) - 112;
      halfs[i] =
        exponent <= 0
          ? 0
          : ((x >>> 16) & 0x8000) | ((exponent << 10) + (((x & 0x7fffff) + 0x1000) >>> 13));
    }
    this.pickInterior();
    this.texture.needsUpdate = true;
    return bounds;
  }

  /**
   * Interior points, spread over the silhouette: texels of a coarse grid at least a few texels
   * inside (any inside texel, or the deepest one, for a sliver), every k-th of them in scan order.
   */
  private pickInterior(): void {
    const { best, candidates, interior } = this;
    let count = 0;
    for (let pass = 0; pass < 2; pass++) {
      count = 0;
      const min = (pass === 0 ? 3 : 0.5) / SIZE;
      for (let row = INTERIOR_STRIDE >> 1; row < SIZE; row += INTERIOR_STRIDE) {
        for (let col = INTERIOR_STRIDE >> 1; col < SIZE; col += INTERIOR_STRIDE) {
          const i = row * SIZE + col;
          if ((best[i] as number) >= min) candidates[count++] = i;
        }
      }
      if (count >= 4) break;
    }
    if (count === 0) {
      // Thinner than the grid: its deepest texel.
      let deepest = -1;
      for (let i = 0; i < best.length; i++) {
        if (
          (best[i] as number) > 0 &&
          (deepest < 0 || (best[i] as number) > (best[deepest] as number))
        ) {
          deepest = i;
        }
      }
      if (deepest >= 0) candidates[count++] = deepest;
    }
    const n = Math.min(INTERIOR_POINTS, count);
    for (let k = 0; k < n; k++) {
      const i = candidates[Math.floor(((k + 0.5) * count) / n)] as number;
      interior[k * 2] = ((i % SIZE) + 0.5) / SIZE;
      interior[k * 2 + 1] = (Math.floor(i / SIZE) + 0.5) / SIZE;
    }
    this.interiorCount = n;
  }

  private reserve(points: number, paths: number): void {
    if (this.ax.length < points) {
      const n = points * 2;
      this.ax = new Float64Array(n);
      this.ay = new Float64Array(n);
      this.dx = new Float64Array(n);
      this.dy = new Float64Array(n);
      this.inv = new Float64Array(n);
      this.prev = new Int32Array(n);
      this.next = new Int32Array(n);
      this.curveA = new Float64Array(n * 2);
      this.curveB = new Float64Array(n * 2);
      this.crossings = new Float64Array(n);
    }
    if (this.pathStart.length < paths + 1) this.pathStart = new Int32Array((paths + 1) * 2);
  }

  /** Smooths each path into texel-space segments; returns how many. */
  private buildSegments(
    paths: readonly (readonly Point2[])[],
    minX: number,
    minY: number,
    size: number,
    rounding: number,
  ): number {
    const k = SIZE / size;
    let segments = 0;
    let p = 0;
    for (const path of paths) {
      if (path.length < 3) continue;
      this.pathStart[p++] = segments;
      let a = this.curveA;
      let b = this.curveB;
      let perimeter = 0;
      for (let i = 0; i < path.length; i++) {
        const [x0, y0] = path[i] as Point2;
        const [x1, y1] = path[(i + 1) % path.length] as Point2;
        perimeter += Math.hypot(x1 - x0, y1 - y0) * k;
      }
      const spacing = Math.max(SPACING, rounding * k, perimeter / MAX_POINTS);
      // Every edge split into pieces no longer than the spacing (its corners kept).
      let n = 0;
      for (let i = 0; i < path.length; i++) {
        const [x0, y0] = path[i] as Point2;
        const [x1, y1] = path[(i + 1) % path.length] as Point2;
        const pieces = Math.max(1, Math.ceil((Math.hypot(x1 - x0, y1 - y0) * k) / spacing));
        for (let j = 0; j < pieces; j++) {
          const t = j / pieces;
          a[n * 2] = (x0 + (x1 - x0) * t - minX) * k;
          a[n * 2 + 1] = (y0 + (y1 - y0) * t - minY) * k;
          n++;
        }
      }
      // Chaikin: each edge's points at 1/4 and 3/4 replace its corners.
      for (let pass = 0; pass < SMOOTHING_PASSES; pass++) {
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n;
          const x0 = a[i * 2] as number;
          const y0 = a[i * 2 + 1] as number;
          const x1 = a[j * 2] as number;
          const y1 = a[j * 2 + 1] as number;
          b[i * 4] = 0.75 * x0 + 0.25 * x1;
          b[i * 4 + 1] = 0.75 * y0 + 0.25 * y1;
          b[i * 4 + 2] = 0.25 * x0 + 0.75 * x1;
          b[i * 4 + 3] = 0.25 * y0 + 0.75 * y1;
        }
        n *= 2;
        const swap = a;
        a = b;
        b = swap;
      }
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const x0 = a[i * 2] as number;
        const y0 = a[i * 2 + 1] as number;
        const ex = (a[j * 2] as number) - x0;
        const ey = (a[j * 2 + 1] as number) - y0;
        const length2 = ex * ex + ey * ey;
        this.ax[segments] = x0;
        this.ay[segments] = y0;
        this.dx[segments] = ex;
        this.dy[segments] = ey;
        this.inv[segments] = length2 > 1e-12 ? 1 / length2 : 0;
        this.prev[segments] = i === 0 ? segments + n - 1 : segments - 1;
        this.next[segments] = i === n - 1 ? segments - n + 1 : segments + 1;
        segments++;
      }
    }
    this.pathStart[p] = segments;
    this.pathCount = p;
    return segments;
  }

  /** Even-odd per path through each row of texel centres; the paths are unioned. */
  private classify(segments: number): void {
    const { inside, crossings, pathStart, ax, ay, dx, dy, pathCount, rowStart } = this;
    inside.fill(0);
    // Bucket the segments by row (a counting sort), so each row only sees its own crossings.
    rowStart.fill(0);
    let entries = 0;
    for (let s = 0; s < segments; s++) {
      const y0 = ay[s] as number;
      const y1 = y0 + (dy[s] as number);
      const from = Math.max(0, Math.ceil(Math.min(y0, y1) - 0.5));
      const to = Math.min(SIZE - 1, Math.floor(Math.max(y0, y1) - 0.5));
      for (let r = from; r <= to; r++) rowStart[r + 1] = (rowStart[r + 1] as number) + 1;
      entries += Math.max(0, to - from + 1);
    }
    if (this.rowSegments.length < entries) this.rowSegments = new Int32Array(entries * 2);
    const { rowSegments } = this;
    for (let r = 0; r < SIZE; r++)
      rowStart[r + 1] = (rowStart[r + 1] as number) + (rowStart[r] as number);
    // Fill (rowStart temporarily holds each row's write position, then is restored).
    for (let s = 0; s < segments; s++) {
      const y0 = ay[s] as number;
      const y1 = y0 + (dy[s] as number);
      const from = Math.max(0, Math.ceil(Math.min(y0, y1) - 0.5));
      const to = Math.min(SIZE - 1, Math.floor(Math.max(y0, y1) - 0.5));
      for (let r = from; r <= to; r++) {
        rowSegments[rowStart[r] as number] = s;
        rowStart[r] = (rowStart[r] as number) + 1;
      }
    }
    for (let r = SIZE; r > 0; r--) rowStart[r] = rowStart[r - 1] as number;
    rowStart[0] = 0;
    for (let row = 0; row < SIZE; row++) {
      const y = row + 0.5;
      const end = rowStart[row + 1] as number;
      let k = rowStart[row] as number;
      // The row's segments are in index order, so each path's are together.
      for (let p = 0; p < pathCount && k < end; p++) {
        const last = pathStart[p + 1] as number;
        let count = 0;
        for (; k < end && (rowSegments[k] as number) < last; k++) {
          const s = rowSegments[k] as number;
          const y0 = ay[s] as number;
          const y1 = y0 + (dy[s] as number);
          if (y0 > y === y1 > y) continue;
          crossings[count++] = (ax[s] as number) + ((y - y0) * (dx[s] as number)) / (y1 - y0);
        }
        sortRange(crossings, 0, count);
        for (let i = 0; i + 1 < count; i += 2) {
          const from = Math.max(0, Math.ceil((crossings[i] as number) - 0.5));
          const to = Math.min(SIZE - 1, Math.floor((crossings[i + 1] as number) - 0.5));
          for (let col = from; col <= to; col++) inside[row * SIZE + col] = 1;
        }
      }
    }
  }

  /** Exact distances from the texels around segment `s` (its box, one texel wider). */
  private seed(s: number): void {
    const x0 = this.ax[s] as number;
    const y0 = this.ay[s] as number;
    const x1 = x0 + (this.dx[s] as number);
    const y1 = y0 + (this.dy[s] as number);
    const c0 = Math.max(0, Math.floor(Math.min(x0, x1) - 1.5));
    const c1 = Math.min(SIZE - 1, Math.ceil(Math.max(x0, x1) + 0.5));
    const r0 = Math.max(0, Math.floor(Math.min(y0, y1) - 1.5));
    const r1 = Math.min(SIZE - 1, Math.ceil(Math.max(y0, y1) + 0.5));
    const { best, owner } = this;
    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        const i = row * SIZE + col;
        const d = distance2(this.ax, this.ay, this.dx, this.dy, this.inv, s, col + 0.5, row + 0.5);
        if (d < (best[i] as number)) {
          best[i] = d;
          owner[i] = s;
        }
      }
    }
  }

  /**
   * One raster sweep. Each texel tries the nearest segments of the two neighbours already swept
   * (along the row, and across from the previous row). In the backward sweep it then walks along
   * the contour from the best one while that brings the curve closer: the nearest point is often a
   * few segments further on.
   */
  private sweep(forward: boolean): void {
    const { best, owner, ax, ay, dx, dy, inv, next, prev } = this;
    const step = forward ? 1 : -1;
    for (let r = 0; r < SIZE; r++) {
      const row = forward ? r : SIZE - 1 - r;
      const across = row - step >= 0 && row - step < SIZE ? -step * SIZE : 0;
      const y = row + 0.5;
      for (let c = 0; c < SIZE; c++) {
        const col = forward ? c : SIZE - 1 - c;
        const i = row * SIZE + col;
        const x = col + 0.5;
        let mine = owner[i] as number;
        let d = best[i] as number;
        if (col - step >= 0 && col - step < SIZE) {
          const s = owner[i - step] as number;
          if (s >= 0 && s !== mine) {
            const e = distance2(ax, ay, dx, dy, inv, s, x, y);
            if (e < d) {
              d = e;
              mine = s;
            }
          }
        }
        if (across !== 0) {
          // Across, diagonally behind, diagonally ahead.
          for (let n = -1; n <= 1; n++) {
            const nc = col + n * step;
            if (nc < 0 || nc >= SIZE) continue;
            const s = owner[i + across + n * step] as number;
            if (s >= 0 && s !== mine) {
              const e = distance2(ax, ay, dx, dy, inv, s, x, y);
              if (e < d) {
                d = e;
                mine = s;
              }
            }
          }
        }
        // The forward sweep hands segments on; the backward one also walks to the nearest.
        if (mine < 0 || forward) {
          best[i] = d;
          owner[i] = mine;
          continue;
        }
        let s = next[mine] as number;
        let e = distance2(ax, ay, dx, dy, inv, s, x, y);
        const link = e < d ? next : prev;
        if (link === prev) {
          s = prev[mine] as number;
          e = distance2(ax, ay, dx, dy, inv, s, x, y);
        }
        while (e < d) {
          d = e;
          mine = s;
          s = link[s] as number;
          e = distance2(ax, ay, dx, dy, inv, s, x, y);
        }
        best[i] = d;
        owner[i] = mine;
      }
    }
  }
}

/** Squared distance (texels) from (x, y) to segment s. */
function distance2(
  ax: Float64Array,
  ay: Float64Array,
  dx: Float64Array,
  dy: Float64Array,
  inv: Float64Array,
  s: number,
  x: number,
  y: number,
): number {
  const px = x - (ax[s] as number);
  const py = y - (ay[s] as number);
  const ex = dx[s] as number;
  const ey = dy[s] as number;
  const t = Math.min(1, Math.max(0, (px * ex + py * ey) * (inv[s] as number)));
  const qx = px - t * ex;
  const qy = py - t * ey;
  return qx * qx + qy * qy;
}

/** Insertion sort of a[from..to): a scanline crosses a contour only a handful of times. */
function sortRange(a: Float64Array, from: number, to: number): void {
  for (let i = from + 1; i < to; i++) {
    const v = a[i] as number;
    let j = i - 1;
    while (j >= from && (a[j] as number) > v) {
      a[j + 1] = a[j] as number;
      j--;
    }
    a[j + 1] = v;
  }
}

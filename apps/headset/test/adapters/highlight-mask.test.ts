import { DataUtils } from 'three';
import { describe, expect, it } from 'vitest';
import { type FieldBounds, HighlightMask } from '../../src/adapters/render/highlight-mask';
import type { Point2 } from '../../src/adapters/render/stroke';

const SQUARE: Point2[] = [
  [-0.05, -0.05],
  [0.05, -0.05],
  [0.05, 0.05],
  [-0.05, 0.05],
];
const PADDING = 0.024;

/** The signed distance (m) at (x, y), filtered between texel centres like the GPU does. */
function sampler(mask: HighlightMask, bounds: FieldBounds) {
  const { data, width } = mask.texture.image;
  if (!data) throw new Error('Missing distance-field texture');
  const at = (col: number, row: number) => {
    const c = Math.min(width - 1, Math.max(0, col));
    const r = Math.min(width - 1, Math.max(0, row));
    return DataUtils.fromHalfFloat(data[r * width + c] ?? 0) * bounds.size;
  };
  return (x: number, y: number) => {
    const u = ((x - bounds.x) / bounds.size + 0.5) * width - 0.5;
    const v = ((y - bounds.y) / bounds.size + 0.5) * width - 0.5;
    const c = Math.floor(u);
    const r = Math.floor(v);
    const fu = u - c;
    const fv = v - r;
    const top = at(c, r) * (1 - fu) + at(c + 1, r) * fu;
    const bottom = at(c, r + 1) * (1 - fu) + at(c + 1, r + 1) * fu;
    return top * (1 - fv) + bottom * fv;
  };
}

describe('HighlightMask', () => {
  it('measures continuous physical distance on both sides of an edge and around its corner', () => {
    const mask = new HighlightMask();
    const bounds = mask.update([SQUARE], PADDING);
    if (!bounds) throw new Error('Missing bounds');
    expect(bounds).toMatchObject({ x: 0, y: 0 });
    expect(bounds.size).toBeCloseTo(0.148);
    // Exact distances, filtered between texel centres: well within a tenth of a millimetre.
    const texel = bounds.size / HighlightMask.SIZE;
    const d = sampler(mask, bounds);
    // On the ridge between edges, filtering between texel centres undershoots by under a texel.
    expect(Math.abs(d(0, 0) - 0.05)).toBeLessThan(texel);
    expect(Math.abs(d(0.045, 0) - 0.005)).toBeLessThan(1e-4);
    expect(Math.abs(d(0.05, 0))).toBeLessThan(1e-4);
    expect(Math.abs(d(0.055, 0) + 0.005)).toBeLessThan(1e-4);
    // The corner is rounded: it lies farther from a point beyond it than the sharp corner did.
    expect(d(0.06, 0.06)).toBeLessThan(-Math.SQRT2 * 0.01);
    expect(d(0.06, 0.06)).toBeGreaterThan(-0.025);
    // No plateau, binary cutoff or reversal where the light crosses the measured boundary.
    const ramp = Array.from({ length: 21 }, (_, i) => d(0.04 + i * 0.001, 0));
    for (let i = 1; i < ramp.length; i++) expect(ramp[i]).toBeLessThan(ramp[i - 1] ?? 0);
    mask.texture.dispose();
  });

  it('places an edge between texels, not on the texel grid', () => {
    const mask = new HighlightMask();
    // Moving the square by a fifth of a texel moves its measured edge by as much.
    const bounds = mask.update([SQUARE], PADDING);
    if (!bounds) throw new Error('Missing bounds');
    const texel = bounds.size / HighlightMask.SIZE;
    const before = sampler(mask, { ...bounds })(0.05, 0);
    const shifted = SQUARE.map(([x, y]): Point2 => [x + texel / 5, y]);
    const after = mask.update([shifted], PADDING);
    if (!after) throw new Error('Missing bounds');
    const moved = sampler(mask, { ...after })(0.05, 0);
    expect(Math.abs(moved - before - texel / 5)).toBeLessThan(texel / 50);
    mask.texture.dispose();
  });

  it('preserves concave openings and is independent of polygon winding', () => {
    const mask = new HighlightMask();
    const u: Point2[] = [
      [0, 0],
      [0.2, 0],
      [0.2, 0.2],
      [0.15, 0.2],
      [0.15, 0.05],
      [0.05, 0.05],
      [0.05, 0.2],
      [0, 0.2],
    ];
    const bounds = mask.update([u], PADDING);
    if (!bounds) throw new Error('Missing bounds');
    const texel = bounds.size / HighlightMask.SIZE;
    const first = mask.texture.image.data?.slice();
    const d = sampler(mask, bounds);
    expect(Math.abs(d(0.1, 0.15) + 0.05)).toBeLessThan(texel);
    expect(Math.abs(d(0.025, 0.15) - 0.025)).toBeLessThan(texel);
    mask.update([[...u].reverse()], PADDING);
    expect(mask.texture.image.data).toEqual(first);
    mask.texture.dispose();
  });

  it('reuses its buffers and bounds, and clears every pixel when a silhouette disappears', () => {
    const mask = new HighlightMask();
    const data = mask.texture.image.data;
    const bounds = mask.update([SQUARE], PADDING);
    expect(mask.update([SQUARE.map(([x, y]): Point2 => [x + 0.01, y])], PADDING)).toBe(bounds);
    expect(mask.update([], PADDING)).toBeNull();
    expect(mask.update([SQUARE.slice(0, 2)], PADDING)).toBeNull();
    expect(mask.texture.image.data).toBe(data);
    expect(data?.every((value: number) => value === 0)).toBe(true);
    mask.texture.dispose();
  });

  it('unions overlapping paths without an internal edge or a brighter seam', () => {
    const triangle: Point2[] = [
      [0, 0],
      [0.1, 0],
      [0.037, 0.1],
    ];
    const mask = new HighlightMask();
    mask.update([triangle], PADDING);
    const first = mask.texture.image.data?.slice();
    mask.update([triangle, triangle], PADDING);
    expect(mask.texture.image.data).toEqual(first);
    mask.texture.dispose();
  });

  it('handles a contour with more vertices than its scratch buffers start with', () => {
    const circle: Point2[] = Array.from({ length: 600 }, (_, i) => {
      const a = (i / 600) * 2 * Math.PI;
      return [0.05 * Math.cos(a), 0.05 * Math.sin(a)];
    });
    const mask = new HighlightMask();
    const bounds = mask.update([circle], PADDING);
    if (!bounds) throw new Error('Missing bounds');
    const d = sampler(mask, bounds);
    expect(Math.abs(d(0, 0) - 0.05)).toBeLessThan(bounds.size / HighlightMask.SIZE);
    expect(Math.abs(d(0.05, 0))).toBeLessThan(1e-4);
    mask.texture.dispose();
  });
});

describe('HighlightMask smoothness', () => {
  it('rounds a segmenter polygon into a curve: the rim follows no facets', () => {
    // A coarse 12-gon, like a tracker outline. Its own iso-lines inside would turn 30 degrees at
    // every vertex (a kink of about 4e-4 m per degree squared in the radius below).
    const polygon: Point2[] = Array.from({ length: 12 }, (_, i) => {
      const a = (i / 12) * 2 * Math.PI;
      return [0.05 * Math.cos(a), 0.05 * Math.sin(a)];
    });
    const mask = new HighlightMask();
    const bounds = mask.update([polygon], PADDING, 0.01);
    if (!bounds) throw new Error('Missing bounds');
    const d = sampler(mask, bounds);
    // The radius of the 4 mm iso-line, one degree at a time.
    const radius = Array.from({ length: 360 }, (_, i) => {
      const a = (i / 360) * 2 * Math.PI;
      let lo = 0.02;
      let hi = 0.06;
      for (let k = 0; k < 40; k++) {
        const mid = (lo + hi) / 2;
        if (d(mid * Math.cos(a), mid * Math.sin(a)) > 0.004) lo = mid;
        else hi = mid;
      }
      return lo;
    });
    let worst = 0;
    for (let i = 0; i < 360; i++) {
      const r = radius[i] ?? 0;
      const second = (radius[(i + 1) % 360] ?? 0) - 2 * r + (radius[(i + 359) % 360] ?? 0);
      worst = Math.max(worst, Math.abs(second));
    }
    expect(worst).toBeLessThan(1e-4);
    mask.texture.dispose();
  });

  it('stores one filterable half-float channel', () => {
    const mask = new HighlightMask();
    expect(mask.texture.internalFormat).toBe('R16F');
    expect(mask.texture.image.data).toBeInstanceOf(Uint16Array);
    mask.texture.dispose();
  });
});

describe('HighlightMask accuracy', () => {
  it('holds the exact distance to the smoothed curve at every texel', () => {
    // A star with deep concave notches: the case where nearest-segment propagation goes wrong.
    const star: Point2[] = Array.from({ length: 40 }, (_, i) => {
      const a = (i / 40) * 2 * Math.PI;
      const r = i % 2 === 0 ? 0.08 : 0.03;
      return [r * Math.cos(a), r * Math.sin(a) * 0.6];
    });
    const mask = new HighlightMask();
    const bounds = mask.update([star], PADDING, 0.004);
    if (!bounds) throw new Error('Missing bounds');
    const inner = mask as unknown as Record<'ax' | 'ay' | 'dx' | 'dy', Float64Array> & {
      pathStart: Int32Array;
    };
    const segments = inner.pathStart[1] ?? 0;
    const { data } = mask.texture.image;
    if (!data) throw new Error('Missing distance-field texture');
    const size = HighlightMask.SIZE;
    let worst = 0;
    const bad: string[] = [];
    for (let row = 0; row < size; row += 3) {
      for (let col = 0; col < size; col += 3) {
        let exact = Number.POSITIVE_INFINITY;
        for (let s = 0; s < segments; s++) {
          const px = col + 0.5 - (inner.ax[s] ?? 0);
          const py = row + 0.5 - (inner.ay[s] ?? 0);
          const ex = inner.dx[s] ?? 0;
          const ey = inner.dy[s] ?? 0;
          const t = Math.min(1, Math.max(0, (px * ex + py * ey) / (ex * ex + ey * ey || 1)));
          exact = Math.min(exact, Math.hypot(px - t * ex, py - t * ey));
        }
        const stored = Math.abs(DataUtils.fromHalfFloat(data[row * size + col] ?? 0)) * size;
        // Half floats keep about 11 bits (1/1024 relative). Far out, where the bloom has faded
        // below one 8-bit step, a texel may hold a slightly farther segment: allow 4% of the
        // distance beyond 8 texels.
        const err = Math.abs(stored - exact) - exact / 1024 - Math.max(0, exact - 8) * 0.04;
        if (err > 0.02) bad.push(`${col},${row}:${stored.toFixed(2)}/${exact.toFixed(2)}`);
        worst = Math.max(worst, err);
      }
    }
    expect(bad.slice(0, 12)).toEqual([]);
    expect(worst).toBeLessThan(0.02);
    mask.texture.dispose();
  });
});

describe('HighlightMask interior points', () => {
  it('spreads up to 16 points well inside the silhouette, for the object front', () => {
    const mask = new HighlightMask();
    const bounds = mask.update([SQUARE], PADDING);
    if (!bounds) throw new Error('Missing bounds');
    expect(mask.interiorCount).toBe(16);
    const xs: number[] = [];
    const ys: number[] = [];
    for (let k = 0; k < mask.interiorCount; k++) {
      const x = ((mask.interior[k * 2] ?? 0) - 0.5) * bounds.size + bounds.x;
      const y = ((mask.interior[k * 2 + 1] ?? 0) - 0.5) * bounds.size + bounds.y;
      expect(Math.abs(x)).toBeLessThan(0.05);
      expect(Math.abs(y)).toBeLessThan(0.05);
      xs.push(x);
      ys.push(y);
    }
    // Spread over the square, not bunched in one corner.
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(0.05);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(0.03);
    expect(mask.update([], PADDING)).toBeNull();
    expect(mask.interiorCount).toBe(0);
    mask.texture.dispose();
  });

  it('still finds points inside a sliver', () => {
    const sliver: Point2[] = [
      [0, 0],
      [0.1, 0],
      [0.1, 0.003],
      [0, 0.003],
    ];
    const mask = new HighlightMask();
    mask.update([sliver], PADDING);
    expect(mask.interiorCount).toBeGreaterThan(0);
    mask.texture.dispose();
  });
});

import { describe, expect, it } from 'vitest';
import { raycastHorizontalSurfaces, type Surface } from '../../src/domain/world/surfaces';

const near = (a: readonly number[] | null, b: readonly number[], eps = 1e-6) =>
  !!a && a.every((v, i) => Math.abs(v - (b[i] ?? Number.NaN)) < eps);

// A 1 m x 0.6 m table top at height 0.75, centered at (0, 0.75, -1); polygon in plane-local x/z.
const table: Surface = {
  pose: { p: [0, 0.75, -1], q: [0, 0, 0, 1] },
  polygon: [
    [-0.5, -0.3],
    [0.5, -0.3],
    [0.5, 0.3],
    [-0.5, 0.3],
  ],
};
const floor: Surface = {
  pose: { p: [0, 0, 0], q: [0, 0, 0, 1] },
  polygon: [
    [-5, -5],
    [5, -5],
    [5, 5],
    [-5, 5],
  ],
};

describe('raycastHorizontalSurfaces', () => {
  it('hits the table top inside its outline', () => {
    const hit = raycastHorizontalSurfaces({ origin: [0, 1.5, 0], direction: [0, -0.6, -0.8] }, [
      table,
      floor,
    ]);
    // From 1.5 m down to 0.75 m is 0.75 / 0.6 = 1.25 units along the ray: z = -0.8 * 1.25 = -1.
    expect(near(hit, [0, 0.75, -1])).toBe(true);
  });

  it('falls through to the floor when the ray misses the table outline', () => {
    const hit = raycastHorizontalSurfaces({ origin: [2, 1.5, 0], direction: [0, -0.6, -0.8] }, [
      table,
      floor,
    ]);
    expect(near(hit, [2, 0, -2])).toBe(true);
  });

  it('ignores surfaces behind the ray', () => {
    expect(
      raycastHorizontalSurfaces({ origin: [0, 1.5, 0], direction: [0, 0.6, -0.8] }, [table, floor]),
    ).toBeNull();
  });
});

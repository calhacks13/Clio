import { describe, expect, test } from "bun:test";
import type { Vec3 } from "@clio-viewer/capture/model";
import {
  GRAIN_RANGE,
  GRAIN_SIZE,
  grainPixels,
  isRaisedSurface,
  polygonNormal,
} from "../solid-surfaces";

// The grain the room's solid surfaces carry and which detected planes are drawn
// as solid tops, without three.js.

const square = (z: number, half = 0.3): Vec3[] => [
  [-half, -half, z],
  [half, -half, z],
  [half, half, z],
  [-half, half, z],
];
const FLOOR = { point: [0, 0, -0.75] as Vec3, normal: [0, 0, 1] as Vec3 };

describe("the grain", () => {
  const pixels = grainPixels();

  test("is one byte a pixel over the whole square, the same on every load", () => {
    expect(pixels.length).toBe(GRAIN_SIZE * GRAIN_SIZE);
    expect(grainPixels()).toEqual(pixels);
    expect(grainPixels(GRAIN_SIZE, 2)).not.toEqual(pixels);
  });

  test("spans the factor range, so the surface never goes darker than its floor", () => {
    let min = 255;
    let max = 0;
    for (const p of pixels) {
      min = Math.min(min, p);
      max = Math.max(max, p);
    }
    expect(min).toBe(Math.round(GRAIN_RANGE[0] * 255));
    expect(max).toBe(Math.round(GRAIN_RANGE[1] * 255));
  });

  test("tiles: the step across an edge is no larger than a step inside", () => {
    const at = (x: number, y: number) => pixels[y * GRAIN_SIZE + x];
    const step = (pairs: [number, number][]) =>
      pairs.reduce((sum, [a, b]) => sum + Math.abs(a - b), 0) / pairs.length;
    const rows = Array.from({ length: GRAIN_SIZE }, (_, y) => y);
    const across = step(
      rows.flatMap((y) => [
        [at(GRAIN_SIZE - 1, y), at(0, y)] as [number, number],
        [at(y, GRAIN_SIZE - 1), at(y, 0)] as [number, number],
      ]),
    );
    const inside = step(
      rows.flatMap((y) => [
        [at(127, y), at(128, y)] as [number, number],
        [at(y, 127), at(y, 128)] as [number, number],
      ]),
    );
    expect(across).toBeLessThan(inside * 1.25);
  });
});

describe("raised surfaces", () => {
  test("a polygon's normal, either way round, and none for a degenerate one", () => {
    expect(polygonNormal(square(0))).toEqual([0, 0, 1]);
    expect(polygonNormal([...square(0)].reverse())).toEqual([0, 0, -1]);
    expect(
      polygonNormal([
        [0, 0, 0],
        [1, 0, 0],
        [2, 0, 0],
      ]),
    ).toBeNull();
  });

  test("a level table, couch or shelf top above the floor is raised", () => {
    expect(isRaisedSurface({ kind: "table", outline: square(0) }, FLOOR)).toBe(
      true,
    );
    expect(
      isRaisedSurface({ kind: "couch", outline: square(-0.3) }, FLOOR),
    ).toBe(true);
    expect(
      isRaisedSurface({ kind: "other", outline: square(0.3) }, FLOOR),
    ).toBe(true);
  });

  test("the floor, walls and ceiling are not, nor a top lying on the floor", () => {
    expect(
      isRaisedSurface({ kind: "floor", outline: square(-0.75) }, FLOOR),
    ).toBe(false);
    expect(
      isRaisedSurface({ kind: "ceiling", outline: square(1.8) }, FLOOR),
    ).toBe(false);
    const upright: Vec3[] = [
      [1, -0.5, -0.75],
      [1, 0.5, -0.75],
      [1, 0.5, 1],
      [1, -0.5, 1],
    ];
    expect(isRaisedSurface({ kind: "wall", outline: upright }, FLOOR)).toBe(
      false,
    );
    // A door or a screen: upright, so not a top, whatever its kind.
    expect(isRaisedSurface({ kind: "other", outline: upright }, FLOOR)).toBe(
      false,
    );
    // A rug: level, but on the floor.
    expect(
      isRaisedSurface({ kind: "other", outline: square(-0.72) }, FLOOR),
    ).toBe(false);
  });

  test("a top tilted past about 25 degrees is not level; without a floor, any level top counts", () => {
    const tilted: Vec3[] = [
      [-0.3, -0.3, 0],
      [0.3, -0.3, 0.3],
      [0.3, 0.3, 0.3],
      [-0.3, 0.3, 0],
    ];
    expect(isRaisedSurface({ kind: "table", outline: tilted }, FLOOR)).toBe(
      false,
    );
    expect(
      isRaisedSurface({ kind: "other", outline: square(-0.72) }, null),
    ).toBe(true);
  });
});

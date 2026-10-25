import type { SurfaceKind } from "@clio/protocol";
import type { Vec3 } from "@clio-viewer/capture/model";
import type { Plane } from "./object-display";

// The room as solid context (DESIGN.md, "Room scan"): the grain every solid surface of the room
// and of the compiled environment carries, and which detected planes are drawn as solid tops.
// Pure: no DOM or three.js. layers/solid.ts turns the grain into a texture and projects it onto
// the surfaces in world space, so the scan needs no texture coordinates.

/** Side of the square grain image in pixels: a power of two, so it tiles and mipmaps. */
export const GRAIN_SIZE = 256;
/** The grain multiplies a surface's color by a factor in this range, darkest to lightest. */
export const GRAIN_RANGE: readonly [number, number] = [0.9, 1];

/** Lattice cells across the image and the weight of each octave of the mottling. */
const OCTAVES: readonly [cells: number, weight: number][] = [
  [4, 0.1],
  [8, 0.25],
  [16, 0.35],
  [32, 0.3],
];
/** How much of the grain is per-pixel speckle rather than mottling. */
const SPECKLE = 0.35;

/** Mulberry32: a small seeded generator, so the grain is the same on every load. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

/**
 * The grain: soft mottling (value noise on a lattice that wraps, in four octaves) over a fine
 * speckle, like matte plaster. One byte a pixel, row by row; byte / 255 is the factor the surface's
 * color is multiplied by, spread over GRAIN_RANGE. The lattice wraps at the image's edges, so the
 * image tiles without a seam.
 */
export function grainPixels(size = GRAIN_SIZE, seed = 1): Uint8Array {
  const next = random(seed);
  const value = new Float32Array(size * size);
  for (const [cells, weight] of OCTAVES) {
    const lattice = Float32Array.from({ length: cells * cells }, next);
    const at = (i: number, j: number) =>
      lattice[(j % cells) * cells + (i % cells)];
    for (let y = 0; y < size; y++) {
      const fy = (y / size) * cells;
      const j = Math.floor(fy);
      const ty = fade(fy - j);
      for (let x = 0; x < size; x++) {
        const fx = (x / size) * cells;
        const i = Math.floor(fx);
        const tx = fade(fx - i);
        const top = at(i, j) + (at(i + 1, j) - at(i, j)) * tx;
        const bottom = at(i, j + 1) + (at(i + 1, j + 1) - at(i, j + 1)) * tx;
        value[y * size + x] += weight * (top + (bottom - top) * ty);
      }
    }
  }
  let min = Infinity;
  let max = -Infinity;
  for (let p = 0; p < value.length; p++) {
    value[p] = (1 - SPECKLE) * value[p] + SPECKLE * next();
    min = Math.min(min, value[p]);
    max = Math.max(max, value[p]);
  }
  const [lo, hi] = GRAIN_RANGE;
  const span = max - min || 1;
  const pixels = new Uint8Array(size * size);
  for (let p = 0; p < value.length; p++) {
    const factor = lo + ((value[p] - min) / span) * (hi - lo);
    pixels[p] = Math.round(factor * 255);
  }
  return pixels;
}

/** A detected plane as the environment layer has it: its kind and its outline in ROS. */
export interface PlaneOutline {
  kind: SurfaceKind;
  outline: readonly Vec3[];
}

/** Unit normal of a polygon (Newell's method), either way round; null for a degenerate one. */
export function polygonNormal(points: readonly Vec3[]): Vec3 | null {
  let x = 0;
  let y = 0;
  let z = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    x += (a[1] - b[1]) * (a[2] + b[2]);
    y += (a[2] - b[2]) * (a[0] + b[0]);
    z += (a[0] - b[0]) * (a[1] + b[1]);
  }
  const length = Math.hypot(x, y, z);
  return length > 1e-9 ? [x / length, y / length, z / length] : null;
}

/** A surface this close to level (its normal within about 25 degrees of up) counts as a top. */
const LEVEL_COS = 0.9;
/** A top this far above the floor is raised: a table, a couch seat, a shelf. */
const RAISED_M = 0.1;

/**
 * Whether a detected plane is a raised surface the viewer draws solid: a level top (not a wall,
 * floor or ceiling) at least RAISED_M above the floor. Without a floor, any level top counts.
 * Points are ROS (z up), the floor too.
 */
export function isRaisedSurface(
  plane: PlaneOutline,
  floor: Plane | null,
): boolean {
  if (plane.kind === "wall" || plane.kind === "floor") return false;
  if (plane.kind === "ceiling" || plane.outline.length < 3) return false;
  const normal = polygonNormal(plane.outline);
  if (!normal || Math.abs(normal[2]) < LEVEL_COS) return false;
  if (!floor) return true;
  const n = plane.outline.length;
  const center = [0, 1, 2].map(
    (k) => plane.outline.reduce((sum, p) => sum + p[k], 0) / n,
  );
  const height =
    (center[0] - floor.point[0]) * floor.normal[0] +
    (center[1] - floor.point[1]) * floor.normal[1] +
    (center[2] - floor.point[2]) * floor.normal[2];
  return height >= RAISED_M;
}

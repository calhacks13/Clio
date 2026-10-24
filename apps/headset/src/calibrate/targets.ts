// The steps of a calibration run. First the right index fingertip under crosshairs spread over the
// image, alternating close and at arm's length (0.3 and 0.6 m). Then marks: the user looks at a
// sharp corner on a wall or table 1 to 3 m away and pinches, which places a mark there with
// hit-test; then turns the head so that corner sits under crosshairs in the camera picture. Far
// points are what tell a turn of the camera (or a wrong focal length) from a shift of it.

export type Reach = 'near' | 'far';

export type CalibrationStep =
  | { kind: 'finger'; uv: [number, number]; reach: Reach }
  | { kind: 'place'; mark: number }
  | { kind: 'mark'; uv: [number, number]; mark: number };

export type AimStep = Extract<CalibrationStep, { kind: 'finger' | 'mark' }>;

export interface StepPlan {
  fingers?: number;
  marks?: number;
  aimsPerMark?: number;
}

/** Image positions the hand can reach comfortably: the middle of the frame, a little low. */
const GRID_U = [0.25, 0.5, 0.75];
const GRID_V = [0.3, 0.5, 0.7];
/** Where a mark is aimed for: spread so each mark is seen across the image. */
const MARK_UV: [number, number][] = [
  [0.25, 0.3],
  [0.75, 0.5],
  [0.4, 0.7],
  [0.75, 0.3],
  [0.25, 0.55],
  [0.6, 0.7],
  [0.5, 0.4],
];

/** A shuffle driven by `seed`, so a run is repeatable in tests. */
function shuffled<T>(items: T[], seed: number): T[] {
  const out = [...items];
  let s = seed >>> 0 || 1;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/** `count` fingertip crosshairs: the 3x3 grid shuffled, then jittered repeats; near and far alternate. */
export function fingerTargets(count: number, seed = Date.now(), first = 0): AimStep[] {
  const grid = GRID_V.flatMap((v) => GRID_U.map((u): [number, number] => [u, v]));
  const out: AimStep[] = [];
  let round = 0;
  while (out.length < count) {
    const order = shuffled(grid, seed + round * 7919);
    for (const [u, v] of order) {
      if (out.length >= count) break;
      const k = first + out.length;
      const jitter = k < grid.length ? 0 : 0.08;
      out.push({
        kind: 'finger',
        uv: [u + jitter * Math.cos(k * 2.4), v + jitter * Math.sin(k * 2.4)],
        reach: k % 2 ? 'far' : 'near',
      });
    }
    round++;
  }
  return out;
}

/** Crosshairs for mark `mark`, the `first`th aim at it onwards. */
export function markTargets(mark: number, count: number, first = 0): AimStep[] {
  return Array.from({ length: count }, (_, i) => {
    const uv = MARK_UV[(mark * 3 + first + i) % MARK_UV.length] as [number, number];
    return { kind: 'mark', uv: [uv[0], uv[1]], mark };
  });
}

/** A whole run: the fingertip crosshairs, then for each mark, placing it and its crosshairs. */
export function calibrationSteps(seed = Date.now(), plan: StepPlan = {}): CalibrationStep[] {
  const { fingers = 9, marks = 2, aimsPerMark = 3 } = plan;
  const steps: CalibrationStep[] = fingerTargets(fingers, seed);
  for (let mark = 0; mark < marks; mark++) {
    steps.push({ kind: 'place', mark }, ...markTargets(mark, aimsPerMark));
  }
  return steps;
}

import { describe, expect, it } from 'vitest';
import {
  Capture,
  type CaptureEvent,
  entityAt,
  graspMarks,
  HAND_BONES,
  heldAt,
  type Location,
  ORIENTATION_VALID,
  POSITION_TRACKED,
  POSITION_VALID,
  type PoseSample,
  Series,
  trail,
  type Vec3,
  validSpans,
} from '../../../src/viewer/capture/model';

const VALID = ORIENTATION_VALID | POSITION_VALID;
const LOST: Location = { translation: null, rotation: null, location_flags: 0 };

function pose(t: number, at: Vec3 | null, flags = VALID, id = 'cup'): PoseSample {
  return {
    kind: 'pose',
    t_us: t,
    sequence: t,
    source_id: 'test',
    estimate_type: 'synthetic',
    entity_id: id,
    location: at ? { translation: at, rotation: [0, 0, 0, 1], location_flags: flags } : LOST,
    confidence: null,
  };
}

function event(t: number, kind: CaptureEvent['event'], ids: string[]): CaptureEvent {
  return {
    kind: 'event',
    t_us: t,
    sequence: t,
    source_id: 'test',
    event: kind,
    entity_ids: ids,
    origin: 'synthetic',
    details: {},
  };
}

function seriesOf(...samples: PoseSample[]): Series<PoseSample> {
  const series = new Series<PoseSample>();
  for (const s of samples) series.add(s);
  return series;
}

function withHands(): Capture {
  const capture = new Capture('test');
  for (const id of ['left_hand', 'right_hand']) {
    capture.addEntity({
      id,
      name: id,
      role: 'hand',
      motion: 'tracked',
      geometry: { type: 'none' },
      pose: null,
    });
  }
  return capture;
}

describe('Series', () => {
  it('keeps samples in time order even when they arrive out of order', () => {
    const series = seriesOf(pose(0, [0, 0, 0]), pose(300, [3, 0, 0]), pose(100, [1, 0, 0]));
    expect(series.samples.map((s) => s.t_us)).toEqual([0, 100, 300]);
    expect(series.endUs).toBe(300);
  });

  it('finds the newest sample at or before a time', () => {
    const series = seriesOf(pose(100, [1, 0, 0]), pose(200, [2, 0, 0]));
    expect(series.indexAt(99)).toBe(-1);
    expect(series.at(99)).toBeNull();
    expect(series.at(100)?.t_us).toBe(100);
    expect(series.at(199)?.t_us).toBe(100);
    expect(series.at(5000)?.t_us).toBe(200);
  });
});

describe('entityAt', () => {
  it('reports a lost entity where it was last seen', () => {
    const series = seriesOf(
      pose(0, [1, 2, 3], VALID | POSITION_TRACKED),
      pose(100, null),
      pose(200, [4, 5, 6]),
    );
    expect(entityAt(series, -1)).toBeNull();
    expect(entityAt(series, 50)).toMatchObject({ position: [1, 2, 3], lost: false, tracked: true });
    expect(entityAt(series, 150)).toMatchObject({
      position: [1, 2, 3],
      rotation: null,
      lost: true,
      tracked: false,
    });
    expect(entityAt(series, 200)).toMatchObject({ position: [4, 5, 6], lost: false });
  });

  it('has no position when nothing valid came before', () => {
    expect(entityAt(seriesOf(pose(0, null)), 10)).toMatchObject({ position: null, lost: true });
  });
});

describe('trail', () => {
  it('returns the window before t, split where the position was not valid', () => {
    const series = seriesOf(
      pose(0, [0, 0, 0]),
      pose(10, [1, 0, 0]),
      pose(20, [2, 0, 0]),
      pose(30, null),
      pose(40, [4, 0, 0]),
      pose(50, [5, 0, 0]),
    );
    expect(trail(series, 50, 100)).toEqual([
      [
        [0, 0, 0],
        [1, 0, 0],
        [2, 0, 0],
      ],
      [
        [4, 0, 0],
        [5, 0, 0],
      ],
    ]);
    expect(trail(series, 25, 20)).toEqual([
      [
        [1, 0, 0],
        [2, 0, 0],
      ],
    ]);
  });

  it('thins long windows but always ends at the newest sample', () => {
    const series = seriesOf(...Array.from({ length: 101 }, (_, i) => pose(i, [i, 0, 0])));
    const [line] = trail(series, 100, 1000, 10);
    expect(line?.length).toBeLessThanOrEqual(12);
    expect(line?.[0]).toEqual([0, 0, 0]);
    expect(line?.at(-1)).toEqual([100, 0, 0]);
  });
});

describe('validSpans', () => {
  it('spans the valid stretches; the newest one runs to the end', () => {
    const series = seriesOf(
      pose(0, [0, 0, 0]),
      pose(10, [1, 0, 0]),
      pose(20, null),
      pose(40, [2, 0, 0]),
    );
    expect(validSpans(series, 100)).toEqual([
      [0, 20],
      [40, 100],
    ]);
    expect(validSpans(undefined, 100)).toEqual([]);
  });
});

describe('heldAt and graspMarks', () => {
  it('replays grasps and releases up to t', () => {
    const capture = withHands();
    capture.addEvent(event(10, 'grasp', ['right_hand', 'cup']));
    capture.addEvent(event(20, 'grasp', ['left_hand', 'lid']));
    capture.addEvent(event(30, 'release', ['right_hand', 'cup']));
    capture.addEvent(event(40, 'release', ['left_hand']));
    expect(heldAt(capture, 5)).toEqual(new Map());
    expect(heldAt(capture, 25)).toEqual(
      new Map([
        ['cup', 'right_hand'],
        ['lid', 'left_hand'],
      ]),
    );
    expect(heldAt(capture, 35)).toEqual(new Map([['lid', 'left_hand']]));
    expect(heldAt(capture, 45)).toEqual(new Map());
    expect(graspMarks(capture, 'cup')).toEqual([
      { tUs: 10, kind: 'grasp' },
      { tUs: 30, kind: 'release' },
    ]);
  });
});

describe('HAND_BONES', () => {
  it('links the wrist to every fingertip through the OpenXR joints', () => {
    expect(HAND_BONES).toHaveLength(24);
    expect(HAND_BONES.slice(0, 4)).toEqual([
      [1, 2],
      [2, 3],
      [3, 4],
      [4, 5],
    ]);
    expect(HAND_BONES.at(-1)).toEqual([24, 25]);
    expect(HAND_BONES.some(([a, b]) => a === 0 || b === 0)).toBe(false);
  });
});

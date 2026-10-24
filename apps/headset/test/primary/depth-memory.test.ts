import { describe, expect, it } from 'vitest';
import type { Ray } from '../../src/domain/world/camera-model';
import { DepthMemory } from '../../src/primary/depth-memory';
import type { ObjectDepth, ObjectMask } from '../../src/primary/placement';

const ray = (origin: [number, number, number], direction: [number, number, number]): Ray => ({
  origin,
  direction,
});
const forward = ray([0, 1.2, 0], [0, 0, -1]);
const mask = (box: [number, number, number, number]): ObjectMask => ({
  point: [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2],
  box,
  outline: null,
});
const BOX: [number, number, number, number] = [0.4, 0.4, 0.6, 0.6];

describe('DepthMemory', () => {
  it('has nothing to reuse for a target it never measured', () => {
    const memory = new DepthMemory();
    expect(memory.reuse('cup', mask(BOX), forward, 0)).toBeNull();
    memory.remember(
      'cup',
      mask(BOX),
      forward,
      { center: [0, 1.2, -0.5], kind: 'contact' },
      0,
      memory.epoch,
    );
    expect(memory.reuse('mug', mask(BOX), forward, 10)).toBeNull();
  });

  it('places a new mask at the distance last measured, along its own ray', () => {
    const memory = new DepthMemory();
    memory.remember(
      'cup',
      mask(BOX),
      forward,
      { center: [0.02, 1.2, -0.5], kind: 'contact' },
      0,
      memory.epoch,
    );
    // The head moved 10 cm right and the object is now seen a little to the left.
    const moved = ray([0.1, 1.2, 0], [-0.6, 0, -0.8]);
    const depth = memory.reuse('cup', mask(BOX), moved, 50);
    expect(depth?.kind).toBe('contact');
    expect(depth?.center[0]).toBeCloseTo(0.1 - 0.6 * 0.5);
    expect(depth?.center[1]).toBeCloseTo(1.2);
    expect(depth?.center[2]).toBeCloseTo(-0.8 * 0.5);
  });

  it('measures first when the mask moved far from the one measured', () => {
    const memory = new DepthMemory();
    const near: ObjectDepth = { center: [0, 1.2, -0.4], kind: 'contact' };
    memory.remember('cup', mask(BOX), forward, near, 0, memory.epoch);
    // A little way on, the same cup; far across the frame, another cup or the same one moved far.
    expect(memory.reuse('cup', mask([0.5, 0.45, 0.7, 0.65]), forward, 30)).not.toBeNull();
    expect(memory.reuse('cup', mask([0.05, 0.1, 0.15, 0.2]), forward, 30)).toBeNull();
    // Brought toward the face: the box grew past the limit.
    expect(memory.reuse('cup', mask([0.2, 0.2, 0.8, 0.8]), forward, 30)).toBeNull();
  });

  it('does not reuse a distance measured too long ago, or behind the camera', () => {
    const memory = new DepthMemory({ maxAgeMs: 1000 });
    memory.remember(
      'cup',
      mask(BOX),
      forward,
      { center: [0, 1.2, -0.5], kind: 'point' },
      0,
      memory.epoch,
    );
    expect(memory.reuse('cup', mask(BOX), forward, 1000)).not.toBeNull();
    expect(memory.reuse('cup', mask(BOX), forward, 1001)).toBeNull();
    const fresh = new DepthMemory();
    fresh.remember(
      'cup',
      mask(BOX),
      forward,
      { center: [0, 1.2, 0.5], kind: 'point' },
      0,
      fresh.epoch,
    );
    expect(fresh.reuse('cup', mask(BOX), forward, 0)).toBeNull();
  });

  it('measures a new target at once, then every 100 ms', () => {
    const memory = new DepthMemory();
    expect(memory.shouldMeasure('cup', mask(BOX), 0)).toBe(true);
    const asked = [0];
    for (let t = 33; t <= 400; t += 33) {
      if (memory.shouldMeasure('cup', mask(BOX), t)) asked.push(t);
    }
    expect(asked).toEqual([0, 132, 264, 396]);
    expect(memory.shouldMeasure('mug', mask(BOX), 400)).toBe(true);
  });

  it('measures again sooner when the mask moves or grows a lot', () => {
    const memory = new DepthMemory();
    memory.shouldMeasure('cup', mask(BOX), 0);
    expect(memory.shouldMeasure('cup', mask([0.42, 0.41, 0.62, 0.61]), 33)).toBe(false);
    expect(memory.shouldMeasure('cup', mask([0.5, 0.4, 0.7, 0.6]), 66)).toBe(true);
    expect(memory.shouldMeasure('cup', mask([0.5, 0.4, 0.7, 0.6]), 99)).toBe(false);
    expect(memory.shouldMeasure('cup', mask([0.45, 0.35, 0.75, 0.65]), 132)).toBe(false);
    expect(memory.shouldMeasure('cup', mask([0.4, 0.3, 0.8, 0.7]), 140)).toBe(true);
  });

  it('does not remember a measurement started before the target was forgotten', () => {
    const memory = new DepthMemory();
    const epoch = memory.epoch;
    memory.forget();
    memory.shouldMeasure('cup', mask(BOX), 0);
    memory.remember(
      'cup',
      mask(BOX),
      forward,
      { center: [0, 1.2, -0.5], kind: 'contact' },
      10,
      epoch,
    );
    expect(memory.reuse('cup', mask(BOX), forward, 20)).toBeNull();
  });

  it('forgets the target: the next mask is measured first', () => {
    const memory = new DepthMemory();
    memory.shouldMeasure('cup', mask(BOX), 0);
    memory.remember(
      'cup',
      mask(BOX),
      forward,
      { center: [0, 1.2, -0.5], kind: 'contact' },
      10,
      memory.epoch,
    );
    memory.forget();
    expect(memory.reuse('cup', mask(BOX), forward, 20)).toBeNull();
    expect(memory.shouldMeasure('cup', mask(BOX), 20)).toBe(true);
  });
});

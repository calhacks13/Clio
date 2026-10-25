import { describe, expect, it } from 'vitest';
import {
  boxCenter,
  boxToPixels,
  objectFitOf,
  pictureRect,
  polygonToPixels,
  toPixels,
} from '../../src/desk/fit';

// The webcam's picture inside its element, so a box on the frame lands on the object it boxes.

describe('pictureRect', () => {
  const frame = { width: 1280, height: 720 };

  it('letterboxes a wide frame in a tall element (contain), centered', () => {
    expect(pictureRect(frame, { width: 640, height: 600 }, 'contain')).toEqual({
      x: 0,
      y: 120,
      width: 640,
      height: 360,
    });
  });

  it('pillarboxes it in a wide element', () => {
    expect(pictureRect(frame, { width: 1000, height: 360 }, 'contain')).toEqual({
      x: 180,
      y: 0,
      width: 640,
      height: 360,
    });
  });

  it('crops it to fill the element (cover): the picture overhangs on both sides', () => {
    const rect = pictureRect(frame, { width: 640, height: 600 }, 'cover');
    expect(rect?.x).toBeCloseTo(-213.333, 3);
    expect(rect?.y).toBe(0);
    expect(rect?.width).toBeCloseTo(1066.667, 3);
    expect(rect?.height).toBe(600);
  });

  it('stretches it (fill), and keeps its own size (none)', () => {
    expect(pictureRect(frame, { width: 300, height: 300 }, 'fill')).toEqual({
      x: 0,
      y: 0,
      width: 300,
      height: 300,
    });
    expect(pictureRect(frame, { width: 1280, height: 1000 }, 'none')).toEqual({
      x: 0,
      y: 140,
      width: 1280,
      height: 720,
    });
  });

  it('scale-down shrinks a big frame like contain and never enlarges a small one', () => {
    expect(pictureRect(frame, { width: 640, height: 600 }, 'scale-down')?.width).toBe(640);
    expect(
      pictureRect({ width: 320, height: 240 }, { width: 640, height: 480 }, 'scale-down'),
    ).toEqual({ x: 160, y: 120, width: 320, height: 240 });
  });

  it('is null until the video has a frame and the element a size', () => {
    expect(pictureRect({ width: 0, height: 0 }, { width: 640, height: 480 }, 'contain')).toBeNull();
    expect(pictureRect(frame, { width: 0, height: 480 }, 'contain')).toBeNull();
  });
});

describe('mapping the frame onto the element', () => {
  const rect = { x: 0, y: 120, width: 640, height: 360 };

  it('maps normalized points, boxes and outlines through the picture rectangle', () => {
    expect(toPixels([0.5, 0.5], rect)).toEqual([320, 300]);
    expect(toPixels([0, 0], rect)).toEqual([0, 120]);
    expect(boxToPixels([0.25, 0.5, 0.75, 1], rect)).toEqual({
      x: 160,
      y: 300,
      width: 320,
      height: 180,
    });
    expect(
      polygonToPixels(
        [
          [0, 0],
          [1, 0],
          [1, 1],
        ],
        rect,
      ),
    ).toEqual([
      [0, 120],
      [640, 120],
      [640, 480],
    ]);
  });

  it('takes a box given corner to corner either way', () => {
    expect(boxToPixels([0.75, 1, 0.25, 0.5], rect)).toEqual(
      boxToPixels([0.25, 0.5, 0.75, 1], rect),
    );
  });

  it('finds a box center', () => {
    expect(boxCenter([0.2, 0.4, 0.6, 0.8])).toEqual([0.4, 0.6000000000000001]);
  });
});

describe('objectFitOf', () => {
  it('reads the computed value, and treats anything unknown as CSS does (fill)', () => {
    expect(objectFitOf('contain')).toBe('contain');
    expect(objectFitOf('cover')).toBe('cover');
    expect(objectFitOf('')).toBe('fill');
    expect(objectFitOf(undefined)).toBe('fill');
  });
});

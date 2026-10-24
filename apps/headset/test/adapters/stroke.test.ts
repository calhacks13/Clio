import { describe, expect, it } from 'vitest';
import { cornerBrackets, mergeStrokes, strokePolyline } from '../../src/adapters/render/stroke';

const vertices = (positions: Float32Array) =>
  Array.from({ length: positions.length / 3 }, (_, i): [number, number] => [
    Number(positions[i * 3]?.toFixed(6)),
    Number(positions[i * 3 + 1]?.toFixed(6)),
  ]);

const SQUARE: [number, number][] = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];

describe('strokePolyline', () => {
  it('turns an open line into a quad centered on it', () => {
    const stroke = strokePolyline(
      [
        [0, 0],
        [1, 0],
      ],
      { width: 0.1, closed: false },
    );
    expect(vertices(stroke.positions)).toEqual([
      [0, -0.05],
      [0, 0.05],
      [1, -0.05],
      [1, 0.05],
    ]);
    expect(Array.from(stroke.indices)).toEqual([0, 1, 3, 0, 3, 2]);
  });

  it('grows a closed outline outward, mitering the corners, so it never covers the object', () => {
    const stroke = strokePolyline(SQUARE, { width: 0.1, closed: true, outside: true });
    expect(vertices(stroke.positions)).toEqual([
      [-0.1, -0.1],
      [0, 0],
      [1.1, -0.1],
      [1, 0],
      [1.1, 1.1],
      [1, 1],
      [-0.1, 1.1],
      [0, 1],
    ]);
    expect(stroke.indices).toHaveLength(4 * 6);
  });

  it('finds the outside whichever way the outline winds', () => {
    const clockwise = [...SQUARE].reverse();
    const stroke = strokePolyline(clockwise, { width: 0.1, closed: true, outside: true });
    expect(vertices(stroke.positions).slice(0, 2)).toEqual([
      [-0.1, 1.1],
      [0, 1],
    ]);
  });

  it('clips the miter of a needle-sharp corner', () => {
    const spike: [number, number][] = [
      [0, 0],
      [1, 0.01],
      [0, 0.02],
    ];
    const stroke = strokePolyline(spike, { width: 0.1, closed: true, miterLimit: 3 });
    for (const [x, y] of vertices(stroke.positions)) {
      expect(Math.hypot(x - 1, y - 0.01)).toBeLessThan(1.2);
    }
  });

  it('draws nothing for fewer than two points', () => {
    const stroke = strokePolyline([[0, 0]], { width: 0.1, closed: true });
    expect(stroke.positions).toHaveLength(0);
    expect(stroke.indices).toHaveLength(0);
  });
});

describe('cornerBrackets', () => {
  it('marks each corner of a box with an L along a share of both edges', () => {
    const brackets = cornerBrackets(SQUARE, 0.25);
    expect(brackets).toEqual([
      [
        [0, 0.25],
        [0, 0],
        [0.25, 0],
      ],
      [
        [0.75, 0],
        [1, 0],
        [1, 0.25],
      ],
      [
        [1, 0.75],
        [1, 1],
        [0.75, 1],
      ],
      [
        [0.25, 1],
        [0, 1],
        [0, 0.75],
      ],
    ]);
  });
});

describe('mergeStrokes', () => {
  it('appends the vertices and renumbers the later triangles', () => {
    const line = strokePolyline(
      [
        [0, 0],
        [1, 0],
      ],
      { width: 0.1, closed: false },
    );
    const merged = mergeStrokes([line, line]);
    expect(merged.positions).toHaveLength(2 * line.positions.length);
    expect(Array.from(merged.indices)).toEqual([0, 1, 3, 0, 3, 2, 4, 5, 7, 4, 7, 6]);
  });
});

import { describe, expect, it } from 'vitest';
import { anchorPoint, DESK_WORKSPACE, standInPosition } from '../../src/desk/stand-in';

// Where a seen object stands in on the workspace, so the lesson knows it has been found.

describe('standInPosition', () => {
  it('lays the picture flat on the table: left to right along +x, the top far away', () => {
    expect(standInPosition([0, 1])).toEqual([0, 0, -0]);
    expect(standInPosition([1, 0])).toEqual([DESK_WORKSPACE[0], 0, -DESK_WORKSPACE[1]]);
    expect(standInPosition([0.5, 0.5], [1, 1])).toEqual([0.5, 0, -0.5]);
  });

  it('keeps points inside the workspace', () => {
    expect(standInPosition([-0.2, 1.4], [1, 1])).toEqual([0, 0, -0]);
  });
});

describe('anchorPoint', () => {
  it('places an object where it rests, else at its inside point, else its box center', () => {
    expect(anchorPoint({ contact: [0.1, 0.9], point: [0.2, 0.5], box: [0, 0, 1, 1] })).toEqual([
      0.1, 0.9,
    ]);
    expect(anchorPoint({ contact: null, point: [0.2, 0.5], box: [0, 0, 1, 1] })).toEqual([
      0.2, 0.5,
    ]);
    expect(anchorPoint({ box: [0.2, 0.2, 0.4, 0.6] })).toEqual([0.30000000000000004, 0.4]);
    expect(anchorPoint({})).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { placeTag, tagText } from '../../src/desk/tags';

// The label tag at a box's top-left corner.

describe('tagText', () => {
  it('says the label, the state, who placed it and the score', () => {
    expect(tagText({ label: 'washer cap', state: 'tracking', source: 'er', score: 0.912 })).toBe(
      'washer cap · tracking · er 0.91',
    );
  });

  it('leaves out what it does not know', () => {
    expect(tagText({ label: 'cup', state: null, source: null, score: null })).toBe('cup');
    expect(tagText({ label: 'cup', state: 'coasting', source: null, score: 0.4 })).toBe(
      'cup · coasting · 0.40',
    );
    expect(tagText({ label: 'cup', state: 'unknown', source: 'jev', score: null })).toBe(
      'cup · unknown · jev',
    );
  });
});

describe('placeTag', () => {
  const canvas = { width: 800, height: 600 };
  const size = { width: 120, height: 17 };

  it('sits just above the box, at its left edge', () => {
    expect(placeTag({ x: 100, y: 200, width: 50, height: 50 }, size, canvas, [])).toEqual({
      x: 100,
      y: 181,
      width: 120,
      height: 17,
    });
  });

  it('goes inside the box when the box touches the top of the picture', () => {
    expect(placeTag({ x: 100, y: 5, width: 50, height: 50 }, size, canvas, []).y).toBe(7);
  });

  it('never runs past the canvas sides', () => {
    expect(placeTag({ x: 750, y: 200, width: 40, height: 40 }, size, canvas, []).x).toBe(680);
    expect(placeTag({ x: -20, y: 200, width: 40, height: 40 }, size, canvas, []).x).toBe(0);
  });

  it('steps down past a tag already drawn there', () => {
    const first = placeTag({ x: 100, y: 200, width: 50, height: 50 }, size, canvas, []);
    const second = placeTag({ x: 110, y: 205, width: 50, height: 50 }, size, canvas, [first]);
    expect(second.y).toBe(first.y + first.height + 2);
    expect(second.x).toBe(110);
  });

  it('stays where it was when a tag elsewhere does not overlap', () => {
    const elsewhere = { x: 500, y: 181, width: 120, height: 17 };
    expect(placeTag({ x: 100, y: 200, width: 50, height: 50 }, size, canvas, [elsewhere]).y).toBe(
      181,
    );
  });
});

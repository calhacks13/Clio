import type { FocusAction, FocusDetection } from '@clio/protocol';
import { describe, expect, it } from 'vitest';
import { ER_FADE_MS, erBoxes, erOpacity } from '../../src/desk/er-boxes';

// Robotics-ER's boxes on the picture: dashed, fading over 1.5 s, the action item marked.

const found = (id: string, box: [number, number, number, number]): FocusDetection => ({
  id,
  found: true,
  box,
  point: null,
  confidence: 0.8,
  description: `the ${id}`,
});

const action = (over: Partial<FocusAction>): FocusAction => ({
  id: null,
  label: 'red reset button',
  phrase: 'red button',
  description: 'A small red button',
  found: true,
  box: [0.5, 0.5, 0.6, 0.6],
  point: [0.55, 0.55],
  confidence: 0.7,
  ...over,
});

describe('erOpacity', () => {
  it('fades from full to nothing over 1.5 s', () => {
    expect(erOpacity(1000, 1000)).toBe(1);
    expect(erOpacity(1000, 1750)).toBeCloseTo(0.5);
    expect(erOpacity(1000, 1000 + ER_FADE_MS)).toBe(0);
    expect(erOpacity(1000, 5000)).toBe(0);
    expect(erOpacity(1000, 900)).toBe(1);
  });
});

describe('erBoxes', () => {
  const label = (id: string) => `${id} label`;

  it('draws every object found with a box, and marks the action item among them', () => {
    const boxes = erBoxes(
      [
        found('cup', [0.1, 0.1, 0.2, 0.2]),
        { ...found('jug', [0.3, 0.3, 0.4, 0.4]), found: false, box: null },
        found('tray', [0.5, 0.1, 0.9, 0.3]),
      ],
      action({ id: 'tray', label: 'tray' }),
      label,
    );
    expect(boxes.map((b) => [b.id, b.label, b.action])).toEqual([
      ['cup', 'cup label', false],
      ['tray', 'tray label', true],
    ]);
  });

  it('adds the action item as a box of its own when the plan never declared it', () => {
    const boxes = erBoxes([found('cup', [0.1, 0.1, 0.2, 0.2])], action({}), label);
    expect(boxes).toHaveLength(2);
    expect(boxes[1]).toMatchObject({ id: null, label: 'red reset button', action: true });
  });

  it('marks nothing when the step needs nothing touched or ER could not see it', () => {
    expect(erBoxes([found('cup', [0.1, 0.1, 0.2, 0.2])], null, label).some((b) => b.action)).toBe(
      false,
    );
    const unseen = erBoxes([], action({ found: false, box: null }), label);
    expect(unseen).toEqual([]);
  });
});

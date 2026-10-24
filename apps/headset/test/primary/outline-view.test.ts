/// <reference path="../../src/adapters/render/troika.d.ts" />
import { Object3D, Vector3 } from 'three';
import { describe, expect, it, vi } from 'vitest';

// troika's SDF text needs a browser; a plain object stands in for the label.
vi.mock('../../src/adapters/render/text', () => ({
  makeText: () => Object.assign(new Object3D(), { text: '', fillOpacity: 1, sync() {} }),
  setText: (t: { text: string }, value: string) => {
    t.text = value;
  },
}));

import { ObjectHighlight } from '../../src/adapters/render/object-highlight';
import { PrimaryOutlineView } from '../../src/primary/outline-view';
import type { Placement } from '../../src/primary/placement';

const placement = (center: [number, number, number]): Placement =>
  ({
    center,
    outline: {
      shape: 'contour',
      points: [
        [-0.05, -0.02],
        [0.05, -0.02],
        [0.05, 0.02],
        [-0.05, 0.02],
      ],
    },
  }) as Placement;

describe('PrimaryOutlineView', () => {
  it('flares for a new object, not for each new mask of the same one', () => {
    const ignite = vi.spyOn(ObjectHighlight.prototype, 'ignite');
    const view = new PrimaryOutlineView();
    const eye = new Vector3(0, 0, 1);
    view.show(placement([0, 0, 0]), 'caliper');
    expect(ignite).toHaveBeenCalledTimes(1);
    view.update(eye, 1000, 0);
    view.show(placement([0, 0, 0]), 'caliper');
    view.show(placement([0.01, 0, 0]), 'caliper');
    expect(ignite).toHaveBeenCalledTimes(1);
    view.show(placement([0, 0, 0]), 'micrometer');
    expect(ignite).toHaveBeenCalledTimes(2);
    // Lost long enough to fade away, then found again: it lights up again.
    view.fade();
    view.update(eye, 1000, 0);
    view.show(placement([0, 0, 0]), 'micrometer');
    expect(ignite).toHaveBeenCalledTimes(3);
    ignite.mockRestore();
  });

  it('keeps the glow and label relative to the group, so moving the group moves them', () => {
    const view = new PrimaryOutlineView();
    view.show(placement([0.2, 1.1, -0.5]), 'caliper');
    expect(view.object.position.toArray()).toEqual([0.2, 1.1, -0.5]);
    const [highlight, label] = view.object.children;
    const glow = highlight?.children[1];
    const before = glow?.position.clone();
    view.object.position.set(0.3, 1.1, -0.5);
    expect(glow?.position).toEqual(before);
    expect(label?.position.y).toBeGreaterThan(0.02);
  });

  it('fades out when nothing is found and hides once dark', () => {
    const view = new PrimaryOutlineView();
    const eye = new Vector3(0, 0, 1);
    view.show(placement([0, 0, 0]), 'caliper');
    view.update(eye, 1000, 0);
    expect(view.object.visible).toBe(true);
    view.fade();
    view.update(eye, 300, 0);
    expect(view.object.visible).toBe(true);
    view.update(eye, 1000, 0);
    expect(view.object.visible).toBe(false);
  });
});

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
import { PrimaryOutlineView } from '../../src/adapters/render/outline-view';
import type { Placement } from '../../src/domain/world/placement';

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

  it('faces the camera the outline was seen from, its name as near as the top of the object', () => {
    const view = new PrimaryOutlineView();
    const seen = placement([0, 0, -0.5]);
    seen.eye = [0.03, 0, 0];
    seen.outline.relief = { offset: 0, slopeX: 0, slopeY: 0.8, distance: 0.5 };
    view.show(seen, 'tube');
    view.update(new Vector3(0, 0.2, 0), 16, 0);
    view.object.updateMatrixWorld();
    const facing = new Vector3(0, 0, 1).applyQuaternion(view.object.quaternion);
    const toCamera = new Vector3(0.03, 0, 0.5).normalize();
    expect(facing.dot(toCamera)).toBeCloseTo(1, 9);
    const label = view.object.children[1];
    // Above the outline's top (y 0.02), where the relief leans toward the camera.
    expect(label?.position.y).toBeGreaterThan(0.02);
    expect(label?.position.z).toBeGreaterThan(0.8 * 0.02);
    // A placement that does not say faces the viewer.
    view.show(placement([0, 0, -0.5]), 'tube');
    view.update(new Vector3(0, 0.2, 0), 16, 0);
    const viewer = new Vector3(0, 0.2, 0.5).normalize();
    expect(new Vector3(0, 0, 1).applyQuaternion(view.object.quaternion).dot(viewer)).toBeCloseTo(
      1,
      9,
    );
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

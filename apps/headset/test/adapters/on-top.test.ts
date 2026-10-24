/// <reference path="../../src/adapters/render/troika.d.ts" />
import { Group, Mesh, MeshBasicMaterial, Object3D, PlaneGeometry } from 'three';
import { describe, expect, it, vi } from 'vitest';

// troika's SDF text needs a browser; a plain object stands in for each line of text.
vi.mock('../../src/adapters/render/text', () => ({
  makeText: () => Object.assign(new Object3D(), { text: '', fillOpacity: 1, sync() {} }),
  setText: (t: { text: string }, value: string) => {
    t.text = value;
  },
}));

import { OCCLUDER_RENDER_ORDER } from '../../src/adapters/render/hand-occluders';
import { drawOnTop, ON_TOP_ORDER } from '../../src/adapters/render/on-top';
import { InstructionPanelPresenter } from '../../src/adapters/render/presenters/instruction-panel';

const meshes = (root: Object3D): Mesh[] => {
  const out: Mesh[] = [];
  root.traverse((o) => {
    if ((o as Mesh).isMesh) out.push(o as Mesh);
  });
  return out;
};

describe('drawOnTop', () => {
  it('takes every mesh out of the depth test, into the transparent pass, never culled', () => {
    const root = new Group();
    const inner = new Group();
    const opaque = new Mesh(new PlaneGeometry(), new MeshBasicMaterial());
    opaque.renderOrder = 3;
    // troika's Text hands out two materials (outline, fill).
    const text = new Mesh(new PlaneGeometry(), [new MeshBasicMaterial(), new MeshBasicMaterial()]);
    inner.add(text);
    root.add(opaque, inner);
    drawOnTop(root);
    for (const mesh of [opaque, text]) {
      expect(mesh.frustumCulled).toBe(false);
      for (const m of [mesh.material].flat()) {
        expect(m.depthTest).toBe(false);
        expect(m.depthWrite).toBe(false);
        expect(m.transparent).toBe(true);
      }
    }
    // Groups set the group order (after the glow and the occluders); meshes keep their layering.
    expect(root.renderOrder).toBe(ON_TOP_ORDER);
    expect(inner.renderOrder).toBe(ON_TOP_ORDER);
    expect(ON_TOP_ORDER).toBeGreaterThan(OCCLUDER_RENDER_ORDER);
    expect(opaque.renderOrder).toBe(3);
  });
});

describe('the instruction card', () => {
  it('is never hidden by the hands, and layers its card under its bar, text and button', () => {
    const panel = new InstructionPanelPresenter(() => {});
    for (const mesh of meshes(panel.object)) {
      const material = mesh.material as MeshBasicMaterial;
      expect(material.depthTest).toBe(false);
      expect(material.depthWrite).toBe(false);
    }
    const [card, ...rest] = panel.object.children;
    expect(card?.renderOrder).toBe(0);
    for (const child of rest) {
      if (!(child as Group).isGroup) expect(child.renderOrder).toBeGreaterThan(0);
    }
  });
});

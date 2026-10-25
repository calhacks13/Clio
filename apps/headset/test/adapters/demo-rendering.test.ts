import { HAND_SAMPLE_LENGTH } from '@clio/protocol';
import { Mesh, Vector3 } from 'three';
import { describe, expect, it, vi } from 'vitest';
import type { PresentContext } from '../../src/adapters/render/presenter';
import { GhostHandsPresenter } from '../../src/adapters/render/presenters/ghost-hands';
import { GloveHand } from '../../src/adapters/render/presenters/glove-hand';
import { GlyphsPresenter } from '../../src/adapters/render/presenters/glyphs';
import { sampleTrack } from '../../src/domain/demo/keyframes';
import type { Demonstration, Glyph } from '../../src/domain/demo/types';

function demo(...glyphs: Glyph[]): Demonstration {
  return {
    stepId: 'step',
    verb: 'place',
    source: 'synthesized',
    glyphs,
    clip: { durationMs: 2000, frames: [] },
    marks: {},
    captions: [],
  };
}
const ctx = (demonstration: Demonstration | null, t = 0) =>
  ({ demo: demonstration, t }) as PresentContext;
function meshes(presenter: GlyphsPresenter): Mesh[] {
  const result: Mesh[] = [];
  presenter.object.traverse((object) => {
    if (object instanceof Mesh) result.push(object);
  });
  return result;
}
const arrow: Glyph = { kind: 'arrow', from: [0, 0, 0], to: [0.3, 0.1, 0.2] };

describe('demonstration movement cues', () => {
  it('keeps the arrow tip at its destination while the directional markers travel', () => {
    const presenter = new GlyphsPresenter(() => false);
    const demonstration = demo(arrow);
    presenter.update(ctx(demonstration));
    const all = meshes(presenter);
    const head = all.find((mesh) => mesh.geometry.type === 'ConeGeometry');
    if (!head) throw new Error('No arrowhead');
    const height = (head.geometry as { parameters?: { height: number } }).parameters?.height ?? 0;
    const tip = new Vector3(0, height / 2, 0).applyQuaternion(head.quaternion).add(head.position);
    expect(tip.distanceTo(new Vector3(0.3, 0.15, 0.2))).toBeLessThan(1e-6);
    const runner = all.at(-1) as Mesh;
    const before = runner.position.clone();
    presenter.update(ctx(demonstration, 400));
    expect(runner.position.distanceTo(before)).toBeGreaterThan(0.02);
    expect(meshes(presenter)[0]).toBe(all[0]);
    expect(
      head.position
        .clone()
        .add(new Vector3(0, height / 2, 0).applyQuaternion(head.quaternion))
        .distanceTo(tip),
    ).toBeLessThan(1e-6);
    presenter.dispose();
  });

  it('keeps markers still with reduced motion, including when the preference changes live', () => {
    let reduced = false;
    const presenter = new GlyphsPresenter(() => reduced);
    const demonstration = demo(arrow);
    presenter.update(ctx(demonstration));
    reduced = true;
    presenter.update(ctx(demonstration, 300));
    const positions = meshes(presenter).map((mesh) => mesh.position.clone());
    presenter.update(ctx(demonstration, 900));
    meshes(presenter).forEach((mesh, i) => {
      expect(mesh.position.equals(positions[i] as Vector3)).toBe(true);
    });
    presenter.dispose();
  });

  it.each([1, -1])('draws a turn around its declared axis with direction %s', (sign) => {
    const presenter = new GlyphsPresenter();
    presenter.update(
      ctx(
        demo({
          kind: 'arc',
          center: [0, 0, 0],
          axis: [1, 0, 0],
          radius: 0.08,
          angle: sign * Math.PI,
        }),
      ),
    );
    const tube = meshes(presenter)[0];
    if (!tube || !('parameters' in tube.geometry)) throw new Error('No turn path');
    const path = (tube.geometry as import('three').TubeGeometry).parameters.path;
    const start = path.getPointAt(0);
    const next = path.getPointAt(0.1);
    expect(start.x).toBeCloseTo(0.04);
    expect(next.x).toBeCloseTo(0.04);
    expect(
      new Vector3().crossVectors(start.clone().setX(0), next.clone().sub(start)).x * sign,
    ).toBeGreaterThan(0);
    presenter.dispose();
  });

  it('omits degenerate paths and frees shared GPU resources when a demo ends', () => {
    const presenter = new GlyphsPresenter();
    presenter.update(ctx(demo({ kind: 'arrow', from: [0, 0, 0], to: [0, 0, 0] })));
    expect(presenter.object.children).toHaveLength(0);
    presenter.update(ctx(demo(arrow)));
    const geometries = [...new Set(meshes(presenter).map((mesh) => mesh.geometry))];
    const disposals = geometries.map((geometry) => vi.spyOn(geometry, 'dispose'));
    presenter.update(ctx(null));
    for (const spy of disposals) expect(spy).toHaveBeenCalledTimes(1);
    expect(presenter.object.children).toHaveLength(0);
    expect(presenter.object.visible).toBe(false);
  });
});

describe('demonstration gloves', () => {
  it.each(['left', 'right'] as const)(
    'renders every %s-hand shape without changing its clip',
    (hand) => {
      const glove = new GloveHand();
      for (const shape of ['open', 'flat', 'relaxed', 'point', 'pinch', 'grasp'] as const) {
        const sample = sampleTrack(
          [{ t: 0, shape, wrist: { p: [0.3, 0.1, -0.2], q: [0, 0, 0, 1] } }],
          0,
          hand,
        );
        if (!sample) throw new Error('No sample');
        const original = [...sample.joints];
        glove.update(sample);
        expect(glove.object.visible).toBe(true);
        expect(sample.joints).toEqual(original);
        glove.object.traverse((object) => {
          if (!(object instanceof Mesh)) return;
          expect([...object.geometry.getAttribute('position').array].every(Number.isFinite)).toBe(
            true,
          );
          expect(object.material).toMatchObject({ transparent: false, depthWrite: true });
        });
      }
      glove.update(null);
      expect(glove.object.visible).toBe(false);
      glove.update({ joints: new Array(HAND_SAMPLE_LENGTH).fill(0), pinch: 0 });
      expect(glove.object.visible).toBe(false);
      glove.dispose();
    },
  );

  it('hides the demo glove when only real tracked hands are present', () => {
    const presenter = new GhostHandsPresenter();
    const hand = sampleTrack(
      [{ t: 0, shape: 'open', wrist: { p: [0, 0, 0], q: [0, 0, 0, 1] } }],
      0,
      'right',
    );
    presenter.update({
      demoHands: { left: null, right: hand },
      hands: null,
      debug: false,
    } as PresentContext);
    expect(presenter.object.children[1]?.visible).toBe(true);
    presenter.update({
      demoHands: null,
      hands: { left: null, right: hand },
      debug: false,
    } as PresentContext);
    expect(presenter.object.children.every((object) => !object.visible)).toBe(true);
    presenter.dispose();
  });
});

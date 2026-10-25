import { parseProcedure } from '@clio/protocol';
import {
  type BufferGeometry,
  type Group,
  type Mesh,
  type MeshBasicMaterial,
  type ShaderMaterial,
  Vector3,
} from 'three';
import { describe, expect, it } from 'vitest';
import type { PresentContext } from '../../src/adapters/render/presenter';
import { OutlinesPresenter } from '../../src/adapters/render/presenters/outlines';
import type { Vec3 } from '../../src/core/math';
import type { OverlayOutline, OverlaySnapshot } from '../../src/domain/overlay/overlay-model';
import type { ObjectEstimate } from '../../src/domain/world/object-registry';
import type { ObjectOutline } from '../../src/domain/world/outline';

const [capSpec, jugSpec] = parseProcedure({
  schema: 'clio.procedure/1',
  id: 'p',
  version: 1,
  title: 'P',
  summary: 'S',
  workspace: { size: [1, 1] },
  objects: [
    { id: 'cap', label: 'cap', placement: { method: 'detect' } },
    { id: 'jug', label: 'jug', kind: 'container', placement: { method: 'detect' } },
  ],
  steps: [{ id: 's', instruction: 'Wait.', success: { type: 'elapsed', ms: 10 } }],
}).objects;

const CONTOUR: ObjectOutline = {
  points: [
    [-0.04, -0.04],
    [0.04, -0.04],
    [0.04, 0.04],
    [-0.04, 0.04],
    [-0.06, 0],
  ],
  shape: 'contour',
};
const BOX: ObjectOutline = { ...CONTOUR, points: CONTOUR.points.slice(0, 4), shape: 'box' };

const estimate = (id: 'cap' | 'jug', position: Vec3, heldBy: 'left' | null = null) =>
  ({
    id,
    spec: id === 'cap' ? capSpec : jugSpec,
    position,
    orientation: null,
    confidence: 0.9,
    source: 'detector',
    t: 0,
    heldBy,
  }) as ObjectEstimate;

function context(
  outlines: OverlayOutline[],
  objects: ObjectEstimate[],
  head: Vec3,
): PresentContext {
  const snapshot: OverlaySnapshot = {
    phase: 'lesson',
    title: null,
    instruction: null,
    highlights: [],
    outlines,
    toast: null,
    demoStepId: null,
    caption: null,
    coach: 'off',
    voice: 'quiet',
    recording: null,
    missing: [],
  };
  return {
    t: 0,
    dt: 16,
    snapshot,
    procedure: null,
    objects,
    demo: null,
    demoHands: null,
    hands: null,
    head: { p: head, q: [0, 0, 0, 1] },
    worldFromWorkspace: { p: [0, 0, 0], q: [0, 0, 0, 1] },
    calibration: null,
    debug: false,
  };
}

type Drawn = Group & {
  children: [Mesh<BufferGeometry, MeshBasicMaterial>, Mesh<BufferGeometry, ShaderMaterial>];
};
const drawn = (presenter: OutlinesPresenter) => presenter.object.children as Drawn[];
const facing = (group: Group) => new Vector3(0, 0, 1).applyQuaternion(group.quaternion);
const cap = (outline: ObjectOutline, rank = 0, offset: Vec3 = [0, 0, 0]): OverlayOutline => ({
  objectId: 'cap',
  outline,
  offset,
  rank,
  phrase: 'blue cap',
});

describe('OutlinesPresenter', () => {
  it("hangs each outline on its object's current estimate, turned toward the learner", () => {
    const presenter = new OutlinesPresenter();
    const objects = [estimate('cap', [0.2, 0.05, -0.3])];
    presenter.update(context([cap(CONTOUR)], objects, [0.2, 0.05, 0.7]));
    const [group] = drawn(presenter);
    expect(group?.visible).toBe(true);
    expect(group?.position.toArray()).toEqual([0.2, 0.05, -0.3]);
    expect(group && facing(group).distanceTo(new Vector3(0, 0, 1))).toBeLessThan(1e-6);

    // The learner walks around to the right: the outline turns to keep facing them.
    presenter.update(context([cap(CONTOUR)], objects, [1.2, 0.05, -0.3]));
    expect(group && facing(group).distanceTo(new Vector3(1, 0, 0))).toBeLessThan(1e-6);
  });

  it('shifts the outline to where the camera saw the object, when the estimate stayed put', () => {
    const presenter = new OutlinesPresenter();
    presenter.update(
      context([cap(CONTOUR, 0, [0.02, 0, -0.01])], [estimate('cap', [0.2, 0.05, -0.3])], [0, 0, 0]),
    );
    const position = drawn(presenter)[0]
      ?.position.toArray()
      .map((v) => Number(v.toFixed(6)));
    expect(position).toEqual([0.22, 0.05, -0.31]);
  });

  it('lights a contour without a stroke, and brackets the corners of a box', () => {
    const contour = new OutlinesPresenter();
    contour.update(context([cap(CONTOUR)], [estimate('cap', [0, 0, -1])], [0, 0, 0]));
    expect(drawn(contour)[0]?.children[0]?.visible).toBe(false);

    const box = new OutlinesPresenter();
    box.update(context([cap(BOX)], [estimate('cap', [0, 0, -1])], [0, 0, 0]));
    expect(drawn(box)[0]?.children[0]?.geometry.index?.count).toBe(4 * 2 * 6);
    expect(drawn(box)[0]?.children[0]?.visible).toBe(true);
  });

  it('keeps region targets on their surface and updates the mode when the target kind changes', () => {
    const presenter = new OutlinesPresenter();
    const region = estimate('cap', [0, 0, -1]);
    region.spec = { ...region.spec, kind: 'region' };
    presenter.update(context([cap(CONTOUR)], [region], [0, 0, 0]));
    const volume = drawn(presenter)[0]?.children[1];
    if (!volume) throw new Error('Missing target highlight');
    // A region's light stays on its measured surface: a shallow volume that barely spills.
    expect(volume.material.uniforms.spill?.value).toBeLessThan(1);
    expect(volume.material.uniforms.thickness?.value).toBeLessThanOrEqual(0.003);
    const tool = { ...region, spec: { ...region.spec, kind: 'tool' as const } };
    presenter.update(context([cap(CONTOUR)], [tool], [0, 0, 0]));
    expect(volume.material.uniforms.spill?.value).toBe(1);
    expect(volume.material.uniforms.thickness?.value).toBeGreaterThan(0.003);
    presenter.dispose();
  });

  it('colors what to act on and where it goes apart', () => {
    const presenter = new OutlinesPresenter();
    const outlines = [cap(CONTOUR), { ...cap(CONTOUR, 1), objectId: 'jug' }];
    const objects = [estimate('cap', [0, 0, -1]), estimate('jug', [0.3, 0, -1])];
    presenter.update(context(outlines, objects, [0, 0, 0]));
    const [first, second] = drawn(presenter).map((g) => g.children[0]?.material.color.getHex());
    expect(first).not.toBe(second);
  });

  it('hides an outline while its object is in hand, and drops it when the step moves on', () => {
    const presenter = new OutlinesPresenter();
    presenter.update(context([cap(CONTOUR)], [estimate('cap', [0, 0, -1])], [0, 0, 0]));
    expect(drawn(presenter).map((g) => g.visible)).toEqual([true]);
    presenter.update(context([cap(CONTOUR)], [estimate('cap', [0, 0, -1], 'left')], [0, 0, 0]));
    expect(drawn(presenter).map((g) => g.visible)).toEqual([false]);
    presenter.update(context([], [estimate('cap', [0, 0, -1])], [0, 0, 0]));
    expect(drawn(presenter)).toEqual([]);
  });

  it("leaves an object to its live light while that is on, and stands in when it isn't", () => {
    let lit = true;
    const presenter = new OutlinesPresenter((id) => lit && id === 'cap');
    const outlines = [cap(CONTOUR), { ...cap(CONTOUR, 1), objectId: 'jug' }];
    const objects = [estimate('cap', [0, 0, -1]), estimate('jug', [0.3, 0, -1])];
    const shown = () => drawn(presenter).map((g) => [g.position.x, g.visible]);
    presenter.update(context(outlines, objects, [0, 0, 0]));
    expect(shown()).toEqual([[0.3, true]]);
    lit = false;
    presenter.update(context(outlines, objects, [0, 0, 0]));
    expect(shown()).toEqual([
      [0.3, true],
      [0, true],
    ]);
    lit = true;
    presenter.update(context(outlines, objects, [0, 0, 0]));
    expect(shown()).toEqual([
      [0.3, true],
      [0, false],
    ]);
  });

  it('rebuilds the shape only when a new outline arrives', () => {
    const presenter = new OutlinesPresenter();
    const objects = [estimate('cap', [0, 0, -1])];
    presenter.update(context([cap(CONTOUR)], objects, [0, 0, 0]));
    const geometry = drawn(presenter)[0]?.children[0]?.geometry;
    presenter.update(context([cap(CONTOUR)], objects, [0, 0.1, 0]));
    expect(drawn(presenter)[0]?.children[0]?.geometry).toBe(geometry);
    presenter.update(context([cap(BOX)], objects, [0, 0.1, 0]));
    expect(drawn(presenter)[0]?.children[0]?.geometry).not.toBe(geometry);
  });
});

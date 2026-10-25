/// <reference path="../../src/adapters/render/troika.d.ts" />
import { HAND_SAMPLE_LENGTH, type HandSample, jointOffset } from '@clio/protocol';
import {
  Group,
  type Material,
  Matrix4,
  type Mesh,
  NoBlending,
  type Object3D,
  type ShaderMaterial,
  Vector3,
} from 'three';
import type { Text } from 'troika-three-text';
import { describe, expect, it } from 'vitest';
import { ON_TOP_ORDER } from '../../src/adapters/render/on-top';
import type { PresentContext } from '../../src/adapters/render/presenter';
import { WidgetChipsPresenter } from '../../src/adapters/render/widgets/chips';
import { WidgetDockPresenter } from '../../src/adapters/render/widgets/dock';
import {
  FingertipOccluder,
  HOLE_PUNCH_ORDER,
} from '../../src/adapters/render/widgets/fingertip-occluder';
import { choices, timer, widgetFixtures } from '../../src/adapters/render/widgets/fixtures';
import { fakeText, troikaText } from '../../src/adapters/render/widgets/text-port';
import { TOUCH } from '../../src/adapters/render/widgets/touch';
import { UiQuad } from '../../src/adapters/render/widgets/ui-quad';
import { CHIP_ORDERS, DOCK_ORDERS } from '../../src/adapters/render/widgets/views/face';
import type { Widget, WidgetSnapshot } from '../../src/domain/widgets/types';
import type { ObjectEstimate } from '../../src/domain/world/object-registry';

// Widgets are panels beside the step card, so they draw on top as it does (on-top.ts): no depth
// test, every group in the on-top group order (three resets the group order at each Group, the
// ones a view builds later included), the layers' own render orders inside. The fingertip's hole
// punch draws after them all and writes transparent black, so passthrough shows the real finger.

const T = 1000;

function context(t: number, over: Partial<PresentContext> = {}): PresentContext {
  return {
    t,
    dt: 16,
    snapshot: {
      phase: 'lesson',
      title: null,
      instruction: null,
      highlights: [],
      outlines: [],
      toast: null,
      demoStepId: null,
      caption: null,
      coach: 'off',
      voice: 'off',
      recording: null,
      missing: [],
    },
    procedure: null,
    objects: [],
    demo: null,
    demoHands: null,
    hands: null,
    head: { p: [0, 1.6, 0], q: [0, 0, 0, 1] },
    worldFromWorkspace: { p: [0, 0, 0], q: [0, 0, 0, 1] },
    calibration: null,
    debug: false,
    ...over,
  };
}

const isMesh = (o: Object3D): o is Mesh => (o as Mesh).isMesh === true;
const isGroup = (o: Object3D): o is Group => (o as Group).isGroup === true;
const materials = (mesh: Mesh): Material[] => [mesh.material].flat();

function dockOf(widgets: Widget[]) {
  const snap: WidgetSnapshot = { rev: 1, widgets };
  const object = new Group();
  object.position.set(0, 1.45, -0.65);
  const dock = new WidgetDockPresenter({
    source: () => snap,
    onIntent: () => {},
    anchor: { object, panelWidth: 0.3 },
    text: fakeText,
  });
  return dock;
}

/** A right hand whose index fingertip is at `tip` (world = workspace here). */
function hand(tip: Vector3): HandSample {
  const joints = new Array<number>(HAND_SAMPLE_LENGTH).fill(0);
  const put = (joint: Parameters<typeof jointOffset>[0], p: Vector3) => {
    const o = jointOffset(joint);
    joints[o] = p.x;
    joints[o + 1] = p.y;
    joints[o + 2] = p.z;
    joints[o + 6] = 1;
  };
  put('index-finger-tip', tip);
  put('index-finger-phalanx-distal', tip.clone().add(new Vector3(0, -0.012, 0.018)));
  put('index-finger-phalanx-intermediate', tip.clone().add(new Vector3(0, -0.024, 0.036)));
  return { joints, pinch: 0.08 };
}

describe('widget layering', () => {
  it('makes every quad and text skip the depth test, in the transparent pass', () => {
    const quad = new UiQuad({ mode: 'box', width: 0.1, height: 0.05 });
    expect(quad.mesh.material.depthTest).toBe(false);
    expect(quad.mesh.material.depthWrite).toBe(false);
    expect(quad.mesh.material.transparent).toBe(true);
    quad.dispose();
    // troika hands out a material derived from the one it is given; it inherits all three.
    const text = troikaText('body');
    for (const m of [(text.object as Text).material].flat()) {
      expect(m.depthTest).toBe(false);
      expect(m.depthWrite).toBe(false);
      expect(m.transparent).toBe(true);
    }
    text.dispose();
  });

  it('puts every group under the dock, views and pills included, in the on-top group order', () => {
    // Six widgets overflow the budget, so some collapse and build their pills too.
    const kinds = new Set<string>();
    const widgets = widgetFixtures(T)
      .filter((f) => f.state === 'running' && !kinds.has(f.kind) && kinds.add(f.kind))
      .map((f) => f.widget);
    const dock = dockOf(widgets);
    for (let t = T; t <= T + 600; t += 100) dock.update(context(t));
    let groups = 0;
    let meshes = 0;
    dock.object.traverse((o) => {
      if (isGroup(o)) {
        groups++;
        expect(o.renderOrder, o.name || o.type).toBe(ON_TOP_ORDER);
      }
      if (isMesh(o)) {
        meshes++;
        expect(o.renderOrder).toBeGreaterThanOrEqual(DOCK_ORDERS.card);
        for (const m of materials(o)) expect(m.depthTest).toBe(false);
      }
    });
    // The dock's three, then per view its group, pivot and card, plus pills and tabular clocks.
    expect(groups).toBeGreaterThan(3 + 6 * 3);
    expect(meshes).toBeGreaterThanOrEqual(6);
  });

  it('draws a chip on top as well, under the step card (its layers 0 to 4) and the dock', () => {
    const snap: WidgetSnapshot = { rev: 1, widgets: [timer(T, { objectId: 'cup_a' })] };
    const chips = new WidgetChipsPresenter({ source: () => snap, text: fakeText });
    const cup = {
      id: 'cup_a',
      spec: { id: 'cup_a', label: 'Cup A', radius: 0.04 },
      position: [0, 0.9, -0.6],
      orientation: null,
      confidence: 1,
      source: 'layout',
      t: 0,
      heldBy: null,
    } as unknown as ObjectEstimate;
    for (let t = T; t <= T + 600; t += 50) chips.update(context(t, { objects: [cup] }));
    let meshes = 0;
    chips.object.traverse((o) => {
      if (isGroup(o)) expect(o.renderOrder).toBe(ON_TOP_ORDER);
      if (isMesh(o)) {
        meshes++;
        expect(o.renderOrder).toBeLessThan(0);
        for (const m of materials(o)) expect(m.depthTest).toBe(false);
      }
    });
    expect(meshes).toBeGreaterThan(0);
    expect(CHIP_ORDERS.text).toBeLessThan(0);
    expect(DOCK_ORDERS.card).toBeGreaterThan(4);
  });

  it('punches the finger out after everything: transparent black, no blending or depth', () => {
    const punch = new FingertipOccluder();
    expect(punch.object.renderOrder).toBe(HOLE_PUNCH_ORDER);
    expect(HOLE_PUNCH_ORDER).toBeGreaterThan(ON_TOP_ORDER);
    const material = punch.material as ShaderMaterial;
    expect(material.blending).toBe(NoBlending);
    expect(material.transparent).toBe(true);
    expect(material.depthTest).toBe(false);
    expect(material.depthWrite).toBe(false);
    expect(material.fragmentShader).toContain('gl_FragColor = vec4(0.0)');
    // Only what is in front of the column and, seen from the eye, over it: never over the card.
    const column = new Matrix4().makeTranslation(0.3, 1.2, -0.6);
    punch.setColumn(column, 0.08, 0.25);
    const toColumn = material.uniforms.uColumn?.value as Matrix4;
    expect(new Vector3(0.3, 1.2, -0.6).applyMatrix4(toColumn).toArray()).toEqual([0, 0, 0]);
    expect(material.uniforms.uSize?.value.toArray()).toEqual([0.08, 0.25]);
    expect(material.fragmentShader).toContain('cameraPosition');
    expect(material.fragmentShader).toContain('abs(seen.x) > uSize.x');
    punch.dispose();
  });

  it('shows the punch only while a fingertip near a target is in front of the column', () => {
    const dock = dockOf([choices(T)]);
    for (let t = T; t <= T + 800; t += 100) dock.update(context(t));
    const target = dock.targets[0];
    if (!target) throw new Error('no target');
    const at = (z: number): Vector3 => {
      dock.column.updateWorldMatrix(true, false);
      return dock.column.localToWorld(new Vector3(target.cx, target.cy, z));
    };
    const frame = (t: number, z: number) =>
      dock.update(
        context(t, {
          hands: { t: 0, head: context(0).head, left: null, right: hand(at(z)) },
        }),
      );
    frame(T + 900, 0.04);
    const punch = dock.object.children.find((c) => c.renderOrder === HOLE_PUNCH_ORDER);
    expect(punch?.visible).toBe(true);
    // Pushed through no deeper than a press counts: still shown (only its front part punches).
    frame(T + 916, TOUCH.behindZ / 2);
    expect(punch?.visible).toBe(true);
    // Behind the column: the widget is nearer, so nothing punches.
    frame(T + 932, -0.06);
    expect(punch?.visible).toBe(false);
    frame(T + 948, 0.03);
    expect(punch?.visible).toBe(true);
    dock.update(context(T + 964));
    expect(punch?.visible).toBe(false);
  });
});

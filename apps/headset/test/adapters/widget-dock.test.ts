import { HAND_SAMPLE_LENGTH, type HandSample, jointOffset } from '@clio/protocol';
import { Group, type Mesh, type PlaneGeometry, type ShaderMaterial, Vector3 } from 'three';
import { describe, expect, it, vi } from 'vitest';
import type { PresentContext } from '../../src/adapters/render/presenter';
import { SWITCH_DWELL_MS, WidgetDockPresenter } from '../../src/adapters/render/widgets/dock';
import { checklist, choices, timer, value } from '../../src/adapters/render/widgets/fixtures';
import { dockOffset, dockYaw, dockYawFloor } from '../../src/adapters/render/widgets/placement';
import { FakeTextObject, fakeText } from '../../src/adapters/render/widgets/text-port';
import { WIDGET_THEME } from '../../src/adapters/render/widgets/theme';
import { WidgetView } from '../../src/adapters/render/widgets/views/view';
import type { Vec3 } from '../../src/core/math';
import type { Widget, WidgetIntent, WidgetSnapshot } from '../../src/domain/widgets/types';
import type { Placement } from '../../src/domain/world/placement';

// The dock presenter in three's scene graph, with fake text: lazy views, reconciling snapshots by
// identity, exits, calibration, a scripted fingertip press, following the card's group and width
// (and holding still under a finger), changing sides when an object is behind the column, and
// deterministic digits at a frozen t.

const T = 1000;

function context(t: number, dt = 16, over: Partial<PresentContext> = {}): PresentContext {
  return {
    t,
    dt,
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

/** The step card as the dock sees it: a group placed by hand, and its width. */
function card(width = 0.3) {
  const object = new Group();
  object.position.set(0, 1.45, -0.65);
  return { object, panelWidth: width };
}

function setup(widgets: Widget[] = [], cardWidth = 0.3) {
  let snap: WidgetSnapshot = { rev: 1, widgets };
  const intents: WidgetIntent[] = [];
  const panel = card(cardWidth);
  const anchor = panel.object;
  const dock = new WidgetDockPresenter({
    source: () => snap,
    onIntent: (i) => intents.push(i),
    anchor: panel,
    text: fakeText,
  });
  const show = (next: Widget[]) => {
    snap = { rev: snap.rev + 1, widgets: next };
  };
  return { dock, intents, anchor, panel, show };
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

/** A live tracker's square silhouette `size` wide at `center` (world), facing the eye. */
const mask = (center: Vec3, size = 0.08): Placement => ({
  center,
  outline: {
    shape: 'contour',
    points: [
      [-size / 2, -size / 2],
      [size / 2, -size / 2],
      [size / 2, size / 2],
      [-size / 2, size / 2],
    ],
  },
  points: [],
  label: [center[0], center[1] + size / 2, center[2]],
  depth: 'point',
});
/** Behind where the column hangs beside the 0.3 m card, on its right and on its left. */
const RIGHT = mask([0.26, 1.56, -0.62]);
const LEFT = mask([-0.26, 1.56, -0.62]);

/** The head at the eye turned `deg` to the left (negative: right). */
const facing = (deg: number): PresentContext['head'] => {
  const half = (deg * Math.PI) / 360;
  return { p: [0, 1.6, 0], q: [0, Math.sin(half), 0, Math.cos(half)] };
};
const LOOK_LEFT = facing(30);

/** Where target (widgetId, index) is, `z` in front of the column, in world space. */
function targetPoint(
  dock: WidgetDockPresenter,
  widgetId: string,
  index: number,
  z: number,
): Vector3 {
  const target = dock.targets.find((h) => h.widgetId === widgetId && h.index === index);
  if (!target) throw new Error(`no target ${widgetId}:${index}`);
  dock.column.updateWorldMatrix(true, false);
  return dock.column.localToWorld(new Vector3(target.cx, target.cy, z));
}

const texts = (root: Group, role: FakeTextObject['role']): FakeTextObject[] => {
  const out: FakeTextObject[] = [];
  root.traverse((o) => {
    if (o instanceof FakeTextObject && o.role === role) out.push(o);
  });
  return out;
};

/** The dock's quads (meshes with the widget shader), in the order they were built. */
function quads(dock: WidgetDockPresenter, mode: number): Mesh<PlaneGeometry, ShaderMaterial>[] {
  const out: Mesh<PlaneGeometry, ShaderMaterial>[] = [];
  dock.column.traverse((o) => {
    const mesh = o as Mesh<PlaneGeometry, ShaderMaterial>;
    if (mesh.isMesh && mesh.material.uniforms?.uMode?.value === mode) out.push(mesh);
  });
  return out;
}

/** How far the checklist's circle for row `i` is filled (its disc scale). */
const disc = (dock: WidgetDockPresenter, i: number): number =>
  quads(dock, 2)[i]?.material.uniforms.uParam?.value.w ?? Number.NaN;

/** The checklist's hover tile's opacity (the first rounded box after the card's own). */
const tile = (dock: WidgetDockPresenter): number => {
  const tileQuad = quads(dock, 0)[1];
  return tileQuad?.visible ? (tileQuad.material.uniforms.uOpacity?.value ?? 0) : 0;
};

describe('WidgetDockPresenter', () => {
  it('builds nothing until a widget shows, then a view per widget', () => {
    const { dock, show } = setup();
    expect(dock.column.children).toHaveLength(0);
    dock.update(context(T));
    expect(dock.column.children).toHaveLength(0);
    show([timer(T), value(T)]);
    dock.update(context(T + 16));
    expect(dock.column.children).toHaveLength(2);
  });

  it('does nothing for the same snapshot twice: no set, no new children', () => {
    const { dock } = setup([timer(T), checklist(T)]);
    dock.update(context(T));
    const set = vi.spyOn(WidgetView.prototype, 'set');
    const count = dock.column.children.length;
    dock.update(context(T + 16));
    dock.update(context(T + 32));
    expect(set).not.toHaveBeenCalled();
    expect(dock.column.children).toHaveLength(count);
    set.mockRestore();
  });

  it('passes a changed record to its view and keeps the view', () => {
    const { dock, show } = setup([value(T)]);
    dock.update(context(T));
    const view = dock.column.children[0];
    show([value(T, { value: '30 N m', updatedT: T + 10 })]);
    dock.update(context(T + 16));
    expect(dock.column.children[0]).toBe(view);
    expect(texts(dock.column, 'figure').map((t) => t.text)).toContain('30 N m');
  });

  it('lets a removed widget exit and disposes it after 160 ms', () => {
    const { dock, show } = setup([timer(T), value(T)]);
    dock.update(context(T));
    // Drawn once it has begun to fade in.
    dock.update(context(T + 50));
    show([timer(T)]);
    dock.update(context(T + 100));
    expect(dock.column.children).toHaveLength(2);
    dock.update(context(T + 200));
    expect(dock.column.children).toHaveLength(2);
    dock.update(context(T + 261));
    expect(dock.column.children).toHaveLength(1);
  });

  it('hides during calibration', () => {
    const { dock } = setup([timer(T)]);
    dock.update(context(T));
    expect(dock.object.visible).toBe(true);
    dock.update(
      context(T + 16, 16, {
        calibration: { text: 'Touch the table', error: null, firstCorner: null } as never,
      }),
    );
    expect(dock.object.visible).toBe(false);
    dock.update(context(T + 32));
    expect(dock.object.visible).toBe(true);
  });

  it('turns a fingertip press on an answer into an intent', () => {
    const { dock, intents } = setup([choices(T)]);
    for (let t = T; t <= T + 800; t += 100) dock.update(context(t, 100));
    expect(dock.targets.map((h) => h.index)).toEqual([0, 1]);
    const steps = [0.1, 0.05, 0.03, 0.015, 0.004, 0, 0];
    steps.forEach((z, i) => {
      const tip = targetPoint(dock, 'choices', 1, z);
      dock.update(
        context(T + 900 + i * 16, 16, {
          hands: { t: 0, head: context(0).head, left: null, right: hand(tip) },
        }),
      );
    });
    expect(intents).toEqual([{ type: 'choose', widgetId: 'choices', index: 1, hand: 'right' }]);
  });

  it('takes no touch on a widget that is leaving: no hover, no press look, no intent', () => {
    const { dock, intents, show } = setup([checklist(T)]);
    for (let t = T; t <= T + 800; t += 100) dock.update(context(t, 100));
    const above = targetPoint(dock, 'checklist', 1, 0.04);
    const on = targetPoint(dock, 'checklist', 1, 0);
    // Its step lost focus while a finger hovers row 1: the hover goes, and so do the targets.
    let t = T + 900;
    const finger = (tip: Vector3) => ({
      t: 0,
      head: context(0).head,
      left: null,
      right: hand(tip),
    });
    for (let i = 0; i < 4; i++, t += 16) dock.update(context(t, 16, { hands: finger(above) }));
    expect(tile(dock)).toBeGreaterThan(0);
    show([checklist(T, { leaving: true })]);
    for (let i = 0; i < 20; i++, t += 16) dock.update(context(t, 16, { hands: finger(above) }));
    expect(dock.targets).toEqual([]);
    expect(tile(dock)).toBe(0);
    // A press from the front: nothing reaches the board, and the circle never fills.
    for (const z of [0.1, 0.05, 0.03, 0.015, 0.004, 0, 0]) {
      const tip = above.clone().lerp(on, 1 - z / 0.04);
      t += 16;
      dock.update(context(t, 16, { hands: finger(tip) }));
      expect(disc(dock, 1)).toBe(0);
    }
    expect(intents).toEqual([]);
    expect(dock.isFrozen).toBe(false);
  });

  it('says a fingertip is over its cards only on them, at about their depth', () => {
    const { dock } = setup([checklist(T)]);
    const off = new Vector3(0, 1.4, -0.6);
    expect(dock.covers(off)).toBe(false);
    for (let t = T; t <= T + 600; t += 100) dock.update(context(t, 100));
    dock.column.updateWorldMatrix(true, false);
    const at = (x: number, y: number, z: number) => dock.column.localToWorld(new Vector3(x, y, z));
    const width = WIDGET_THEME.size.dockWidth;
    expect(dock.covers(targetPoint(dock, 'checklist', 1, 0.01))).toBe(true);
    expect(dock.covers(at(0, -dock.columnHeight / 2, 0))).toBe(true);
    // Beside it, where the card sits, above or below it, or well in front or behind: not over it.
    expect(dock.covers(at(-width / 2 - 0.01, -0.02, 0))).toBe(false);
    expect(dock.covers(at(0, 0.01, 0))).toBe(false);
    expect(dock.covers(at(0, -dock.columnHeight - 0.01, 0))).toBe(false);
    expect(dock.covers(at(0, -0.02, 0.2))).toBe(false);
    expect(dock.covers(at(0, -0.02, -0.1))).toBe(false);
  });

  it("copies the card group's pose every frame", () => {
    const { dock, anchor } = setup([timer(T)]);
    for (let i = 0; i < 5; i++) {
      anchor.position.set(0.1 * i, 1.4 + 0.01 * i, -0.6);
      anchor.rotation.y = 0.2 * i;
      dock.update(context(T + i * 16));
      expect(dock.follow.position.toArray()).toEqual(anchor.position.toArray());
      expect(dock.follow.quaternion.toArray()).toEqual(anchor.quaternion.toArray());
    }
  });

  it('holds still while a finger is near a touchable card, then eases back to the card', () => {
    const { dock, anchor } = setup([checklist(T)]);
    for (let t = T; t <= T + 600; t += 100) dock.update(context(t, 100));
    const tip = targetPoint(dock, 'checklist', 1, 0.04);
    const finger = { t: 0, head: context(0).head, left: null, right: hand(tip) };
    // The frame that sees the finger still follows; the next ones hold.
    let t = T + 700;
    dock.update(context(t, 16, { hands: finger }));
    t += 16;
    const held = dock.follow.position.clone();
    // The card creeps 2 cm meanwhile: near enough to glide back to.
    for (let i = 0; i < 10; i++, t += 16) {
      anchor.position.x += 0.002;
      dock.update(context(t, 16, { hands: finger }));
    }
    expect(dock.isFrozen).toBe(true);
    expect(dock.follow.position.toArray()).toEqual(held.toArray());

    // The finger leaves: still held for 400 ms, then it eases rather than jumps.
    for (let i = 0; i < 20; i++, t += 16) dock.update(context(t));
    expect(dock.isFrozen).toBe(true);
    for (let i = 0; i < 8; i++, t += 16) dock.update(context(t));
    expect(dock.isFrozen).toBe(false);
    const gap = dock.follow.position.distanceTo(anchor.position);
    expect(gap).toBeGreaterThan(0);
    expect(gap).toBeLessThan(anchor.position.distanceTo(held));
    for (let i = 0; i < 120; i++, t += 16) dock.update(context(t));
    expect(dock.follow.position.toArray()).toEqual(anchor.position.toArray());
    expect(dock.follow.quaternion.toArray()).toEqual(anchor.quaternion.toArray());
  });

  it('fades back to a card that went far while it was held, never gliding there', () => {
    for (const move of ['along', 'turn'] as const) {
      const { dock, anchor } = setup([checklist(T)]);
      for (let t = T; t <= T + 600; t += 100) dock.update(context(t, 100));
      const tip = targetPoint(dock, 'checklist', 1, 0.04);
      const finger = { t: 0, head: context(0).head, left: null, right: hand(tip) };
      let t = T + 700;
      for (let i = 0; i < 3; i++, t += 16) dock.update(context(t, 16, { hands: finger }));
      expect(dock.isFrozen).toBe(true);
      const held = dock.follow.position.clone();
      const heldQ = dock.follow.quaternion.clone();
      // The card relocates under the finger: 12 cm along, or a 6 degree turn.
      if (move === 'along') anchor.position.x += 0.12;
      else anchor.rotateY((6 * Math.PI) / 180);
      for (let i = 0; i < 10; i++, t += 16) dock.update(context(t, 16, { hands: finger }));
      // The finger leaves. The column is only ever held or on the card, and moves while unseen.
      let moved = false;
      for (let i = 0; i < 80; i++, t += 16) {
        dock.update(context(t));
        const atHeld =
          dock.follow.position.equals(held) && dock.follow.quaternion.angleTo(heldQ) < 1e-6;
        const atCard =
          dock.follow.position.equals(anchor.position) &&
          dock.follow.quaternion.angleTo(anchor.quaternion) < 1e-6;
        expect(atHeld || atCard, `${move} at ${i}`).toBe(true);
        if (atCard && !moved) {
          moved = true;
          expect(dock.column.children[0]?.visible, move).toBe(false);
        }
      }
      expect(moved, move).toBe(true);
      expect(texts(dock.column, 'title')[0]?.opacity, move).toBe(1);
    }
  });

  it('does not freeze for a finger near a card with nothing to touch', () => {
    const { dock } = setup([timer(T)]);
    dock.update(context(T));
    dock.column.updateWorldMatrix(true, false);
    const tip = dock.column.localToWorld(new Vector3(0, -0.04, 0.03));
    dock.update(
      context(T + 16, 16, { hands: { t: 0, head: context(0).head, left: null, right: hand(tip) } }),
    );
    expect(dock.isFrozen).toBe(false);
  });

  it('shows the same digits at the same frozen t', () => {
    const digits = (t: number) => {
      const { dock } = setup([timer(T)]);
      dock.update(context(T - 500, 0));
      dock.update(context(t, 0));
      dock.update(context(t, 0));
      return texts(dock.column, 'display')
        .map((c) => c.text)
        .join('');
    };
    expect(digits(T)).toBe('1:52');
    expect(digits(T)).toBe(digits(T));
    expect(digits(T + 1500)).toBe('1:51');
  });

  it('fades the clock out at 0:00 when a timer ends', () => {
    const { dock, show } = setup([timer(T, { left: 1500 })]);
    const clock = () =>
      texts(dock.column, 'display')
        .map((c) => c.text)
        .join('');
    dock.update(context(T));
    dock.update(context(T + 1000));
    expect(clock()).toBe('0:01');
    show([timer(T, { left: 1500, status: 'done', doneT: T + 1500, closeAt: T + 11_500 })]);
    dock.update(context(T + 1500));
    expect(clock()).toBe('0:00');
  });

  it('eases to a new card width, and is never over a card that grew', () => {
    const { dock, panel } = setup([timer(T)]);
    for (let t = T; t <= T + 200; t += 16) dock.update(context(t));
    const x = (width: number) => dockOffset(1, dockYaw(width)).position[0];
    expect(dock.column.position.x).toBeCloseTo(x(0.3), 9);
    panel.panelWidth = 0.2;
    let t = T + 216;
    dock.update(context(t));
    t += 16;
    expect(dock.column.position.x).toBeLessThan(x(0.3));
    expect(dock.column.position.x).toBeGreaterThan(x(0.2) + 0.005);
    for (let i = 0; i < 120; i++, t += 16) dock.update(context(t));
    expect(dock.column.position.x).toBeCloseTo(x(0.2), 9);
    // A wider card: the column moves out at once as far as the card's new edge, then eases on.
    panel.panelWidth = 0.38;
    dock.update(context(t));
    t += 16;
    const yaw = -dock.column.rotation.y;
    expect(yaw).toBeGreaterThanOrEqual(dockYawFloor(0.38) - 1e-9);
    expect(yaw).toBeLessThan(dockYaw(0.38));
    for (let i = 0; i < 120; i++, t += 16) dock.update(context(t));
    expect(dock.column.position.x).toBeCloseTo(x(0.38), 9);
    expect(dock.column.position.y).toBeCloseTo(0.15, 9);
  });

  it('follows a card that relocated as it resized at once', () => {
    const { dock, anchor, panel } = setup([timer(T)]);
    for (let t = T; t <= T + 200; t += 16) dock.update(context(t));
    panel.panelWidth = 0.25;
    anchor.position.x += 0.2;
    dock.update(context(T + 216));
    expect(Math.abs(dock.column.position.x)).toBeCloseTo(
      dockOffset(1, dockYaw(0.25)).position[0],
      9,
    );
    expect(dock.follow.position.toArray()).toEqual(anchor.position.toArray());
  });

  it('hides while the card is hidden, then takes its pose and width at once', () => {
    const { dock, anchor, panel } = setup([timer(T)]);
    anchor.visible = false;
    dock.update(context(T));
    expect(dock.object.visible).toBe(false);
    anchor.position.set(0.3, 1.2, -0.5);
    anchor.rotation.y = 0.4;
    panel.panelWidth = 0.22;
    anchor.visible = true;
    dock.update(context(T + 16));
    expect(dock.object.visible).toBe(true);
    expect(dock.follow.position.toArray()).toEqual(anchor.position.toArray());
    expect(dock.follow.quaternion.toArray()).toEqual(anchor.quaternion.toArray());
    expect(Math.abs(dock.column.position.x)).toBeCloseTo(
      dockOffset(1, dockYaw(0.22)).position[0],
      9,
    );
  });

  it('shows again as it is now: a widget that closed while hidden never flashes back', () => {
    const { dock, anchor, show } = setup([timer(T), value(T)]);
    for (let t = T; t <= T + 600; t += 16) dock.update(context(t));
    const [timerView, valueView] = dock.column.children;
    expect(valueView?.position.y).toBeLessThan(-0.05);
    anchor.visible = false;
    dock.update(context(T + 700));
    // The timer closed while the card was hidden; the value moves up into its place.
    show([value(T)]);
    dock.update(context(T + 5000));
    anchor.visible = true;
    dock.update(context(T + 5016));
    expect(timerView?.parent).toBeNull();
    expect(dock.column.children).toEqual([valueView]);
    expect(valueView?.position.y).toBeCloseTo(0, 9);
  });

  it('still lets a widget the learner saw fade out where it was', () => {
    const { dock, show } = setup([timer(T), value(T)]);
    for (let t = T; t <= T + 600; t += 16) dock.update(context(t));
    const [timerView, valueView] = dock.column.children;
    const before = valueView?.position.y ?? 0;
    show([value(T)]);
    dock.update(context(T + 616));
    expect(timerView?.visible).toBe(true);
    expect(valueView?.position.y).toBeCloseTo(before, 3);
  });

  it('changes sides when an object is behind it: after a dwell, by fading, never sweeping', () => {
    const { dock } = setup([timer(T)]);
    let t = T;
    for (; t <= T + 600; t += 16) dock.update(context(t));
    const x0 = dock.column.position.x;
    const label = texts(dock.column, 'label')[0];
    expect(x0).toBeGreaterThan(0);
    expect(label?.opacity).toBe(1);
    const blocked = t;
    const frames: { t: number; x: number; shown: boolean }[] = [];
    for (; t <= blocked + 1000; t += 16) {
      dock.update(context(t, 16, { objectMasks: [RIGHT] }));
      const view = dock.column.children[0];
      frames.push({ t: t - blocked, x: dock.column.position.x, shown: view?.visible ?? false });
    }
    // It waits out the dwell on its side, fully shown.
    for (const f of frames.filter((f) => f.t < SWITCH_DWELL_MS)) {
      expect(f.x).toBe(x0);
      expect(f.shown).toBe(true);
    }
    // It is only ever at one of the two places, and jumps between them unseen.
    for (const [i, f] of frames.entries()) {
      expect(Math.abs(f.x)).toBeCloseTo(x0, 9);
      const before = frames[i - 1];
      if (before && Math.sign(before.x) !== Math.sign(f.x)) expect(f.shown).toBe(false);
    }
    expect(dock.side).toBe(-1);
    expect(dock.column.position.x).toBeCloseTo(-x0, 9);
    expect(label?.opacity).toBe(1);
    // Clear where it is now: it stays.
    for (let i = 0; i < 40; i++, t += 16) dock.update(context(t));
    expect(dock.side).toBe(-1);
  });

  it('does not change sides for a flicker shorter than the dwell', () => {
    const { dock } = setup([timer(T)]);
    let t = T;
    for (; t <= T + 600; t += 16) dock.update(context(t));
    for (let i = 0; i < 10; i++, t += 16) dock.update(context(t, 16, { objectMasks: [RIGHT] }));
    for (let i = 0; i < 10; i++, t += 16) dock.update(context(t));
    for (let i = 0; i < 10; i++, t += 16) dock.update(context(t, 16, { objectMasks: [RIGHT] }));
    expect(dock.side).toBe(1);
    expect(dock.column.position.x).toBeGreaterThan(0);
  });

  it('stays where it is when both sides are blocked', () => {
    const { dock } = setup([timer(T)]);
    let t = T;
    for (; t <= T + 600; t += 16) dock.update(context(t));
    for (let i = 0; i < 80; i++, t += 16) {
      dock.update(context(t, 16, { objectMasks: [RIGHT, LEFT] }));
      expect(dock.column.children[0]?.visible).toBe(true);
    }
    expect(dock.side).toBe(1);
  });

  it('puts a column nobody has seen yet on the clear side at once', () => {
    const { dock, show } = setup();
    dock.update(context(T, 16, { objectMasks: [RIGHT] }));
    show([timer(T)]);
    dock.update(context(T + 16, 16, { objectMasks: [RIGHT] }));
    expect(dock.side).toBe(-1);
    expect(dock.column.position.x).toBeLessThan(0);
  });

  it('drops a side change it was making when it hides, and picks its side afresh', () => {
    const { dock, anchor } = setup([timer(T)]);
    let t = T;
    for (; t <= T + 600; t += 16) dock.update(context(t));
    // Blocked on the right past the dwell: it starts fading out to change sides.
    const blocked = t;
    for (; t < blocked + SWITCH_DWELL_MS + 64; t += 16) {
      dock.update(context(t, 16, { objectMasks: [RIGHT] }));
    }
    expect(dock.side).toBe(-1);
    expect(dock.column.position.x).toBeGreaterThan(0);
    anchor.visible = false;
    dock.update(context(t, 16, { objectMasks: [RIGHT] }));
    // Shown again with the right clear and the left blocked: it stays right, shown at once.
    anchor.visible = true;
    t += 2000;
    for (let i = 0; i < 40; i++, t += 16) {
      dock.update(context(t, 16, { objectMasks: [LEFT] }));
      expect(dock.side).toBe(1);
      expect(dock.column.position.x).toBeGreaterThan(0);
    }
    expect(texts(dock.column, 'label')[0]?.opacity).toBe(1);
  });

  it('puts a new column on the clear side nearer where the head faces', () => {
    const sideFor = (head: PresentContext['head'], objectMasks: Placement[] = []) => {
      const { dock, show } = setup();
      dock.update(context(T, 16, { head, objectMasks }));
      show([timer(T)]);
      for (let t = T + 16; t < T + 400; t += 16) dock.update(context(t, 16, { head, objectMasks }));
      return dock.side;
    };
    expect(sideFor(facing(0))).toBe(1);
    expect(sideFor(facing(-30))).toBe(1);
    expect(sideFor(LOOK_LEFT)).toBe(-1);
    // A clear side beats a nearer one.
    expect(sideFor(LOOK_LEFT, [LEFT])).toBe(1);
    expect(sideFor(facing(-30), [RIGHT])).toBe(-1);
  });

  it('keeps its side while the head turns, and picks again when the card relocates', () => {
    const { dock, anchor } = setup([timer(T)]);
    let t = T;
    for (; t <= T + 600; t += 16) dock.update(context(t));
    expect(dock.side).toBe(1);
    // The head turns left and stays: stability beats a nearer side.
    for (let i = 0; i < 60; i++, t += 16) dock.update(context(t, 16, { head: LOOK_LEFT }));
    expect(dock.side).toBe(1);
    // The card jumps 10 cm from rest (a relocation): the column jumps with it, to the left, shown.
    anchor.position.y -= 0.1;
    dock.update(context(t, 16, { head: LOOK_LEFT }));
    expect(dock.side).toBe(-1);
    expect(dock.column.position.x).toBeLessThan(0);
    expect(dock.column.children[0]?.visible).toBe(true);
    expect(texts(dock.column, 'label')[0]?.opacity).toBe(1);
  });

  it('picks its side once a catch-up settles somewhere new, unseen as it changes', () => {
    const { dock, anchor } = setup([timer(T)]);
    let t = T;
    for (; t <= T + 600; t += 16) dock.update(context(t));
    const x0 = dock.column.position.x;
    const head = LOOK_LEFT;
    // A one-second glide of 30 cm, in small steps: no pick on the way.
    for (let i = 0; i < 60; i++, t += 16) {
      anchor.position.x += 0.005;
      dock.update(context(t, 16, { head }));
      expect(dock.side).toBe(1);
    }
    let changed = false;
    for (let i = 0; i < 60; i++, t += 16) {
      const before = dock.column.position.x;
      dock.update(context(t, 16, { head }));
      expect(Math.abs(dock.column.position.x)).toBeCloseTo(x0, 9);
      if (Math.sign(before) !== Math.sign(dock.column.position.x)) {
        changed = true;
        expect(dock.column.children[0]?.visible).toBe(false);
      }
    }
    expect(changed).toBe(true);
    expect(dock.side).toBe(-1);
    expect(texts(dock.column, 'label')[0]?.opacity).toBe(1);
  });

  it('stays on its side when the card settles nearby', () => {
    const { dock, anchor } = setup([timer(T)]);
    let t = T;
    for (; t <= T + 600; t += 16) dock.update(context(t));
    for (let i = 0; i < 10; i++, t += 16) {
      anchor.position.x += 0.002;
      dock.update(context(t, 16, { head: LOOK_LEFT }));
    }
    for (let i = 0; i < 60; i++, t += 16) dock.update(context(t, 16, { head: LOOK_LEFT }));
    expect(dock.side).toBe(1);
  });

  it('picks its side where the card is when the card relocates as it changes sides: one fade', () => {
    const { dock, anchor } = setup([timer(T)]);
    const head = facing(-30);
    let t = T;
    for (; t <= T + 600; t += 16) dock.update(context(t, 16, { head }));
    // Blocked on the right past the dwell: it starts fading out to the left.
    const blocked = t;
    for (; t < blocked + SWITCH_DWELL_MS + 48; t += 16) {
      dock.update(context(t, 16, { head, objectMasks: [RIGHT] }));
    }
    expect(dock.side).toBe(-1);
    expect(dock.column.position.x).toBeGreaterThan(0);
    // Meanwhile the card relocates 30 cm left, where nothing is behind its right side, which the
    // head faces: the column comes back in there, and stays.
    anchor.position.x -= 0.3;
    let fades = 0;
    let shown = true;
    for (let i = 0; i < 100; i++, t += 16) {
      dock.update(context(t, 16, { head, objectMasks: [RIGHT] }));
      const label = texts(dock.column, 'label')[0];
      const now = (dock.column.children[0]?.visible ?? false) && (label?.opacity ?? 0) > 0.99;
      if (shown && !now) fades++;
      shown = now;
    }
    expect(fades).toBe(1);
    expect(dock.side).toBe(1);
    expect(dock.column.position.x).toBeGreaterThan(0);
    expect(texts(dock.column, 'label')[0]?.opacity).toBe(1);
  });

  it('keeps its side while frozen under a finger', () => {
    const { dock } = setup([checklist(T)]);
    for (let t = T; t <= T + 600; t += 100) dock.update(context(t, 100));
    const tip = targetPoint(dock, 'checklist', 1, 0.04);
    const finger = { t: 0, head: context(0).head, left: null, right: hand(tip) };
    let t = T + 700;
    for (let i = 0; i < 60; i++, t += 16) {
      dock.update(context(t, 16, { hands: finger, objectMasks: [RIGHT] }));
    }
    expect(dock.isFrozen).toBe(true);
    expect(dock.side).toBe(1);
    // The finger leaves: once the column is free again, it moves.
    for (let i = 0; i < 80; i++, t += 16) dock.update(context(t, 16, { objectMasks: [RIGHT] }));
    expect(dock.isFrozen).toBe(false);
    expect(dock.side).toBe(-1);
  });
});

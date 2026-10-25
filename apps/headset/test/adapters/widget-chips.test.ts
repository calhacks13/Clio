import type { ObjectSpec } from '@clio/protocol';
import { type Object3D, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import type { PresentContext } from '../../src/adapters/render/presenter';
import {
  CHIP_MOTION,
  chipScale,
  WidgetChipsPresenter,
} from '../../src/adapters/render/widgets/chips';
import { timer } from '../../src/adapters/render/widgets/fixtures';
import { fakeText } from '../../src/adapters/render/widgets/text-port';
import { WIDGET_THEME } from '../../src/adapters/render/widgets/theme';
import type { Widget, WidgetSnapshot } from '../../src/domain/widgets/types';
import type { ObjectEstimate } from '../../src/domain/world/object-registry';

// A timer's chip beside its lesson object: it shows only while the object is placed, not lost and
// not held (300 ms either way), sits to the object's right as the eye sees it, faces the eye, and
// grows a little with distance.

const T = 1000;
const EYE: [number, number, number] = [0, 1.6, 0];

function estimate(over: Partial<ObjectEstimate> = {}): ObjectEstimate {
  return {
    id: 'cup_a',
    spec: { id: 'cup_a', label: 'Cup A', radius: 0.04 } as ObjectSpec,
    position: [0, 0.9, -0.6],
    orientation: null,
    confidence: 1,
    source: 'layout',
    t: 0,
    heldBy: null,
    ...over,
  };
}

function context(t: number, objects: ObjectEstimate[], dt = 16): PresentContext {
  return {
    t,
    dt,
    snapshot: {} as PresentContext['snapshot'],
    procedure: null,
    objects,
    demo: null,
    demoHands: null,
    hands: null,
    head: { p: EYE, q: [0, 0, 0, 1] },
    worldFromWorkspace: { p: [0, 0, 0], q: [0, 0, 0, 1] },
    calibration: null,
    debug: false,
  };
}

function setup(widgets: Widget[]) {
  const snap: WidgetSnapshot = { rev: 1, widgets };
  const chips = new WidgetChipsPresenter({ source: () => snap, text: fakeText });
  const chip = (): Object3D | undefined => chips.object.children[0];
  return { chips, chip };
}

/** Runs frames every 50 ms from `from` for `ms`. */
function run(chips: WidgetChipsPresenter, from: number, ms: number, objects: ObjectEstimate[]) {
  for (let t = from; t <= from + ms; t += 50) chips.update(context(t, objects, 50));
}

describe('WidgetChipsPresenter', () => {
  it('shows a chip for a timer about a placed object after 300 ms', () => {
    const { chips, chip } = setup([timer(T, { objectId: 'cup_a' })]);
    const objects = [estimate()];
    chips.update(context(T, objects));
    expect(chip()?.visible).toBe(false);
    run(chips, T + 50, 200, objects);
    expect(chip()?.visible).toBe(false);
    run(chips, T + 300, 300, objects);
    expect(chip()?.visible).toBe(true);
  });

  it('draws no chip for a timer without an object', () => {
    const { chips } = setup([timer(T)]);
    chips.update(context(T, [estimate()]));
    expect(chips.count).toBe(0);
  });

  it('hides when the object is lost, held or missing, after 300 ms', () => {
    for (const gone of [
      [estimate({ lostAt: T })],
      [estimate({ heldBy: 'right' })],
      [] as ObjectEstimate[],
    ]) {
      const { chips, chip } = setup([timer(T, { objectId: 'cup_a' })]);
      run(chips, T, 600, [estimate()]);
      expect(chip()?.visible).toBe(true);
      run(chips, T + 650, 200, gone);
      expect(chip()?.visible).toBe(true);
      run(chips, T + 900, CHIP_MOTION.presentMs + CHIP_MOTION.fadeOutMs, gone);
      expect(chip()?.visible).toBe(false);
    }
  });

  it('sits beside the object, to its right as the eye sees it, and faces the eye', () => {
    const { chips, chip } = setup([timer(T, { objectId: 'cup_a' })]);
    run(chips, T, 600, [estimate()]);
    const c = chip() as Object3D;
    const p = c.position;
    // The eye looks down -z, so its right is +x: radius 0.04 + 3 cm clear, 1 cm up.
    expect(p.x).toBeCloseTo(0.07, 6);
    expect(p.y).toBeCloseTo(0.91, 6);
    expect(p.z).toBeCloseTo(-0.6, 6);
    const forward = new Vector3(0, 0, 1).applyQuaternion(c.quaternion);
    const toEye = new Vector3(...EYE).sub(p).normalize();
    expect(forward.dot(toEye)).toBeCloseTo(1, 6);
    // No roll: its x axis stays horizontal.
    expect(new Vector3(1, 0, 0).applyQuaternion(c.quaternion).y).toBeCloseTo(0, 6);
  });

  it('keeps the offset to the right for an object off to the side', () => {
    const { chips, chip } = setup([timer(T, { objectId: 'cup_a' })]);
    run(chips, T, 600, [estimate({ position: [0.6, 1.6, 0] })]);
    const p = chip()?.position ?? new Vector3();
    // Looking along +x, the eye's right is +z.
    expect(p.x).toBeCloseTo(0.6, 6);
    expect(p.z).toBeCloseTo(0.07, 6);
  });

  it('stacks two timers about one object, the older on top, never one over the other', () => {
    let snap: WidgetSnapshot = {
      rev: 1,
      widgets: [
        timer(T, { objectId: 'cup_a' }),
        timer(T, { id: 'timer-2', seq: 9, label: 'Paint', objectId: 'cup_a' }),
      ],
    };
    const chips = new WidgetChipsPresenter({ source: () => snap, text: fakeText });
    run(chips, T, 600, [estimate()]);
    const [first, second] = chips.object.children as Object3D[];
    expect(first?.position.y).toBeCloseTo(0.91, 6);
    // One chip's height and a gap lower, at the chip's scale; beside the object as the first is.
    const pitch = (WIDGET_THEME.size.chipHeight + WIDGET_THEME.size.gap) * (first?.scale.x ?? 1);
    expect(second?.position.y).toBeCloseTo(0.91 - pitch, 3);
    expect(second?.position.x).toBeCloseTo(first?.position.x ?? 0, 3);
    // The first timer closes: once its chip has faded, the other moves up into its place.
    snap = { rev: 2, widgets: [snap.widgets[1] as Widget] };
    chips.update(context(T + 650, [estimate()], 50));
    expect(second?.position.y).toBeCloseTo(0.91 - pitch, 3);
    run(chips, T + 700, 1500, [estimate()]);
    expect(chips.count).toBe(1);
    expect(second?.position.y).toBeCloseTo(0.91, 3);
  });

  it('clamps its scale between 0.8 and 1.6 of its size at 0.65 m', () => {
    expect(chipScale(0.65)).toBe(1);
    expect(chipScale(0.3)).toBe(0.8);
    expect(chipScale(1.3)).toBe(1.6);
    expect(chipScale(0.8)).toBeCloseTo(0.8 / 0.65, 9);
    const { chips, chip } = setup([timer(T, { objectId: 'cup_a' })]);
    run(chips, T, 600, [estimate({ position: [0, 1.6, -2] })]);
    expect(chip()?.scale.x).toBe(1.6);
  });

  it('hides during calibration', () => {
    const { chips } = setup([timer(T, { objectId: 'cup_a' })]);
    run(chips, T, 600, [estimate()]);
    chips.update({ ...context(T + 700, [estimate()]), calibration: {} as never });
    expect(chips.object.visible).toBe(false);
  });

  it('drops a chip whose timer closed during calibration, never flashing it back', () => {
    let snap: WidgetSnapshot = { rev: 1, widgets: [timer(T, { objectId: 'cup_a' })] };
    const chips = new WidgetChipsPresenter({ source: () => snap, text: fakeText });
    run(chips, T, 600, [estimate()]);
    const chip = chips.object.children[0];
    expect(chip?.visible).toBe(true);
    chips.update({ ...context(T + 700, [estimate()]), calibration: {} as never });
    snap = { rev: 2, widgets: [] };
    chips.update(context(T + 9000, [estimate()]));
    expect(chips.count).toBe(0);
    expect(chip?.parent).toBeNull();
  });

  it('still fades out a chip the learner saw when its timer closes', () => {
    let snap: WidgetSnapshot = { rev: 1, widgets: [timer(T, { objectId: 'cup_a' })] };
    const chips = new WidgetChipsPresenter({ source: () => snap, text: fakeText });
    run(chips, T, 600, [estimate()]);
    snap = { rev: 2, widgets: [] };
    chips.update(context(T + 650, [estimate()]));
    expect(chips.object.children[0]?.visible).toBe(true);
    run(chips, T + 700, CHIP_MOTION.fadeOutMs, [estimate()]);
    expect(chips.count).toBe(0);
  });
});

// The presenter pulls in troika text, whose typings live with the source (tsconfig.node.json
// covers only test/), so point the typecheck at them.
/// <reference path="../../src/adapters/render/troika.d.ts" />
import { type Group, type Mesh, type MeshBasicMaterial, Object3D } from 'three';
import { describe, expect, it, vi } from 'vitest';

// troika's SDF text needs a browser; a plain object stands in for each line of text.
vi.mock('../../src/adapters/render/text', () => ({
  makeText: () => Object.assign(new Object3D(), { text: '', color: 0, clipRect: null, sync() {} }),
  setText: (t: { text: string }, value: string) => {
    t.text = value;
  },
}));

import type { PresentContext } from '../../src/adapters/render/presenter';
import {
  InstructionPanelPresenter,
  stepHeader,
} from '../../src/adapters/render/presenters/instruction-panel';
import type { OverlaySnapshot } from '../../src/domain/overlay/overlay-model';

const LONG_TITLE = 'Test an acid and a base with red-cabbage indicator';

describe('instruction panel header', () => {
  it('shows the lesson and the step count, separated by spaces only', () => {
    expect(stepHeader('Refill', 0, 3)).toBe('REFILL   STEP 1 OF 3');
    expect(stepHeader(null, 1, 2)).toBe('LESSON   STEP 2 OF 2');
  });

  it('never counts past the last step', () => {
    expect(stepHeader('Refill', 3, 3)).toBe('REFILL   STEP 3 OF 3');
  });

  it('uses no bullet or middle-dot separators', () => {
    expect(stepHeader('Refill', 0, 3)).not.toMatch(/[·•]/);
  });

  it('cuts the title after a whole word to fit, and keeps the step count', () => {
    expect(stepHeader(LONG_TITLE, 9, 12, 34)).toBe('TEST AN ACID AND…   STEP 10 OF 12');
    expect(stepHeader('Refill washer fluid', 0, 4, 34)).toBe('REFILL WASHER FLUID   STEP 1 OF 4');
    expect(stepHeader('X'.repeat(40), 0, 4, 20)).toBe(`${'X'.repeat(5)}…   STEP 1 OF 4`);
  });
});

type Line = Object3D & { text: string; color: number; clipRect: number[] | null };

function snapshot(over: Partial<OverlaySnapshot> = {}): OverlaySnapshot {
  return {
    phase: 'lesson',
    title: 'Refill',
    instruction: { text: 'Open the cap.', index: 0, total: 3, progress: 0 },
    highlights: [],
    outlines: [],
    toast: null,
    demoStepId: null,
    caption: null,
    coach: 'ready',
    voice: 'quiet',
    recording: null,
    missing: [],
    ...over,
  };
}

function context(s: OverlaySnapshot, t = 0): PresentContext {
  return {
    t,
    dt: 16,
    snapshot: s,
    procedure: null,
    objects: [],
    demo: null,
    demoHands: null,
    hands: null,
    head: { p: [0, 1.6, 0], q: [0, 0, 0, 1] },
    worldFromWorkspace: { p: [0, 0, 0], q: [0, 0, 0, 1] },
    calibration: null,
    debug: false,
  };
}

/** The panel's parts in the order it adds them, and the mark's: lamp, ring, arc, three bars. */
function parts(panel: InstructionPanelPresenter) {
  const children = panel.object.children;
  const mark = children[8] as Group;
  const [lamp, ring, arc, ...bars] = mark.children as Mesh[];
  return {
    header: children[1] as Line,
    label: children[7] as Line,
    mark,
    lamp: lamp as Mesh,
    ring: ring as Mesh,
    arc: arc as Mesh,
    bars,
  };
}

const hex = (mesh: Mesh) => (mesh.material as MeshBasicMaterial).color.getHex();

describe('InstructionPanelPresenter coach status', () => {
  it('shows a mark and a word at the right of the header row', () => {
    const panel = new InstructionPanelPresenter(() => {});
    panel.update(context(snapshot()));
    const { label, mark, header } = parts(panel);
    expect(label.visible).toBe(true);
    expect(label.text).toBe('Listening');
    expect(mark.visible).toBe(true);
    expect(label.position.y).toBe(header.position.y);
    expect(label.position.x).toBeLessThan(mark.position.x);
    expect(mark.position.x).toBeGreaterThan(header.position.x);
  });

  it('hides it for a coach that cannot hear, and without a coach', () => {
    const panel = new InstructionPanelPresenter(() => {});
    for (const over of [{ voice: 'off' }, { coach: 'off', voice: 'off' }] as const) {
      panel.update(context(snapshot()));
      panel.update(context(snapshot(over)));
      const { label, mark } = parts(panel);
      expect(label.visible).toBe(false);
      expect(mark.visible).toBe(false);
    }
  });

  it('moves nothing else: a long title gives way beside the mark and is whole without it', () => {
    const panel = new InstructionPanelPresenter(() => {});
    const long = {
      title: LONG_TITLE,
      instruction: { text: 'Add vinegar.', index: 9, total: 12, progress: 0 },
    };
    panel.update(context(snapshot({ ...long, voice: 'off' })));
    const { header } = parts(panel);
    const at = header.position.clone();
    expect(header.text).toBe(`${LONG_TITLE.toUpperCase()}   STEP 10 OF 12`);
    expect(header.clipRect).toBeNull();
    panel.update(context(snapshot(long)));
    expect(header.text).toBe('TEST AN ACID AND…   STEP 10 OF 12');
    expect(header.clipRect).not.toBeNull();
    expect(header.position).toEqual(at);
  });

  it('draws each state with its own mark, in solid opaque colors', () => {
    const panel = new InstructionPanelPresenter(() => {});
    const { lamp, ring, arc, bars, label } = parts(panel);
    const shown = () =>
      [lamp.visible && 'lamp', ring.visible && 'ring', arc.visible && 'arc'].filter(Boolean);
    const cases: [Partial<OverlaySnapshot>, string[], string][] = [
      [{}, ['lamp', 'ring'], 'Listening'],
      [{ voice: 'hearing' }, ['lamp', 'ring'], 'Listening'],
      [{ voice: 'speaking' }, [], 'Speaking'],
      [{ phase: 'planning', instruction: null }, ['arc'], 'Planning'],
      [{ coach: 'reconnecting' }, ['lamp'], 'Connecting'],
      [{ coach: 'error' }, ['lamp'], 'Voice offline'],
    ];
    for (const [over, marks, word] of cases) {
      panel.update(context(snapshot(over)));
      expect(shown()).toEqual(marks);
      expect(bars.every((b) => b.visible)).toBe(word === 'Speaking');
      expect(label.text).toBe(word);
    }
    // Still red, the word too: the voice is gone.
    expect(hex(lamp)).toBe(0xff6b78);
    expect(label.color).toBe(0xff6b78);
    for (const mesh of [lamp, ring, arc, ...bars]) {
      const material = mesh.material as MeshBasicMaterial;
      expect(material.transparent).toBe(false);
      expect(material.opacity).toBe(1);
    }
  });

  it('animates from the frame time, and keeps offline still', () => {
    const panel = new InstructionPanelPresenter(() => {});
    const { lamp, ring, arc, bars } = parts(panel);
    const at = (over: Partial<OverlaySnapshot>, t: number) => {
      panel.update(context(snapshot(over), t));
      return {
        ring: ring.scale.x,
        arc: arc.rotation.z,
        bars: bars.map((b) => b.scale.y),
        lamp: hex(lamp),
      };
    };
    // The listening ring breathes over 3.6 s, like the glow.
    expect(at({}, 0).ring).not.toBeCloseTo(at({}, 900).ring, 3);
    expect(at({ voice: 'speaking' }, 0).bars).not.toEqual(at({ voice: 'speaking' }, 120).bars);
    const planning = { phase: 'planning', instruction: null } as const;
    expect(at(planning, 0).arc).not.toBeCloseTo(at(planning, 300).arc, 3);
    expect(at({ coach: 'connecting' }, 0).lamp).not.toBe(at({ coach: 'connecting' }, 250).lamp);
    expect(at({ coach: 'closed' }, 0)).toEqual(at({ coach: 'closed' }, 777));
  });
});

// The presenter pulls in troika text, whose typings live with the source (tsconfig.node.json
// covers only test/), so point the typecheck at them.
/// <reference path="../../src/adapters/render/troika.d.ts" />
import { type Group, type Mesh, type MeshBasicMaterial, Object3D, type PlaneGeometry } from 'three';
import { describe, expect, it, vi } from 'vitest';
import type { TextOptions } from '../../src/adapters/render/text';

type Bounds = [number, number, number, number];

// troika's SDF text needs a browser; a plain object stands in for each line of text. Like troika it
// lays out asynchronously: sync() queues the layout and flush() finishes every queued one.
const text = vi.hoisted(() => {
  const pending: (() => void)[] = [];
  /** Roughly troika's layout of Inter: 0.55 em a character, wrapped at spaces, 1.21 em a line. */
  function bounds(
    value: string,
    size: number,
    maxWidth: number,
    anchorX: string,
    anchorY: string,
  ): Bounds {
    const em = 0.55 * size;
    const lines: string[] = [];
    for (const word of value ? value.split(' ') : []) {
      const last = lines.at(-1);
      if (last !== undefined && (last.length + 1 + word.length) * em <= maxWidth) {
        lines[lines.length - 1] = `${last} ${word}`;
      } else lines.push(word);
    }
    const w = Math.max(0, ...lines.map((l) => l.length * em));
    const h = lines.length * 1.21 * size;
    const x = anchorX === 'right' ? -w : anchorX === 'center' ? -w / 2 : 0;
    const y = anchorY === 'bottom' ? h : anchorY === 'middle' ? h / 2 : 0;
    return [x, y - h, x + w, y];
  }
  return {
    pending,
    bounds,
    flush() {
      while (pending.length) pending.shift()?.();
    },
  };
});

vi.mock('../../src/adapters/render/text', () => ({
  makeText: ({
    size,
    maxWidth = Number.POSITIVE_INFINITY,
    anchorX = 'left',
    anchorY = 'top',
  }: TextOptions) => {
    const t = Object.assign(new Object3D(), {
      text: '',
      color: 0,
      clipRect: null,
      fontSize: size,
      maxWidth,
      textRenderInfo: null as { blockBounds: Bounds } | null,
      sync() {
        text.pending.push(() => {
          const b = text.bounds(t.text, t.fontSize, t.maxWidth, String(anchorX), String(anchorY));
          t.textRenderInfo = { blockBounds: b };
          t.dispatchEvent({ type: 'synccomplete' } as never);
        });
      },
    });
    return t;
  },
  setText: (t: { text: string; sync(): void }, value: string) => {
    if (t.text !== value) {
      t.text = value;
      t.sync();
    }
  },
}));

import type { PresentContext } from '../../src/adapters/render/presenter';
import {
  InstructionPanelPresenter,
  PANEL_TOP,
  PANEL_WIDTH,
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

type Line = Object3D & {
  text: string;
  color: number;
  clipRect: number[] | null;
  maxWidth: number;
  textRenderInfo: { blockBounds: Bounds } | null;
};

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

function context(
  s: OverlaySnapshot,
  t = 0,
  calibration: PresentContext['calibration'] = null,
): PresentContext {
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
    calibration,
    debug: false,
  };
}

/** The panel's parts in the order it adds them, and the mark's: lamp, ring, arc, three bars. */
function parts(panel: InstructionPanelPresenter) {
  const children = panel.object.children;
  const mark = children[8] as Group;
  const [lamp, ring, arc, ...bars] = mark.children as Mesh[];
  const button = children[6] as Group;
  return {
    background: children[0] as Mesh,
    header: children[1] as Line,
    instruction: children[2] as Line,
    detail: children[3] as Line,
    status: children[4] as Line,
    bar: children[5] as Mesh,
    button,
    buttonBg: button.children[0] as Mesh,
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

  it('cuts a long title the same with or without the mark, and moves nothing', () => {
    const panel = new InstructionPanelPresenter(() => {});
    const long = {
      title: LONG_TITLE,
      instruction: { text: 'Add vinegar.', index: 9, total: 12, progress: 0 },
    };
    const { header, label } = parts(panel);
    panel.update(context(snapshot({ ...long, voice: 'off' })));
    text.flush();
    const at = header.position.clone();
    const clipRect = header.clipRect;
    expect(header.text).toBe('TEST AN ACID AND…   STEP 10 OF 12');
    expect(clipRect).not.toBeNull();
    // Without the mark the header still ends well inside the panel.
    expect(extent(header).right).toBeLessThan(PANEL_WIDTH / 2 - 0.02);

    panel.update(context(snapshot(long)));
    text.flush();
    expect(header.text).toBe('TEST AN ACID AND…   STEP 10 OF 12');
    expect(header.clipRect).toEqual(clipRect);
    expect(header.position).toEqual(at);
    expect(extent(header).right).toBeLessThan(extent(label).left);
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

const LONG_STEP = {
  text: 'Fill the syringe with purple indicator from the indicator bottle.',
  detail: 'Your left hand keeps holding the shoulder fabric and brings it to the hem.',
  index: 0,
  total: 5,
  progress: 0.7,
};

/** Where a text block or the panel sits, in the panel's plane. */
function extent(t: Line) {
  const [x0, y0, x1, y1] = t.textRenderInfo?.blockBounds ?? [0, 0, 0, 0];
  const { x, y } = t.position;
  return { left: x + x0, right: x + x1, top: y + y1, bottom: y + y0, empty: y1 - y0 === 0 };
}

function panelBox(panel: InstructionPanelPresenter) {
  const { background } = parts(panel);
  const top = background.position.y + background.scale.y / 2;
  return { top, bottom: top - background.scale.y, height: background.scale.y };
}

function buttonBox(panel: InstructionPanelPresenter) {
  const { button, buttonBg } = parts(panel);
  const { width, height } = (buttonBg.geometry as PlaneGeometry).parameters;
  const { x, y } = button.position;
  return { left: x - width / 2, right: x + width / 2, top: y + height / 2, bottom: y - height / 2 };
}

describe('InstructionPanelPresenter layout', () => {
  const cases: [string, Partial<OverlaySnapshot>, PresentContext['calibration']?][] = [
    [
      'a three-line step, a long detail and a coach caption',
      {
        instruction: LONG_STEP,
        voice: 'speaking',
        caption: {
          role: 'coach',
          text: 'Dip the syringe tip into the bottle and pull the plunger back.',
        },
      },
    ],
    ['objects missing', { instruction: LONG_STEP, missing: ['indicator', 'syringe', 'cup A'] }],
    [
      'a long mistake',
      {
        instruction: { ...LONG_STEP, detail: undefined },
        toast: {
          kind: 'mistake',
          text: "That's cup B. Vinegar goes in cup A, the one on the left.",
        },
      },
    ],
    ['a long title, no mark', { title: LONG_TITLE, coach: 'off', instruction: LONG_STEP }],
    [
      'the learner talking, no button',
      {
        phase: 'idle',
        instruction: null,
        caption: {
          role: 'user',
          text: 'I want to test an acid and a base with cabbage juice, please.',
        },
      },
    ],
    [
      'a calibration error',
      { phase: 'idle', instruction: null, coach: 'off' },
      {
        step: 'second',
        text: 'Now pinch the near-right corner of your work area.',
        error: 'Calibration corners are too close together (need at least 10 cm)',
        firstCorner: [0, 0.75, -0.4],
      },
    ],
  ];

  for (const [name, over, calibration] of cases) {
    it(`stacks ${name} without overlap, inside a panel grown down from its top`, () => {
      const panel = new InstructionPanelPresenter(() => {});
      panel.update(context(snapshot(over), 0, calibration ?? null));
      text.flush();
      const { header, instruction, detail, status, bar, button } = parts(panel);
      const box = panelBox(panel);
      expect(box.top).toBeCloseTo(PANEL_TOP, 9);
      expect(box.height).toBeGreaterThanOrEqual(0.17);
      expect(panel.panelHeight).toBeCloseTo(box.height, 9);

      const blocks = [header, instruction, detail, status].map(extent).filter((b) => !b.empty);
      for (let i = 1; i < blocks.length; i++) {
        expect(blocks[i - 1]?.bottom).toBeGreaterThan((blocks[i]?.top ?? 0) + 0.004);
      }
      for (const b of blocks) {
        expect(b.top).toBeLessThan(box.top - 0.01);
        expect(b.bottom).toBeGreaterThan(box.bottom + 0.01);
        expect(b.left).toBeGreaterThanOrEqual(-PANEL_WIDTH / 2 + 0.02);
        expect(b.right).toBeLessThanOrEqual(PANEL_WIDTH / 2 - 0.02);
      }

      expect(button.visible).toBe(over.instruction !== null);
      if (button.visible) {
        const done = buttonBox(panel);
        const above = extent(detail).empty ? extent(instruction) : extent(detail);
        expect(done.top).toBeLessThan(above.bottom);
        expect(done.bottom).toBeGreaterThan(box.bottom);
        expect(done.right).toBeLessThan(PANEL_WIDTH / 2);
        if (status.text) expect(extent(status).right).toBeLessThan(done.left);
      }
      // The progress bar runs along the bottom edge.
      expect(bar.position.y).toBeGreaterThan(box.bottom);
      expect(bar.position.y).toBeLessThan(box.bottom + 0.01);
    });
  }

  it('keeps the least height for short text, the status line centred on the button', () => {
    const panel = new InstructionPanelPresenter(() => {});
    panel.update(context(snapshot({ toast: { kind: 'success', text: 'Nice!' } })));
    text.flush();
    const { status } = parts(panel);
    expect(panelBox(panel).height).toBeCloseTo(0.17, 9);
    const done = buttonBox(panel);
    const line = extent(status);
    expect((line.top + line.bottom) / 2).toBeCloseTo((done.top + done.bottom) / 2, 9);
  });

  it('lays out again when text finishes laying out, with no new frame', () => {
    const panel = new InstructionPanelPresenter(() => {});
    const { instruction, detail } = parts(panel);
    const step = { ...LONG_STEP, text: 'Open the cap.' };
    panel.update(context(snapshot({ instruction: step })));
    text.flush();
    const before = { detail: detail.position.y, height: panelBox(panel).height };
    panel.update(context(snapshot({ instruction: LONG_STEP })));
    // troika still shows the old text, so the old layout stays until the new one is measured.
    expect(detail.position.y).toBe(before.detail);
    text.flush();
    expect(detail.position.y).toBeLessThan(before.detail);
    expect(extent(instruction).bottom).toBeGreaterThan(extent(detail).top);
    expect(panelBox(panel).height).toBeGreaterThan(before.height);
  });

  it('wraps the status line short of the Done button, and across the panel without it', () => {
    const panel = new InstructionPanelPresenter(() => {});
    const { status } = parts(panel);
    panel.update(context(snapshot({ missing: ['indicator', 'syringe'] })));
    text.flush();
    const beside = status.maxWidth;
    expect(status.position.x + beside).toBeLessThan(buttonBox(panel).left);

    const caption = { role: 'user', text: 'I want to test an acid and a base.' } as const;
    panel.update(context(snapshot({ phase: 'idle', instruction: null, caption })));
    text.flush();
    expect(status.maxWidth).toBeGreaterThan(beside);
    expect(status.position.x + status.maxWidth).toBeLessThanOrEqual(PANEL_WIDTH / 2 - 0.02);
  });

  it('says the lesson is complete once, and still shows other toasts', () => {
    const panel = new InstructionPanelPresenter(() => {});
    const { instruction, status } = parts(panel);
    const toast = { kind: 'success', text: 'Lesson complete!' } as const;
    panel.update(context(snapshot({ phase: 'done', instruction: null, toast })));
    expect(instruction.text).toBe('Lesson complete!');
    expect(status.text).toBe('');
    panel.update(context(snapshot({ toast: { kind: 'success', text: 'Nice!' } })));
    expect(status.text).toBe('Nice!');
  });

  it('draws the panel and the Done button solid and opaque, in their colors', () => {
    const panel = new InstructionPanelPresenter(() => {});
    panel.update(context(snapshot()));
    const { background, buttonBg } = parts(panel);
    for (const [mesh, color] of [
      [background, 0x0b1220],
      [buttonBg, 0x2a7d5a],
    ] as const) {
      const material = mesh.material as MeshBasicMaterial;
      expect(material.transparent).toBe(false);
      expect(material.opacity).toBe(1);
      expect(material.color.getHex()).toBe(color);
    }
  });
});

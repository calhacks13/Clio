// The presenter pulls in troika text, whose typings live with the source (tsconfig.node.json
// covers only test/), so point the typecheck at them.
/// <reference path="../../src/adapters/render/troika.d.ts" />
import { HAND_SAMPLE_LENGTH, jointOffset } from '@clio/protocol';
import { type Group, type Mesh, type MeshBasicMaterial, Object3D, Vector3 } from 'three';
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
    breakWords = false,
  ): Bounds {
    const measure = (line: string) =>
      [...line].reduce(
        (sum, character) =>
          sum + size * ('ilI'.includes(character) ? 0.25 : 'WM'.includes(character) ? 0.9 : 0.55),
        0,
      );
    const lines: string[] = [];
    const words: string[] = [];
    for (const word of value ? value.split(' ') : []) {
      if (!breakWords || measure(word) <= maxWidth) words.push(word);
      else {
        let part = '';
        for (const character of word) {
          if (part && measure(part + character) > maxWidth) {
            words.push(part);
            part = '';
          }
          part += character;
        }
        if (part) words.push(part);
      }
    }
    for (const word of words) {
      const last = lines.at(-1);
      if (last !== undefined && measure(`${last} ${word}`) <= maxWidth) {
        lines[lines.length - 1] = `${last} ${word}`;
      } else lines.push(word);
    }
    const w = Math.max(0, ...lines.map(measure));
    const h = lines.length * 1.21 * size;
    const x = anchorX === 'right' ? -w : anchorX === 'center' ? -w / 2 : 0;
    const y = anchorY === 'bottom' ? h : anchorY === 'middle' ? h / 2 : 0;
    return [x, y - h, x + w, y];
  }
  return {
    pending,
    bounds,
    flush() {
      let steps = 0;
      while (pending.length) {
        if (++steps > 1000) throw new Error('Text layout did not settle');
        pending.shift()?.();
      }
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
      overflowWrap: 'normal',
      textRenderInfo: null as {
        blockBounds: Bounds;
        parameters: { text: string; maxWidth: number; fontSize: number };
      } | null,
      sync() {
        const parameters = { text: t.text, fontSize: t.fontSize, maxWidth: t.maxWidth };
        const breakWords = t.overflowWrap === 'break-word';
        text.pending.push(() => {
          const b = text.bounds(
            parameters.text,
            parameters.fontSize,
            parameters.maxWidth,
            String(anchorX),
            String(anchorY),
            breakWords,
          );
          t.textRenderInfo = { blockBounds: b, parameters };
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

import * as panelPlacement from '../../src/adapters/render/panel-placement';
import type { PresentContext } from '../../src/adapters/render/presenter';
import { CLOSE_D, STRIP_H } from '../../src/adapters/render/presenters/card-controls';
import {
  InstructionPanelPresenter,
  PANEL_TOP,
  stepHeader,
} from '../../src/adapters/render/presenters/instruction-panel';
import { invertPose, transformPoint } from '../../src/core/math';
import type { OverlaySnapshot } from '../../src/domain/overlay/overlay-model';

type Line = Object3D & {
  text: string;
  color: number;
  outlineWidth: number;
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

function update(panel: InstructionPanelPresenter, ctx: PresentContext): void {
  panel.update(ctx);
  text.flush();
}

function parts(panel: InstructionPanelPresenter) {
  const children = panel.object.children;
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
    strip: children[7] as Group,
    close: children[8] as Group,
  };
}

function extent(t: Line) {
  const [x0, y0, x1, y1] = t.textRenderInfo?.blockBounds ?? [0, 0, 0, 0];
  const { x, y } = t.position;
  return { left: x + x0, right: x + x1, top: y + y1, bottom: y + y0, empty: y1 - y0 === 0 };
}

function meshBox(mesh: Mesh) {
  mesh.geometry.computeBoundingBox();
  const bounds = mesh.geometry.boundingBox;
  if (!bounds) throw new Error('No geometry bounds');
  return {
    left: mesh.position.x + bounds.min.x,
    right: mesh.position.x + bounds.max.x,
    top: mesh.position.y + bounds.max.y,
    bottom: mesh.position.y + bounds.min.y,
    height: bounds.max.y - bounds.min.y,
    width: bounds.max.x - bounds.min.x,
  };
}

function buttonBox(panel: InstructionPanelPresenter) {
  const { button, buttonBg } = parts(panel);
  const box = meshBox(buttonBg);
  return {
    left: box.left + button.position.x,
    right: box.right + button.position.x,
    top: box.top + button.position.y,
    bottom: box.bottom + button.position.y,
  };
}

describe('InstructionPanelPresenter minimal content', () => {
  it('shows only the step count above the instruction, regardless of lesson title', () => {
    expect(stepHeader(0, 3)).toBe('Step 1 of 3');
    expect(stepHeader(3, 3)).toBe('Step 3 of 3');
    const panel = new InstructionPanelPresenter(() => {});
    update(panel, context(snapshot({ title: 'A very long repeated lesson title' })));
    expect(parts(panel).header.text).toBe('Step 1 of 3');
  });

  it('has no listening label or duplicate conversational caption', () => {
    const panel = new InstructionPanelPresenter(() => {});
    for (const voice of ['quiet', 'hearing', 'thinking', 'speaking'] as const) {
      update(
        panel,
        context(snapshot({ voice, caption: { role: 'coach', text: 'Open the cap.' } })),
      );
      expect(panel.object.children).toHaveLength(9);
      expect(parts(panel).status.text).toBe('');
      expect(parts(panel).header.text).toBe('Step 1 of 3');
    }
    update(panel, context(snapshot({ phase: 'idle', instruction: null })));
    expect(parts(panel).header.text).toBe('');
    expect(parts(panel).detail.text).toBe('');
  });

  it('keeps actionable corrections, missing-object guidance and offline recovery', () => {
    const panel = new InstructionPanelPresenter(() => {});
    const { status } = parts(panel);
    update(panel, context(snapshot({ missing: ['syringe'] })));
    expect(status.text).toBe("Can't see: syringe. Pinch it to show me.");
    update(panel, context(snapshot({ coach: 'error' })));
    expect(status.text).toBe('Voice offline. Use Done to continue.');
    update(panel, context(snapshot({ toast: { kind: 'mistake', text: 'Use cup A.' } })));
    expect(status.text).toBe('Use cup A.');
    update(panel, context(snapshot({ toast: { kind: 'success', text: 'Nice!' } })));
    expect(status.text).toBe('');
  });

  it('says completion once without a title or success toast', () => {
    const panel = new InstructionPanelPresenter(() => {});
    update(
      panel,
      context(
        snapshot({
          phase: 'done',
          instruction: null,
          toast: { kind: 'success', text: 'Lesson complete!' },
        }),
      ),
    );
    const { header, instruction, status, button } = parts(panel);
    expect(instruction.text).toBe('Lesson complete!');
    expect(header.text).toBe('');
    expect(status.text).toBe('');
    expect(button.visible).toBe(false);
  });
});

const LONG_STEP = {
  text: 'Fill the syringe with purple indicator from the indicator bottle.',
  detail: 'Your left hand keeps holding the shoulder fabric and brings it to the hem.',
  index: 0,
  total: 5,
  progress: 0.7,
};

describe('InstructionPanelPresenter layout', () => {
  it('waits for its first measured content before showing the card', () => {
    const panel = new InstructionPanelPresenter(() => {});
    expect(panel.object.visible).toBe(false);
    panel.update(context(snapshot()));
    expect(panel.object.visible).toBe(false);
    text.pending.shift()?.();
    expect(panel.object.visible).toBe(false);
    text.flush();
    expect(panel.object.visible).toBe(true);
  });

  const cases: [string, Partial<OverlaySnapshot>, PresentContext['calibration']?][] = [
    ['long instruction and detail', { instruction: LONG_STEP }],
    ['objects missing', { instruction: LONG_STEP, missing: ['indicator', 'syringe', 'cup A'] }],
    [
      'long correction',
      {
        instruction: LONG_STEP,
        toast: {
          kind: 'mistake',
          text: "That's cup B. Vinegar goes in cup A, the one on the left.",
        },
      },
    ],
    ['voice offline', { instruction: LONG_STEP, coach: 'error' }],
    ['idle', { phase: 'idle', instruction: null }],
    [
      'calibration error',
      { phase: 'idle', instruction: null },
      {
        step: 'second',
        text: 'Now pinch the near-right corner of your work area.',
        error: 'Calibration corners are too close together (need at least 10 cm)',
        firstCorner: [0, 0.75, -0.4],
      },
    ],
  ];

  for (const [name, over, calibration] of cases) {
    it(`fits ${name} without text or button overlap`, () => {
      const panel = new InstructionPanelPresenter(
        () => {},
        () => {},
      );
      update(panel, context(snapshot({ voice: 'speaking', ...over }), 0, calibration ?? null));
      text.flush();
      const { header, instruction, detail, status, background, button, bar, strip, close } =
        parts(panel);
      const box = meshBox(background);
      expect(box.top).toBeCloseTo(PANEL_TOP, 6);
      expect(box.height).toBeGreaterThan(0.04);
      expect(panel.panelWidth).toBeCloseTo(box.width, 6);
      expect(panel.panelHeight).toBeCloseTo(box.height, 6);
      const blocks = [header, instruction, detail, status].map(extent).filter((b) => !b.empty);
      for (let i = 1; i < blocks.length; i++) {
        expect(blocks[i - 1]?.bottom).toBeGreaterThan((blocks[i]?.top ?? 0) + 0.004);
      }
      for (const b of blocks) {
        expect(b.top).toBeLessThan(box.top - 0.01);
        expect(b.bottom).toBeGreaterThan(box.bottom + 0.01);
        expect(b.left).toBeGreaterThanOrEqual(-panel.panelWidth / 2 + 0.02);
        expect(b.right).toBeLessThanOrEqual(panel.panelWidth / 2 - 0.02);
      }
      expect(button.visible).toBe(over.instruction !== null && !calibration);
      if (button.visible) {
        const done = buttonBox(panel);
        expect(done.top).toBeLessThan(blocks.at(-1)?.bottom ?? 0);
        expect(done.bottom).toBeGreaterThan(box.bottom + 0.01);
        expect(done.right).toBeLessThan(panel.panelWidth / 2 - 0.01);
      }
      expect(bar.position.y).toBeGreaterThan(box.bottom);
      expect(bar.position.y).toBeLessThan(box.bottom + 0.01);
      // The voice strip spans the top inside the padding; below it the top row holds the close
      // button in the corner, clear of the step count; the text starts below both.
      expect(strip.position.x).toBeCloseTo(0, 9);
      expect(strip.position.y + STRIP_H / 2).toBeLessThan(box.top - 0.005);
      expect(panel.voiceStrip.levels.length).toBeGreaterThan(30);
      const idle = over.phase === 'idle';
      expect(close.visible).toBe(!idle && !calibration);
      const stripBottom = strip.position.y - STRIP_H / 2;
      const head = extent(header);
      if (close.visible) {
        expect(close.position.x + CLOSE_D / 2).toBeLessThanOrEqual(panel.panelWidth / 2 - 0.02);
        expect(close.position.y + CLOSE_D / 2).toBeLessThan(stripBottom - 0.005);
        if (!head.empty) expect(head.right).toBeLessThan(close.position.x - CLOSE_D / 2);
      }
      if (!head.empty) expect(head.top).toBeLessThan(stripBottom - 0.005);
      const body = [instruction, detail, status].map(extent).find((b) => !b.empty);
      const rowBottom = Math.min(
        stripBottom,
        close.visible ? close.position.y - CLOSE_D / 2 : Infinity,
        head.empty ? Infinity : head.bottom,
      );
      if (body) expect(body.top).toBeLessThan(rowBottom);
    });
  }

  it('fits both axes to the content and shrinks again after a shorter instruction', () => {
    const panel = new InstructionPanelPresenter(() => {});
    update(panel, context(snapshot()));
    const short = { width: panel.panelWidth, height: panel.panelHeight };
    expect(short.height).toBeLessThan(short.width);
    update(panel, context(snapshot({ instruction: LONG_STEP, missing: ['indicator', 'syringe'] })));
    expect(panel.panelWidth).toBeGreaterThan(short.width);
    expect(panel.panelHeight).toBeGreaterThan(short.height);
    update(panel, context(snapshot()));
    expect(panel.panelWidth).toBeCloseTo(short.width, 6);
    expect(panel.panelHeight).toBeCloseTo(short.height, 6);
  });

  it('keeps a simple phase message on one line when its natural width fits', () => {
    const panel = new InstructionPanelPresenter(() => {});
    update(panel, context(snapshot({ phase: 'idle', instruction: null })));
    const line = parts(panel).instruction;
    expect(extent(line).top - extent(line).bottom).toBeCloseTo(0.023 * 1.21, 6);
    expect(panel.panelHeight).toBeLessThan(0.1);
    expect(panel.panelWidth).toBeCloseTo(extent(line).right - extent(line).left + 0.044, 6);
  });

  it('sizes from actual glyph metrics rather than the number of characters', () => {
    const panel = new InstructionPanelPresenter(() => {});
    const step = snapshot().instruction;
    if (!step) throw new Error('No step');
    update(
      panel,
      context(snapshot({ instruction: { ...step, text: Array(6).fill('iiiiiiii').join(' ') } })),
    );
    const narrow = panel.panelWidth;
    update(
      panel,
      context(snapshot({ instruction: { ...step, text: Array(6).fill('WWWWWWWW').join(' ') } })),
    );
    expect(panel.panelWidth).toBeGreaterThan(narrow);
  });

  it('ignores stale asynchronous measurements and settles without a resync loop', () => {
    const panel = new InstructionPanelPresenter(() => {});
    panel.update(context(snapshot({ instruction: LONG_STEP })));
    panel.update(context(snapshot()));
    text.flush();
    expect(parts(panel).instruction.text).toBe('Open the cap.');
    const size = [panel.panelWidth, panel.panelHeight];
    update(panel, context(snapshot()));
    expect([panel.panelWidth, panel.panelHeight]).toEqual(size);
    expect(text.pending).toHaveLength(0);
  });

  it('rechecks mask clearance using actual dimensions as soon as async resizing finishes', () => {
    const place = vi.spyOn(panelPlacement, 'isInstructionPanelClear');
    try {
      const panel = new InstructionPanelPresenter(() => {});
      update(panel, context(snapshot()));
      panel.update(
        context(snapshot({ instruction: LONG_STEP, missing: ['indicator', 'syringe'] })),
      );
      place.mockClear();
      text.flush();
      expect(place).toHaveBeenCalled();
      const latest = place.mock.calls.at(-1);
      expect(latest?.[1]).toBe(panel.panelWidth);
      expect(latest?.[2]).toBe(panel.panelHeight);
    } finally {
      place.mockRestore();
    }
  });

  it('reflows after async text measurement without needing a new frame', () => {
    const panel = new InstructionPanelPresenter(() => {});
    update(panel, context(snapshot({ instruction: { ...LONG_STEP, text: 'Open the cap.' } })));
    text.flush();
    const { instruction, detail } = parts(panel);
    const before = detail.position.y;
    panel.update(context(snapshot({ instruction: LONG_STEP })));
    expect(detail.position.y).toBe(before);
    text.flush();
    expect(detail.position.y).toBeLessThan(before);
    expect(extent(instruction).bottom).toBeGreaterThan(extent(detail).top);
  });

  it('uses opaque white and ink surfaces without dark text outlines', () => {
    const panel = new InstructionPanelPresenter(() => {});
    const { background, buttonBg, header, instruction, detail, status } = parts(panel);
    for (const [mesh, color] of [
      [background, 0xffffff],
      [buttonBg, 0x0f1117],
    ] as const) {
      const material = mesh.material as MeshBasicMaterial;
      // Drawn on top (on-top.ts) means the transparent render pass, with the colour still solid.
      expect(material.opacity).toBe(1);
      expect(material.color.getHex()).toBe(color);
    }
    for (const line of [header, instruction, detail, status]) expect(line.outlineWidth).toBe(0);
  });

  it('confirms a fingertip touch in workspace coordinates and prevents repeated presses', () => {
    vi.useFakeTimers();
    try {
      const onDone = vi.fn();
      const panel = new InstructionPanelPresenter(onDone);
      const ctx = context(snapshot(), 2000);
      ctx.worldFromWorkspace = { p: [1, 0.2, -0.3], q: [0, Math.SQRT1_2, 0, Math.SQRT1_2] };
      update(panel, ctx);
      text.flush();
      const center = parts(panel).button.getWorldPosition(new Object3D().position);
      const tip = transformPoint(invertPose(ctx.worldFromWorkspace), center.toArray());
      const joints = new Array<number>(HAND_SAMPLE_LENGTH).fill(0);
      const offset = jointOffset('index-finger-tip');
      joints.splice(offset, 3, ...tip);
      ctx.hands = { t: ctx.t, head: ctx.head, left: { joints, pinch: 0.03 }, right: null };
      update(panel, ctx);
      expect(onDone).toHaveBeenCalledTimes(1);
      update(panel, { ...ctx, t: 2100 });
      expect(onDone).toHaveBeenCalledTimes(1);
      update(panel, { ...ctx, t: 3600 });
      expect(onDone).toHaveBeenCalledTimes(2);
      joints[offset] = (joints[offset] ?? 0) + 0.2;
      update(panel, { ...ctx, t: 5200 });
      expect(onDone).toHaveBeenCalledTimes(2);

      // On a widget drawn over the button, a touch is the widget's: Done stays unpressed.
      joints[offset] = (joints[offset] ?? 0) - 0.2;
      const covered: number[][] = [];
      panel.coveredBy = (at) => {
        covered.push(at.toArray());
        return true;
      };
      update(panel, { ...ctx, t: 7000 });
      expect(onDone).toHaveBeenCalledTimes(2);
      expect(covered[0]?.map((v) => Number(v.toFixed(6)))).toEqual(
        center.toArray().map((v) => Number(v.toFixed(6))),
      );
      panel.coveredBy = () => false;
      update(panel, { ...ctx, t: 7100 });
      expect(onDone).toHaveBeenCalledTimes(3);
      vi.runAllTimers();
    } finally {
      vi.useRealTimers();
    }
  });
});

/** A frame with the left index fingertip at `at` (world; the test workspace is the world). */
function touch(panel: InstructionPanelPresenter, ctx: PresentContext, at: Vector3, t: number) {
  const joints = new Array<number>(HAND_SAMPLE_LENGTH).fill(0);
  joints.splice(jointOffset('index-finger-tip'), 3, ...at.toArray());
  update(panel, {
    ...ctx,
    t,
    hands: { t, head: ctx.head, left: { joints, pinch: 0.03 }, right: null },
  });
}

describe('InstructionPanelPresenter voice strip', () => {
  const color = (panel: InstructionPanelPresenter) =>
    ((parts(panel).strip.children[0] as Mesh).material as MeshBasicMaterial).color.getHex();
  /** A few frames, so the bars grow in or shrink away. */
  const frames = (panel: InstructionPanelPresenter, over: Partial<OverlaySnapshot>, t: number) => {
    for (let i = 0; i < 20; i++) update(panel, context(snapshot(over), t + i * 16));
  };

  it('moves blue while Clio speaks, yellow while the learner talks, green while it thinks', () => {
    const panel = new InstructionPanelPresenter(() => {});
    frames(panel, { voice: 'quiet' }, 0);
    expect(panel.voiceStrip.state).toBeNull();
    frames(panel, { voice: 'speaking' }, 1000);
    expect(panel.voiceStrip.state).toBe('speaking');
    expect(color(panel)).toBe(0x1768d9);
    frames(panel, { voice: 'hearing' }, 2000);
    expect(panel.voiceStrip.state).toBe('hearing');
    expect(color(panel)).toBe(0xe9a700);
    frames(panel, { voice: 'thinking' }, 3000);
    expect(panel.voiceStrip.state).toBe('thinking');
    expect(color(panel)).toBe(0x1a9e6e);
    frames(panel, { voice: 'quiet' }, 4000);
    expect(panel.voiceStrip.state).toBeNull();
    frames(panel, { voice: 'off', phase: 'planning', instruction: null }, 5000);
    expect(panel.voiceStrip.state).toBe('thinking');
    frames(panel, { voice: 'off' }, 6000);
    expect(panel.voiceStrip.state).toBeNull();
  });

  it('spans the whole top of the card and moves while speaking', () => {
    const panel = new InstructionPanelPresenter(() => {});
    const levels = (t: number) => {
      frames(panel, { voice: 'speaking' }, t);
      return [...panel.voiceStrip.levels];
    };
    const first = levels(0);
    expect(first.length * 0.0052).toBeGreaterThan(panel.panelWidth - 0.05);
    expect(Math.max(...first)).toBeLessThanOrEqual(STRIP_H + 1e-9);
    expect(levels(400)).not.toEqual(first);
  });

  it('sends a ripple across while thinking', () => {
    const panel = new InstructionPanelPresenter(() => {});
    const peak = (t: number) => {
      frames(panel, { voice: 'thinking' }, t);
      const levels = panel.voiceStrip.levels;
      return levels.indexOf(Math.max(...levels)) / levels.length;
    };
    // The crest moves rightward as time passes (within one ripple period).
    const early = peak(1000);
    const later = peak(1200);
    expect((later - early + 1) % 1).toBeGreaterThan(0);
    expect((later - early + 1) % 1).toBeLessThan(0.5);
  });

  it('keeps no room for the strip when no coach listens', () => {
    const listening = new InstructionPanelPresenter(() => {});
    const deaf = new InstructionPanelPresenter(() => {});
    update(listening, context(snapshot({ phase: 'idle', instruction: null, voice: 'quiet' })));
    update(deaf, context(snapshot({ phase: 'idle', instruction: null, voice: 'off' })));
    expect(listening.panelHeight).toBeGreaterThan(deaf.panelHeight);
  });
});

describe('InstructionPanelPresenter close button', () => {
  const closeAt = (panel: InstructionPanelPresenter) =>
    parts(panel).close.getWorldPosition(new Vector3());

  it('ends the lesson on a second touch, never on one touch or a resting finger', () => {
    const onClose = vi.fn();
    const panel = new InstructionPanelPresenter(() => {}, onClose);
    const ctx = context(snapshot());
    update(panel, ctx);
    expect(panel.closeButton).toEqual({ visible: true, armed: false });
    const at = closeAt(panel);
    const away = at.clone().add(new Vector3(0, 0, 0.2));
    touch(panel, ctx, at, 100);
    expect(panel.closeButton.armed).toBe(true);
    expect(parts(panel).header.visible).toBe(false);
    touch(panel, ctx, at, 600);
    expect(onClose).not.toHaveBeenCalled();
    touch(panel, ctx, away, 700);
    touch(panel, ctx, at, 800);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(panel.closeButton.armed).toBe(false);
    expect(parts(panel).header.visible).toBe(true);
  });

  it('forgets a first touch after three seconds', () => {
    const onClose = vi.fn();
    const panel = new InstructionPanelPresenter(() => {}, onClose);
    const ctx = context(snapshot());
    update(panel, ctx);
    const at = closeAt(panel);
    const away = at.clone().add(new Vector3(0, 0, 0.2));
    touch(panel, ctx, at, 100);
    touch(panel, ctx, away, 3200);
    expect(panel.closeButton.armed).toBe(false);
    touch(panel, ctx, at, 3300);
    expect(onClose).not.toHaveBeenCalled();
    expect(panel.closeButton.armed).toBe(true);
  });

  it('ignores a touch on a widget drawn over it', () => {
    const panel = new InstructionPanelPresenter(() => {}, vi.fn());
    const ctx = context(snapshot());
    update(panel, ctx);
    panel.coveredBy = () => true;
    touch(panel, ctx, closeAt(panel), 100);
    expect(panel.closeButton.armed).toBe(false);
  });

  it('shows at every stage of a lesson, but not when idle, calibrating or without a handler', () => {
    const panel = new InstructionPanelPresenter(() => {}, vi.fn());
    for (const phase of ['planning', 'locating', 'lesson', 'done', 'failed'] as const) {
      update(
        panel,
        context(snapshot({ phase, instruction: phase === 'lesson' ? undefined : null })),
      );
      expect(panel.closeButton.visible, phase).toBe(true);
    }
    update(panel, context(snapshot({ phase: 'idle', instruction: null })));
    expect(panel.closeButton.visible).toBe(false);
    update(
      panel,
      context(snapshot({ phase: 'idle', instruction: null }), 0, {
        step: 'first',
        text: 'Pinch the far-left corner.',
        error: null,
        firstCorner: null,
      }),
    );
    expect(panel.closeButton.visible).toBe(false);
    const without = new InstructionPanelPresenter(() => {});
    update(without, context(snapshot()));
    expect(without.closeButton.visible).toBe(false);
  });
});

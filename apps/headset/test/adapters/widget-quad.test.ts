import { Mesh, type Object3D, type ShaderMaterial } from 'three';
import { describe, expect, it } from 'vitest';
import {
  caution,
  checklist,
  choices,
  progressWidget,
  timer,
  widgetFixtures,
} from '../../src/adapters/render/widgets/fixtures';
import { FakeTextObject, fakeText } from '../../src/adapters/render/widgets/text-port';
import { LIGHT, MM, mixHex, WIDGET_THEME } from '../../src/adapters/render/widgets/theme';
import {
  type QuadUniforms,
  rgba,
  shadowMargin,
  UiQuad,
} from '../../src/adapters/render/widgets/ui-quad';
import type { Face } from '../../src/adapters/render/widgets/views/face';
import { PillFace, TimerChip } from '../../src/adapters/render/widgets/views/pill';
import { createCard } from '../../src/adapters/render/widgets/views/view';
import type { Widget } from '../../src/domain/widgets/types';

// The SDF quads: premultiplied sRGB colours, the right shape and parameters for each kind, solid
// fills with no rings or translucent tints, and a theme that stays inside the Clio design system.

const T = 1000;
const MODES = ['box', 'ring', 'check', 'segments', 'bang'] as const;

interface Quad {
  mode: (typeof MODES)[number];
  u: QuadUniforms;
  visible: boolean;
}

function quads(object: Object3D): Quad[] {
  const out: Quad[] = [];
  object.traverse((o) => {
    if (!(o instanceof Mesh)) return;
    const u = (o.material as ShaderMaterial).uniforms as unknown as QuadUniforms | undefined;
    if (!u?.uMode) return;
    out.push({ mode: MODES[u.uMode.value] ?? 'box', u, visible: o.visible });
  });
  return out;
}

function face(w: Widget, t = T, frameAt = t): Face {
  const f = createCard(w, fakeText);
  f.set(w, t);
  f.frame(frameAt, 1);
  return f;
}

const close = (actual: { toArray(): number[] }, expected: readonly number[]) => {
  const a = actual.toArray();
  expect(a).toHaveLength(expected.length);
  for (const [i, v] of expected.entries()) expect(a[i]).toBeCloseTo(v, 4);
};

describe('UiQuad', () => {
  it('never hands the shader a negative size', () => {
    const quad = new UiQuad({ mode: 'segments', width: -5.8 * MM, height: 8 * MM, radius: -1 });
    expect(quad.uniforms.uHalf.value.toArray()).toEqual([0, 4 * MM]);
    expect(quad.uniforms.uRadius.value).toBe(0);
    quad.resize(-0.01, -0.002, 4 * MM);
    expect(quad.uniforms.uHalf.value.toArray()).toEqual([0, 0]);
    expect(quad.mesh.scale.x).toBeGreaterThan(0);
    expect(quad.mesh.scale.y).toBeGreaterThan(0);
    quad.dispose();
  });
});

describe('rgba', () => {
  it('premultiplies sRGB token values by alpha', () => {
    expect(rgba(0xffffff)).toEqual([1, 1, 1, 1]);
    expect(rgba(0x0f1117)).toEqual([15 / 255, 17 / 255, 23 / 255, 1]);
    const faded = rgba(0x0e2a52, 0.1);
    expect(faded[3]).toBe(0.1);
    expect(faded[0]).toBeCloseTo((14 / 255) * 0.1, 9);
    expect(faded[2]).toBeCloseTo((82 / 255) * 0.1, 9);
    expect(rgba(0xff7b3d, 0)).toEqual([0, 0, 0, 0]);
  });

  it("reaches past a card by its shadow's offset, blur and spread", () => {
    expect(shadowMargin(WIDGET_THEME.shadow.card)).toBeCloseTo((18 + 20) * MM, 9);
    expect(shadowMargin(WIDGET_THEME.shadow.xs)).toBeCloseTo(3 * MM, 9);
    expect(shadowMargin([])).toBe(0);
  });
});

describe('quads per kind', () => {
  it('draws every card as a solid white box with the card shadow and no ring', () => {
    for (const w of [timer(T), progressWidget(T), checklist(T), choices(T)]) {
      const card = quads(face(w).object)[0] as Quad;
      expect(card.mode).toBe('box');
      close(card.u.uFill.value, [1, 1, 1, 1]);
      expect(card.u.uStroke.value.w).toBe(0);
      expect(card.u.uStrokeWidth.value).toBe(0);
      expect(card.u.uRadius.value).toBeCloseTo(18 * MM, 9);
      close(card.u.uShadow.value[0], [2 * MM, 1.5 * MM, 0, 0.08]);
      close(card.u.uShadow.value[1], [18 * MM, 10 * MM, -4 * MM, 0.075]);
    }
  });

  it('runs the timer ring: ink arc over a sunken track, citrus end-dot, check hidden', () => {
    const [, ring, check] = quads(face(timer(T)).object) as Quad[];
    expect(ring?.mode).toBe('ring');
    close(ring?.u.uParam.value ?? { toArray: () => [] }, [18 * MM, 4 * MM, 112 / 120, 3.5 * MM]);
    close(ring?.u.uFill.value ?? { toArray: () => [] }, rgba(0xf1f3f7));
    close(ring?.u.uAccent.value ?? { toArray: () => [] }, rgba(0x0f1117));
    close(ring?.u.uParam2.value ?? { toArray: () => [] }, rgba(0xff7b3d));
    expect(check?.mode).toBe('check');
    expect(check?.visible).toBe(false);
  });

  it('fills the ring mint, fades the dot and draws the check once a timer is done', () => {
    const w = timer(T, { left: -500, status: 'done', doneT: T - 500, closeAt: T + 9500 });
    const [, ring, check] = quads(face(w, T, T + 1000).object) as Quad[];
    close(ring?.u.uAccent.value ?? { toArray: () => [] }, rgba(0x2ac48a));
    expect(ring?.u.uParam.value.z).toBeCloseTo(1, 9);
    expect(ring?.u.uParam2.value.w).toBe(0);
    expect(check?.visible).toBe(true);
    expect(check?.u.uParam.value.x).toBeCloseTo(1, 9);
    close(check?.u.uAccent.value ?? { toArray: () => [] }, rgba(0x2ac48a));
  });

  it('segments a whole-number count and runs a continuous bar for an amount', () => {
    const segmented = quads(face(progressWidget(T)).object).find((q) => q.mode === 'segments');
    expect(segmented?.u.uParam.value.toArray()).toEqual([4, 3, 3 * MM, 0]);
    // Empty segments are the sunken track's solid fill, with no outline.
    close(segmented?.u.uFill.value ?? { toArray: () => [] }, rgba(0xf1f3f7));
    expect(segmented?.u.uStroke.value.w).toBe(0);
    const amount = quads(
      face(progressWidget(T, { value: 120, total: 250, unit: 'mL' })).object,
    ).find((q) => q.mode === 'segments');
    expect(amount?.u.uParam.value.x).toBe(1);
    expect(amount?.u.uParam.value.y).toBeCloseTo(120 / 250, 9);
    expect(amount?.u.uParam.value.w).toBeCloseTo(8 * MM, 9);
  });

  it('draws open checklist items as light discs, done ones as ink discs with white checks', () => {
    const list = face(checklist(T));
    const circles = quads(list.object).filter((q) => q.mode === 'check' && q.visible);
    expect(circles).toHaveLength(3);
    const [done, todo, other] = circles as [Quad, Quad, Quad];
    expect(done.u.uParam.value.w).toBe(1);
    expect(done.u.uParam.value.x).toBe(1);
    close(done.u.uFill.value, rgba(0x0f1117));
    close(done.u.uAccent.value, rgba(0xffffff));
    expect(todo.u.uParam.value.w).toBe(0);
    close(todo.u.uParam2.value, rgba(0xe7eaee));
    expect(todo.u.uStroke.value.w).toBe(0);
    // A fingertip over a row darkens its disc; the others stay light.
    list.setTouch(1, 'hover', T);
    list.frame(T + 500, 1);
    close(todo.u.uParam2.value, rgba(0xcad0d9));
    close(other.u.uParam2.value, rgba(0xe7eaee));
    expect(todo.u.uStroke.value.w).toBe(0);
  });

  it('divides checklist rows with solid lines', () => {
    const dividers = quads(face(checklist(T)).object).filter(
      (q) => q.mode === 'box' && q.visible && q.u.uHalf.value.y === 0.5 * MM,
    );
    expect(dividers).toHaveLength(2);
    for (const divider of dividers) close(divider.u.uFill.value, rgba(0xe7eaee));
  });

  const answers = (f: Face) =>
    quads(f.object).filter((q) => q.mode === 'box' && q.visible && q.u.uRadius.value === 19 * MM);
  const answerLabels = (f: Face) => {
    const out: FakeTextObject[] = [];
    f.object.traverse((o) => {
      if (o instanceof FakeTextObject && o.role === 'strong' && o.visible) out.push(o);
    });
    return out;
  };

  it('draws answers as solid light buttons with the small shadow and no ring', () => {
    const pills = answers(face(choices(T)));
    expect(pills).toHaveLength(2);
    for (const pill of pills) {
      close(pill.u.uFill.value, rgba(0xe7eaee));
      expect(pill.u.uStroke.value.w).toBe(0);
      close(pill.u.uShadow.value[0], [1 * MM, 1 * MM, 0, 0.06]);
    }
  });

  it('darkens an answer under a fingertip, inks a pressed one, never rings either', () => {
    const f = face(choices(T));
    f.setTouch(0, 'hover', T);
    f.setTouch(1, 'pressed', T);
    f.frame(T + 300, 1);
    const [hovered, pressed] = answers(f) as [Quad, Quad];
    close(hovered.u.uFill.value, rgba(0xcad0d9));
    close(pressed.u.uFill.value, rgba(0x0f1117));
    for (const pill of [hovered, pressed]) {
      expect(pill.u.uStroke.value.w).toBe(0);
      expect(pill.u.uOpacity.value).toBe(1);
    }
    expect(answerLabels(f).map((l) => l.color)).toEqual([0x0f1117, 0xffffff]);
  });

  it('mutes the answers not chosen with an opaque fill and faint text, never transparency', () => {
    const w = choices(T, { chosen: 0, chosenVia: 'touch' });
    const f = face(choices(T));
    f.set(w, T);
    f.frame(T + 1000, 1);
    const [chosen, other] = answers(f) as [Quad, Quad];
    close(chosen.u.uFill.value, rgba(0x0f1117));
    close(other.u.uFill.value, rgba(0xf4f6fa));
    expect(other.u.uOpacity.value).toBe(1);
    const [chosenLabel, otherLabel] = answerLabels(f) as [FakeTextObject, FakeTextObject];
    expect(chosenLabel.color).toBe(0xffffff);
    expect(otherLabel.color).toBe(0x8a94a4);
    expect(otherLabel.opacity).toBe(1);
  });

  it('sets the caution on the warm caution surface with a citrus "!" disc, no ring', () => {
    const [card, disc] = quads(face(caution(T)).object) as [Quad, Quad];
    close(card.u.uFill.value, rgba(0xfff0e4));
    expect(card.u.uStroke.value.w).toBe(0);
    expect(disc.mode).toBe('bang');
    close(disc.u.uFill.value, rgba(0xff7b3d));
    const pill = new PillFace(fakeText, 'caution');
    pill.set(caution(T), T);
    const [pillCard] = quads(pill.object) as [Quad];
    expect(pillCard.u.uRadius.value).toBeCloseTo(17 * MM, 9);
    close(pillCard.u.uFill.value, rgba(0xfff0e4));
    expect(pillCard.u.uStroke.value.w).toBe(0);
  });

  it('draws every fixture, pills and chips with solid opaque fills and no outline', () => {
    const faces: { name: string; f: Face }[] = [];
    for (const fixture of widgetFixtures(T)) {
      const f =
        fixture.state === 'collapsed'
          ? new PillFace(fakeText, fixture.kind)
          : createCard(fixture.widget, fakeText);
      f.set(fixture.widget, T);
      if (fixture.touch) f.setTouch(fixture.touch.index, fixture.touch.look, T);
      faces.push({ name: fixture.name, f });
    }
    const chip = new TimerChip(fakeText);
    chip.set(timer(T), T);
    faces.push({ name: 'Timer chip', f: chip });
    for (const { name, f } of faces) {
      f.frame(T + 2000, 1);
      for (const q of quads(f.object)) {
        const where = `${name}: ${q.mode}`;
        for (const colour of [q.u.uFill, q.u.uAccent, q.u.uParam2]) {
          expect([0, 1], where).toContain(colour.value.w);
        }
        // The only stroke is the surface-coloured gap around a ring's end-dot.
        if (q.mode !== 'ring') expect(q.u.uStroke.value.w, where).toBe(0);
        if (q.visible) expect(q.u.uOpacity.value, where).toBe(1);
      }
    }
  });
});

/** Hue (deg) and HSV saturation of an sRGB colour. */
function hueSat(hex: number): [number, number] {
  const r = ((hex >> 16) & 0xff) / 255;
  const g = ((hex >> 8) & 0xff) / 255;
  const b = (hex & 0xff) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return [0, 0];
  const sat = d / max;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, sat];
}

describe('theme', () => {
  /** Every colour the Clio design system defines (light surfaces and signals); no AR blue. */
  const TOKENS = new Set([
    0x0f1117, 0x24303d, 0x5b6472, 0x646d7c, 0x8a94a4, 0xffffff, 0xedf2f6, 0xf5f7fa, 0xf4f6fa,
    0xf1f3f7, 0xff7b3d, 0xff9b66, 0xb94a00, 0x6fd3a0, 0x2ac48a, 0x007d4d, 0x0e2a52, 0xfff0e4,
  ]);
  /** The navy hairline precomputed over white: what dividers and control fills are made of. */
  const NAVY = 0x0e2a52;
  const BLUES = [0x6e9bff, 0x6bb7dc, 0x4aa7d1, 0x2f7def, 0x1768d9];

  it('uses only design-system colours, and no blue', () => {
    const C = LIGHT.color;
    const derived = new Set([C.divider, C.control, C.controlHover]);
    const colours = Object.values(C);
    for (const c of colours) {
      if (!derived.has(c)) expect(TOKENS.has(c), c.toString(16)).toBe(true);
    }
    for (const blue of BLUES) expect(colours).not.toContain(blue);
    // Nothing filled or written is blue (hue 190 to 260 deg with real saturation); the light
    // fills are navy-tinted, as the design system's hairlines are.
    for (const c of colours) {
      const [h, sat] = hueSat(c);
      expect(h >= 190 && h <= 260 && sat > 0.35, c.toString(16)).toBe(false);
    }
    // Dividers and control fills are the navy hairline precomputed over white, opaque.
    expect(C.divider).toBe(mixHex(0xffffff, NAVY, 0.1));
    expect(C.control).toBe(mixHex(0xffffff, NAVY, 0.1));
    expect(C.controlHover).toBe(mixHex(0xffffff, NAVY, 0.22));
  });

  it('keeps every type size at or above the floor', () => {
    for (const spec of Object.values(LIGHT.type)) {
      expect(spec.size).toBeGreaterThanOrEqual(LIGHT.size.floor);
    }
  });

  it('keeps radii within their ranks: standard card, small tile, round pills', () => {
    expect(LIGHT.size.cardRadius).toBeGreaterThanOrEqual(18 * MM);
    expect(LIGHT.size.cardRadius).toBeLessThanOrEqual(24 * MM);
    expect(LIGHT.size.tileRadius).toBeGreaterThanOrEqual(6 * MM);
    expect(LIGHT.size.tileRadius).toBeLessThanOrEqual(8 * MM);
    const pill = new PillFace(fakeText, 'value');
    expect((quads(pill.object)[0] as Quad).u.uRadius.value).toBeCloseTo(
      LIGHT.size.pillHeight / 2,
      9,
    );
  });

  it('is the light theme at its exact tokens', () => {
    expect(WIDGET_THEME).toBe(LIGHT);
    expect(LIGHT.surfaceLevel).toBe(1);
  });
});

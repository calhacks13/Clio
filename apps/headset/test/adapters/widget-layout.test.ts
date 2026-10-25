import { WIDGET_TEXT_MAX } from '@clio/protocol';
import { describe, expect, it } from 'vitest';
import {
  caution,
  checklist,
  choices,
  progressWidget,
  timer,
  value,
  widgetFixtures,
} from '../../src/adapters/render/widgets/fixtures';
import {
  type CardLayout,
  cardLayout,
  cautionCard,
  checklistCard,
  chipLayout,
  choicesCard,
  type DockItem,
  layoutDock,
  leadOf,
  MIN_BAR,
  pillLayout,
  progressCard,
  type Rect,
  type TextBlock,
  timerCard,
  valueCard,
} from '../../src/adapters/render/widgets/layout';
import { DOCK_ORDER } from '../../src/adapters/render/widgets/placement';
import { FIT, measure } from '../../src/adapters/render/widgets/text-layout';
import { FakeTextObject, fakeText } from '../../src/adapters/render/widgets/text-port';
import { MM, WIDGET_THEME } from '../../src/adapters/render/widgets/theme';
import { TOUCH } from '../../src/adapters/render/widgets/touch';
import { createCard } from '../../src/adapters/render/widgets/views/view';
import { formatCount } from '../../src/domain/widgets/format';
import type { ChoicesWidget, ProgressWidget, Widget } from '../../src/domain/widgets/types';

// The card anatomy (§6.4) and the dock's column: every element inside its card, readable text,
// touch targets big enough for a fingertip, and the column inside its height budget.

const T = 1000;
const mm = (m: number): number => Math.round((m / MM) * 10) / 10;

/** Every rectangle and text box of a card layout. */
function parts(layout: CardLayout): { rects: Rect[]; texts: TextBlock[] } {
  switch (layout.kind) {
    case 'timer': {
      const { cx, cy, outer } = layout.ring;
      return {
        rects: [
          { x: cx - outer / 2, y: cy - outer / 2, w: outer, h: outer },
          layout.check,
          layout.digits,
        ],
        texts: [layout.label, layout.state],
      };
    }
    case 'progress':
      return {
        rects: [layout.bar, layout.done.dot],
        texts: [layout.label, layout.count, layout.done.text],
      };
    case 'checklist':
      return {
        rects: [...layout.rows.flatMap((r) => [r.row, r.circle, r.tile]), ...layout.dividers],
        texts: [layout.title, layout.count, layout.done, ...layout.rows.map((r) => r.text)],
      };
    case 'choices':
      return {
        rects: layout.options.flatMap((o) => [o.pill, o.check]),
        texts: [layout.question, ...layout.options.flatMap((o) => [o.label, o.chosenLabel])],
      };
    case 'value':
      return { rects: [], texts: [layout.label, layout.value] };
    case 'caution':
      return { rects: [layout.disc], texts: [layout.text] };
  }
}

/** Touch targets of a card layout (checklist rows, choice pills). */
function targets(layout: CardLayout): Rect[] {
  if (layout.kind === 'checklist') return layout.rows.map((r) => r.row);
  if (layout.kind === 'choices') return layout.options.map((o) => o.pill);
  return [];
}

const inside = (r: Rect, w: number, h: number): boolean =>
  r.x >= -1e-9 && r.y >= -1e-9 && r.x + r.w <= w + 1e-9 && r.y + r.h <= h + 1e-9;

const overlap = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w - 1e-9 &&
  b.x < a.x + a.w - 1e-9 &&
  a.y < b.y + b.h - 1e-9 &&
  b.y < a.y + a.h - 1e-9;

describe('card anatomy, for every fixture', () => {
  const fixtures = widgetFixtures(T);

  it('is 180 mm wide, with every element inside the card', () => {
    for (const { name, widget } of fixtures) {
      const layout = cardLayout(widget);
      expect(layout.width, name).toBe(0.18);
      const { rects, texts } = parts(layout);
      for (const r of [...rects, ...texts])
        expect(inside(r, layout.width, layout.height), name).toBe(true);
    }
  });

  it('never draws text below the 12 mm floor', () => {
    for (const { name, widget } of fixtures) {
      const { texts } = parts(cardLayout(widget));
      const pill = pillLayout(widget);
      for (const t of [...texts, pill.primary, ...(pill.secondary ? [pill.secondary] : [])]) {
        expect(t.size, `${name} ${t.role}`).toBeGreaterThanOrEqual(WIDGET_THEME.size.floor);
      }
    }
    expect(WIDGET_THEME.size.floor).toBe(0.012);
    for (const spec of Object.values(WIDGET_THEME.type))
      expect(spec.size).toBeGreaterThanOrEqual(0.013);
  });

  it('gives a fingertip targets at least 34 mm tall that do not overlap', () => {
    for (const { name, widget } of fixtures) {
      const hits = targets(cardLayout(widget));
      for (const [i, a] of hits.entries()) {
        // What the fingertip can hit: the rectangle grown on every side.
        expect(a.h + 2 * TOUCH.inflate, name).toBeGreaterThanOrEqual(0.034);
        for (const b of hits.slice(i + 1)) expect(overlap(a, b), name).toBe(false);
      }
    }
  });

  it('has the heights of §6.4', () => {
    expect(mm(cardLayout(timer(T)).height)).toBe(74);
    expect(mm(cardLayout(timer(T, { label: 'Colour develops' })).height)).toBe(91);
    expect(mm(cardLayout(value(T)).height)).toBe(74);
    expect(mm(cardLayout(widgetFixtures(T)[5]?.widget as Widget).height)).toBe(62);
    // Checklist: 40 + rows (32 one line, 50 two) + 10.
    expect(mm(cardLayout(checklist(T)).height)).toBe(40 + 3 * 32 + 10);
    const five = checklist(T, {
      items: ['Gloves', 'Goggles', 'Cap off', 'Rag', 'Funnel'].map((text) => ({
        text,
        done: false,
      })),
    });
    expect(mm(cardLayout(five).height)).toBe(210);
    const twoLine = checklist(T, {
      items: ['Power off at the wall', 'Washer fluid bottle', 'Small white funnel'].map((text) => ({
        text,
        done: false,
      })),
    });
    expect(mm(cardLayout(twoLine).height)).toBe(200);
    // Choices: 14 + question + 12 + options + 14.
    const three = choices(T, { options: ['Yes', 'Not yet', "Can't find it"] });
    expect(mm(cardLayout(three).height)).toBe(210);
    expect(mm(cardLayout(choices(T, { question: 'Ready?', options: ['Yes', 'No'] })).height)).toBe(
      14 + 20 + 12 + 38 + 14,
    );
    // The tallest: a question on four lines over three answers.
    const tallest = choices(T, {
      question: 'Do the measurements match the drawing now?',
      options: ['Yes', 'Not yet', "Can't find it"],
    });
    expect(mm(cardLayout(tallest).height)).toBe(14 + 4 * 20 + 12 + 3 * 38 + 2 * 8 + 14);
    // Caution: 14 + max(20, lines x 18.2) + 14, up to five lines.
    const cautionHeight = (name: string) =>
      mm(cardLayout(widgetFixtures(T).find((f) => f.name === name)?.widget as Widget).height);
    expect(cautionHeight('Caution')).toBe(Math.ceil(14 + 3 * 18.2 + 14));
    expect(cautionHeight('Caution, long')).toBe(Math.ceil(14 + 5 * 18.2 + 14));
    for (const f of widgetFixtures(T)) expect(mm(pillLayout(f.widget).height)).toBe(34);
  });

  it('puts two short answers in two columns, and longer ones stacked', () => {
    const two = cardLayout(choices(T, { options: ['Yes', 'No'] }));
    expect(two.kind === 'choices' && two.twoColumns).toBe(true);
    const stacked = cardLayout(choices(T));
    expect(stacked.kind === 'choices' && stacked.twoColumns).toBe(false);
  });

  it('fits a chip to its content, its label whole up to the tool limit', () => {
    const chip = chipLayout(timer(T));
    expect(chip.height).toBeCloseTo(0.03, 9);
    expect(chip.label.text).toBe('Glue sets');
    expect(mm(chip.width)).toBeLessThan(150);
    // Realistic 16-character labels, the widest found among them, draw whole: the chip grows.
    for (const label of [
      'Woodscrews dried',
      'Mixture thickens',
      'Concrete hardens',
      'Hold down firmly',
      'Second coat sets',
      'Colour develops',
    ]) {
      for (const durationMs of [5000, 120_000, 3_600_000]) {
        const long = chipLayout(timer(T, { label, durationMs }));
        expect(long.label.text, label).toBe(label);
        expect(long.label.truncated, label).toBe(false);
        expect(long.height).toBeCloseTo(0.03, 9);
        expect(long.label.x + measure(label, 'label'), label).toBeLessThanOrEqual(
          long.width - 10 * MM,
        );
        expect(mm(long.width), label).toBeLessThanOrEqual(207);
      }
    }
    // Only runs no lesson writes are cut.
    expect(chipLayout(timer(T, { label: 'WWWWWWWWWWWWWWWW' })).label.truncated).toBe(true);
  });
});

describe('progress card', () => {
  it('keeps its form as the count changes and when it is done', () => {
    for (const label of ['Screws out', 'Stitches done', 'Bolts tightened']) {
      const forms = [9, 10, 12].map((v) => {
        const layout = progressCard(progressWidget(T, { label, value: v, total: 12 }));
        return { bar: mm(layout.bar.w), countY: mm(layout.count.y), doneY: mm(layout.done.text.y) };
      });
      expect(forms[1], label).toEqual(forms[0]);
      expect(forms[2], label).toEqual(forms[0]);
    }
    // A short label keeps the count beside it over a full-width bar.
    const short = progressCard(progressWidget(T));
    expect(mm(short.bar.w)).toBe(148);
    expect(short.label.text).toBe('Screws out');
  });

  // Realistic amounts up to the tools' limits: totals up to 9999 and units up to 8 characters.
  const UNITS = [null, 'mL', 'cm', 'cups', 'grams', 'litres', 'seconds', 'kilogram'];
  const TOTALS = [4, 12, 60, 250, 750, 1000, 2500, 9999];
  const LABELS = ['Poured', 'Flour weighed', 'Woodscrews removed'];
  /** Whole counts on the way to `total` (a decimal may widen the count, and so change form). */
  const valuesOf = (total: number) => [0, 1, Math.round(total * 0.75), total];
  /** Where text is drawn (card coordinates), by its anchor and measured width. */
  const drawn = (b: TextBlock): Rect => {
    let w = 0;
    for (const line of b.text.split('\n')) w = Math.max(w, measure(line, b.role, b.size));
    const x =
      b.align === 'right' ? b.x + b.w - w : b.align === 'center' ? b.x + (b.w - w) / 2 : b.x;
    return { x, y: b.y, w, h: b.h };
  };

  it('keeps its bar at least 40 mm long and its count whole, for any amount', () => {
    const laidOut = (label: string, value: number, total: number, unit: string | null) => {
      const layout = progressCard(progressWidget(T, { label, value, total, unit }));
      const name = `${label}: ${formatCount(value, total, unit)}`;
      expect(layout.bar.w, name).toBeGreaterThanOrEqual(MIN_BAR - 1e-9);
      expect(layout.count.text.split('\n').join(' '), name).toBe(formatCount(value, total, unit));
      for (const line of layout.count.text.split('\n'))
        expect(measure(line, 'status'), name).toBeLessThanOrEqual(148 * MM * FIT);
      expect(layout.label.truncated, name).toBe(false);
      const count = drawn(layout.count);
      for (const r of [count, drawn(layout.label), layout.bar, layout.done.dot])
        expect(inside(r, layout.width, layout.height), name).toBe(true);
      expect(overlap(count, drawn(layout.label)), name).toBe(false);
      expect(overlap(count, layout.bar), name).toBe(false);
      expect(overlap(drawn(layout.label), layout.bar), name).toBe(false);
      return { h: mm(layout.height), bar: layout.bar, countY: layout.count.y };
    };
    for (const unit of UNITS) {
      for (const total of TOTALS) {
        for (const label of LABELS) {
          const forms = valuesOf(total).map((value) => laidOut(label, value, total, unit));
          // One form for every whole count up to the total, so nothing moves as it counts.
          for (const form of forms) expect(form, `${label} of ${total} ${unit}`).toEqual(forms[0]);
          // An amount may be a decimal, up to the widest the tools allow.
          if (unit)
            for (const value of [total / 2 + 0.5, total - 0.5]) laidOut(label, value, total, unit);
        }
      }
    }
    laidOut('Woodscrews removed', 9998.5, 9998.5, 'kilogram');
  });

  it('puts a long amount on a row of its own over a full-width bar', () => {
    for (const [value, total, unit] of [
      [750, 1000, 'grams'],
      [1000, 1000, 'cups'],
      [120, 250, 'mL'],
    ] as const) {
      const layout = progressCard(progressWidget(T, { label: 'Poured', value, total, unit }));
      expect(mm(layout.bar.w)).toBe(148);
      expect(layout.count.align).toBe('left');
      expect(layout.count.text).toBe(formatCount(value, total, unit));
      expect(mm(layout.height)).toBe(83);
    }
    // Wider than the row: it breaks before its unit.
    const widest = progressCard(
      progressWidget(T, { label: 'Poured', value: 9999, total: 9999, unit: 'kilogram' }),
    );
    expect(widest.count.text).toBe('9999 of 9999\nkilogram');
    expect(mm(widest.bar.w)).toBe(148);
    expect(mm(widest.height)).toBe(102);
    // A count that leaves 40 mm sits beside the bar, under a label too long to share its row.
    for (const [value, total, unit] of [
      [12, 20, null],
      [30, 45, 'cm'],
      [2.5, 4, 'cups'],
    ] as const) {
      const beside = progressCard(
        progressWidget(T, { label: 'Woodscrews removed', value, total, unit }),
      );
      expect(beside.count.align).toBe('right');
      expect(mm(beside.bar.w)).toBeGreaterThanOrEqual(40);
      expect(mm(beside.bar.w)).toBeLessThan(148);
      expect(mm(beside.height)).toBe(62);
    }
  });

  it('keeps a pill inside its padding for any amount: the count first, then the label', () => {
    for (const unit of UNITS) {
      for (const total of TOTALS) {
        for (const value of valuesOf(total)) {
          const w = progressWidget(T, { label: 'Flour weighed', value, total, unit });
          const pill = pillLayout(w);
          const count = pill.secondary;
          if (!count) throw new Error('no count');
          const name = formatCount(value, total, unit);
          const countEnd = count.x + measure(count.text, 'status');
          expect(countEnd, name).toBeLessThanOrEqual(0.18 - 14 * MM + 1e-9);
          if (pill.mark) expect(pill.mark.x + pill.mark.w, name).toBeLessThan(count.x);
          // The label whole, cut with room for a word, or not at all; never a lone ellipsis.
          if (pill.primary.text !== '') {
            expect(pill.primary.x, name).toBeGreaterThan(countEnd);
            expect(pill.primary.w, name).toBeGreaterThanOrEqual(30 * MM);
          }
        }
      }
    }
    // A short count keeps the bar and the whole label; a long amount keeps its count whole.
    expect(pillLayout(progressWidget(T, { label: 'Screws out' })).primary.text).toBe('Screws out');
    const long = pillLayout(progressWidget(T, { value: 750, total: 1000, unit: 'grams' }));
    expect(long.secondary?.text).toBe('750 of 1000 grams');
  });

  it('keeps one pill form while it counts and once it is done: no bar or label comes and goes', () => {
    for (const unit of UNITS) {
      for (const total of TOTALS) {
        for (const label of ['Flour weighed', 'Screws out']) {
          const form = (over: Partial<ProgressWidget>) => {
            const pill = pillLayout(progressWidget(T, { label, total, unit, ...over }));
            return { bar: pill.mark !== null, label: pill.primary.text };
          };
          const first = form({ value: 0 });
          const step = Math.max(1, Math.floor(total / 50));
          for (let value = 0; value <= total; value += step) {
            expect(form({ value }), `${label}: ${formatCount(value, total, unit)}`).toEqual(first);
          }
          const done = form({ value: total, status: 'done', doneT: T });
          expect(done, `${label}: ${total} ${unit} done`).toEqual(first);
        }
      }
    }
  });

  it('fits a two-word label of about 70 mm whole in its pill, beside the mini bar and count', () => {
    for (const label of ['Screws out', 'Pages read', 'Bolts loose']) {
      expect(measure(label, 'label'), label).toBeGreaterThan(0.068);
      const pill = pillLayout(progressWidget(T, { label }));
      expect(pill.primary.text, label).toBe(label);
      expect(pill.primary.truncated, label).toBe(false);
      const count = pill.secondary;
      const bar = pill.mark;
      if (!count || !bar) throw new Error('no count or bar');
      // Bar, count and label left to right, apart, and all inside the pill's padding.
      expect(bar.x + bar.w, label).toBeLessThan(count.x);
      expect(count.x + measure(count.text, 'status'), label).toBeLessThan(pill.primary.x);
      expect(pill.primary.x + measure(label, 'label'), label).toBeLessThanOrEqual(0.18 - 14 * MM);
    }
    expect(mm(pillLayout(progressWidget(T)).mark?.w ?? 0)).toBe(20);
  });
});

describe('progress amounts', () => {
  it('draws a long amount left-aligned under its label, and a short one right of it', () => {
    const counts = (w: Widget) => {
      const face = createCard(w, fakeText);
      face.set(w, T);
      return face.object.children
        .filter(
          (o): o is FakeTextObject =>
            o instanceof FakeTextObject && o.role === 'status' && o.text !== 'Done',
        )
        .filter((o) => o.text !== '')
        .map((o) => [o.text, o.anchor.x ?? 'left', mm(o.position.x)]);
    };
    const long = progressWidget(T, { label: 'Poured', value: 750, total: 1000, unit: 'grams' });
    expect(counts(long)).toEqual([['750 of 1000 grams', 'left', 16]]);
    expect(counts(progressWidget(T))).toEqual([['3 of 4', 'right', 164]]);
  });
});

describe('answer labels', () => {
  /** Where a fake text is drawn across x (card coordinates), from its anchor and measured width. */
  function drawnX(text: FakeTextObject): [number, number] {
    const w = measure(text.text, text.role, text.size);
    const shift = text.anchor.x === 'center' ? w / 2 : text.anchor.x === 'right' ? w : 0;
    return [text.position.x - shift, text.position.x - shift + w];
  }

  function labels(w: ChoicesWidget): FakeTextObject[] {
    const face = createCard(w, fakeText);
    face.set(w, T);
    return face.object.children.filter(
      (o): o is FakeTextObject => o instanceof FakeTextObject && o.role === 'strong',
    );
  }

  const chosen = (i: number) => ({
    chosen: i,
    chosenVia: 'touch' as const,
    status: 'done' as const,
  });

  it('shows an answer whole, chosen or not, inside the pill and clear of the check', () => {
    const tools = ['Cordless drill', 'Torque wrench'];
    const wide = ['Too much water', 'Washer missing', 'Not yet'];
    for (const w of [
      choices(T, { options: tools }),
      choices(T, { options: tools, ...chosen(0) }),
      choices(T, { options: tools, ...chosen(1) }),
      choices(T, { ...chosen(1) }),
      choices(T, { options: wide, ...chosen(0) }),
      choices(T, { options: wide, ...chosen(1) }),
      choices(T, { question: 'Is the cap off?', options: ['Yes', 'No'] }),
      choices(T, { question: 'Is the cap off?', options: ['Yes', 'No'], ...chosen(0) }),
      choices(T, { question: 'Is the cap off?', options: ['Yes', 'No'], ...chosen(1) }),
    ]) {
      const layout = choicesCard(w);
      const drawn = labels(w);
      for (const [i, option] of layout.options.entries()) {
        const text = drawn[i] as FakeTextObject;
        const [x0, x1] = drawnX(text);
        const name = `${w.options.join('/')} chosen ${w.chosen}: ${text.text}`;
        expect(x0, name).toBeGreaterThanOrEqual(option.pill.x + 6 * MM);
        expect(x1, name).toBeLessThanOrEqual(option.pill.x + option.pill.w - 6 * MM);
        expect(text.text, name).toBe(w.options[i]);
        if (w.chosen === i) {
          expect(x1, name).toBeLessThanOrEqual(option.check.x);
          expect(option.check.x + option.check.w, name).toBeLessThanOrEqual(
            option.pill.x + option.pill.w - 6 * MM,
          );
        }
      }
    }
  });
});

describe("text at the tools' limits", () => {
  // Each field's limit is as much realistic English as its card draws whole (WIDGET_TEXT_MAX).
  // The texts sit at or just under it and include the widest and worst-wrapping found: capitals
  // and w or m, and long words that leave a line short. Each draws whole, every word on a line,
  // in each arrangement its card has. The ellipsis stays a backstop for runs no lesson writes.
  const M = WIDGET_TEXT_MAX;
  /** Checklist items, the first `ticked` of them done. */
  const list = (texts: string[], ticked = 0) =>
    texts.map((text, i) => ({ text, done: i < ticked }));
  const five = ['Gloves', 'Goggles', 'Cap', 'Rag', 'Funnel'];
  const fields: {
    field: string;
    max: number;
    texts: string[];
    draw: (s: string) => TextBlock[];
  }[] = [
    {
      field: 'timer label',
      max: M.timerLabel,
      texts: [
        'Colour develops',
        'Mixture thickens',
        'Concrete hardens',
        'Second coat sets',
        'Let sealant cure',
        'Hold down firmly',
        'Leave it to soak',
        'Wallpaper soaks',
        'Cheesecake sets',
        'Wood glue sets',
      ],
      draw: (label) => [timerCard({ label }).label],
    },
    {
      field: 'progress label',
      max: M.progressLabel,
      texts: [
        'Woodscrews removed',
        'Mower wheels moved',
        'Wood screws undone',
        'Window panes wiped',
        'Millilitres poured',
        'Wheel nuts torqued',
        'Pump strokes done',
        'Lug nuts loosened',
      ],
      // Beside a short count, and on its own row above a long one.
      draw: (label) => [
        progressCard(progressWidget(T, { label })).label,
        progressCard(progressWidget(T, { label, value: 120, total: 250, unit: 'mL' })).label,
      ],
    },
    {
      field: 'checklist title',
      max: M.checklistTitle,
      texts: [
        'Woodworking',
        'Workbenches',
        'Mower check',
        'Window prep',
        'Wheel check',
        'Safety gear',
        'Before work',
        'Ingredients',
        'Get ready',
      ],
      // Beside the count of a list of two, and of five as its items are ticked, and beside
      // "Done" once all of either are.
      draw: (title) => [
        ...[list(['Rag', 'Funnel']), ...[0, 2, 4].map((ticked) => list(five, ticked))].map(
          (items) => checklistCard(checklist(T, { title, items })).title,
        ),
        ...[list(['Rag', 'Funnel'], 2), list(five, 5)].map(
          (items) => checklistCard(checklist(T, { title, items, status: 'done' })).title,
        ),
      ],
    },
    {
      field: 'checklist item',
      max: M.checklistItem,
      texts: [
        'Spare washers in the cup',
        'Old towel under the trap',
        'Hydrogen peroxide bottle',
        'Adjustable wrench, small',
        'Microfibre cloths folded',
        'Extension cord unplugged',
        'Measuring spoons and jug',
        'Bike upside down on seat',
        'Thermometer in the water',
        'Sandpaper wrapped round',
        'Mallet and wood wedges',
        'Power off at the wall',
      ],
      draw: (text) => [
        checklistCard(checklist(T, { items: list([text, 'Rag']) })).rows[0]?.text as TextBlock,
      ],
    },
    {
      field: 'question',
      max: M.question,
      texts: [
        'Do the measurements match what the instructions say?',
        'Have you unplugged the toaster from the wall socket?',
        'Which of the bottles contains the hydrogen peroxide?',
        'Has the indicator solution turned completely clear?',
        'Did the sourdough starter double in size overnight?',
        'Is the water in the saucepan simmering or boiling?',
        'Do the new brake pads match the old ones in shape?',
        'Would you prefer to use the stepladder or a chair?',
        'Did the indicator turn pink in cup A or in cup B?',
      ],
      draw: (question) => [choicesCard(choices(T, { question })).question],
    },
    {
      field: 'answer',
      max: M.option,
      texts: [
        'Too much water',
        'Warm, but damp',
        'Medium hex key',
        'Washer missing',
        'Wobbly and low',
        'Under the sink',
        'Cordless drill',
        "Painter's tape",
        'Medium wrench',
        'Wooden mallet',
        "Can't find it",
        'Torque wrench',
      ],
      // At rest and chosen, stacked with two others or paired with a short one.
      draw: (option) =>
        [
          [option, 'Not yet', 'No'],
          [option, 'No'],
        ].flatMap((options) => {
          const first = choicesCard(choices(T, { options })).options[0];
          return first ? [first.label, first.chosenLabel] : [];
        }),
    },
    {
      field: 'value label',
      max: M.valueLabel,
      texts: [
        'Mower blade height',
        'Max working weight',
        'Multimeter reading',
        'Rear tyre pressure',
        'Water temperature',
        'Wood moisture (%)',
        'Mains voltage (V)',
        'Wheel nut torque',
      ],
      draw: (label) => [valueCard(value(T, { label })).label],
    },
    {
      field: 'value',
      max: M.value,
      texts: ['1 cup per 2 cups', '2.5 bar at 20 °C', '180 °C, fan oven', '230 V AC, 50 Hz'],
      draw: (v) => [valueCard(value(T, { value: v })).value],
    },
    {
      field: 'caution',
      max: M.caution,
      texts: [
        'Never put your hand under the mower deck while it is running',
        'Hydrogen peroxide bleaches clothes, so wear an old shirt now',
        'The radiator coolant is scalding until the engine has cooled',
        'The soldering iron stays hot for minutes after you unplug it',
        'Point the nozzle away from your face when you open the valve',
        'Isopropyl alcohol is flammable, so keep it away from flames',
        'The mandoline blade is razor sharp, so always use the guard',
        'Fibreglass insulation irritates skin, so wear long sleeves',
        'Wear the respirator while sanding the old lead-based paint',
      ],
      draw: (text) => [cautionCard(caution(T, { text })).text],
    },
  ];

  for (const { field, max, texts, draw } of fields) {
    it(`draws ${field}s of up to ${max} characters whole`, () => {
      expect(texts.some((text) => text.length === max)).toBe(true);
      for (const text of texts) {
        expect(text.length, text).toBeLessThanOrEqual(max);
        expect(text.length, text).toBeGreaterThan(max - 4);
        for (const block of draw(text)) {
          expect(block.truncated, `${field}: ${text}`).toBe(false);
          expect(block.text.split('\n').join(' '), `${field}: ${text}`).toBe(text);
        }
      }
    });
  }

  it('keeps a checklist title the same room while its items are ticked, and once all are', () => {
    // The widest count's room, whatever the count reads, so a title is never cut at "4 of 5" alone,
    // nor for the 4 s "Done" shows in its place.
    for (const n of [2, 5]) {
      const texts = five.slice(0, n);
      const room = (ticked: number) =>
        checklistCard(
          checklist(T, { items: list(texts, ticked), status: ticked === n ? 'done' : 'active' }),
        ).title.w;
      for (let ticked = 1; ticked <= n; ticked++)
        expect(room(ticked), `${ticked} of ${n}`).toBe(room(0));
    }
    const done = checklistCard(checklist(T, { items: list(five, 5), status: 'done' })).done;
    expect(done.text).toBe('Done');
    expect(mm(done.x + done.w)).toBe(164);
  });
});

const item = (over: Partial<DockItem> & Pick<DockItem, 'id' | 'kind'>): DockItem => ({
  createdT: 0,
  updatedT: 0,
  doneT: null,
  open: false,
  height: 0.08,
  ...over,
});

describe('layoutDock', () => {
  it('stacks by DOCK_ORDER, then by createdT', () => {
    const slots = layoutDock([
      item({ id: 'choices', kind: 'choices', height: 0.05 }),
      item({ id: 'timer-2', kind: 'timer', createdT: 5, height: 0.034 }),
      item({ id: 'caution', kind: 'caution', height: 0.048 }),
      item({ id: 'timer', kind: 'timer', createdT: 1, height: 0.034 }),
    ]);
    expect(slots.map((s) => s.id)).toEqual(['caution', 'timer', 'timer-2', 'choices']);
    expect(slots.map((s) => mm(s.top))).toEqual([0, 56, 98, 140]);
    expect(DOCK_ORDER[0]).toBe('caution');
  });

  it('collapses the oldest-updated first, never the lead or an open choice', () => {
    const slots = layoutDock([
      item({ id: 'timer', kind: 'timer', updatedT: 100, height: 0.08 }),
      item({ id: 'value', kind: 'value', updatedT: 50, height: 0.078 }),
      item({ id: 'progress', kind: 'progress', updatedT: 200, height: 0.062 }),
      item({ id: 'checklist', kind: 'checklist', updatedT: 300, height: 0.146 }),
    ]);
    const collapsed = Object.fromEntries(slots.map((s) => [s.id, s.collapsed]));
    expect(collapsed).toEqual({ timer: true, value: true, progress: false, checklist: false });
    const last = slots.at(-1) as (typeof slots)[number];
    expect(last.top + last.height).toBeLessThanOrEqual(0.3 + 1e-9);

    const open = layoutDock([
      item({ id: 'choices', kind: 'choices', open: true, updatedT: 0, height: 0.21 }),
      item({ id: 'checklist', kind: 'checklist', updatedT: 900, height: 0.21 }),
    ]);
    expect(open.find((s) => s.id === 'choices')?.collapsed).toBe(false);
    expect(open.find((s) => s.id === 'checklist')?.collapsed).toBe(true);
  });

  it('never collapses the caution, however long since it changed', () => {
    const slots = layoutDock([
      item({ id: 'caution', kind: 'caution', updatedT: 0, height: 0.119 }),
      item({ id: 'timer', kind: 'timer', updatedT: 5, height: 0.097 }),
      item({ id: 'checklist', kind: 'checklist', updatedT: 9, height: 0.146 }),
    ]);
    const collapsed = Object.fromEntries(slots.map((s) => [s.id, s.collapsed]));
    expect(collapsed).toEqual({ caution: false, timer: true, checklist: false });
  });

  it('measures the worst columns: what fits the 0.300 m budget and what runs on', () => {
    const height = (w: Widget) => cardLayout(w).height;
    const lines = (n: number, text: string) =>
      Array.from({ length: n }, (_, i) => ({ text: `${text} ${i + 1}`, done: false }));
    // The tallest card of each kind the tools allow.
    const tallest = {
      caution: caution(T, {
        text: 'Never put your hand under the mower deck while it is running',
      }),
      choices: choices(T, {
        question: 'Do the measurements match the drawing now?',
        options: ['Yes', 'Not yet', "Can't find it"],
      }),
      checklistShort: checklist(T, { items: lines(5, 'Rag') }),
      checklistLong: checklist(T, { items: lines(5, 'Washer fluid bottle') }),
      timer: timer(T, { label: 'Colour develops' }),
    };
    expect(mm(height(tallest.caution))).toBe(119);
    expect(mm(height(tallest.choices))).toBe(250);
    expect(mm(height(tallest.checklistShort))).toBe(210);
    expect(mm(height(tallest.checklistLong))).toBe(300);
    const column = (lead: Widget, ...rest: Widget[]) => {
      const items = [lead, ...rest].map((w, i) =>
        item({
          id: w.id,
          kind: w.kind,
          // The lead changed last; an open question leads anyway.
          updatedT: w === lead ? 99 : i,
          open: w.kind === 'choices',
          height: height(w),
        }),
      );
      const slots = layoutDock(items);
      const last = slots.at(-1) as (typeof slots)[number];
      expect(slots.find((s) => s.id === 'caution')?.collapsed ?? false).toBe(false);
      return mm(last.top + last.height);
    };
    const pills = [timer(T, { id: 'timer-2', seq: 9 }), value(T)];
    expect(column(tallest.checklistShort, ...pills)).toBe(294);
    expect(column(tallest.choices, ...pills)).toBe(334);
    expect(column(tallest.checklistLong, ...pills)).toBe(384);
    expect(column(tallest.choices, tallest.caution, tallest.timer)).toBe(419);
    expect(column(tallest.checklistLong, tallest.caution, tallest.timer)).toBe(469);
  });

  it('runs on downward only beyond them', () => {
    const slots = layoutDock([
      item({ id: 'checklist', kind: 'checklist', updatedT: 9, height: 0.3 }),
      item({ id: 'timer', kind: 'timer', updatedT: 1, height: 0.08 }),
    ]);
    const last = slots.at(-1) as (typeof slots)[number];
    expect(slots.find((s) => s.id === 'timer')?.collapsed).toBe(true);
    expect(last.top + last.height).toBeGreaterThan(0.3);
  });

  it('leads with an open choice, else the latest done, else the latest update', () => {
    expect(
      leadOf([
        item({ id: 'timer', kind: 'timer', doneT: 50, updatedT: 10 }),
        item({ id: 'choices', kind: 'choices', open: true }),
      ]),
    ).toBe('choices');
    expect(
      leadOf([
        item({ id: 'timer', kind: 'timer', doneT: 50 }),
        item({ id: 'timer-2', kind: 'timer', doneT: 80 }),
        item({ id: 'value', kind: 'value', updatedT: 999 }),
      ]),
    ).toBe('timer-2');
    expect(
      leadOf([
        item({ id: 'value', kind: 'value', updatedT: 5 }),
        item({ id: 'progress', kind: 'progress', updatedT: 7 }),
      ]),
    ).toBe('progress');
    expect(leadOf([])).toBeNull();
  });
});

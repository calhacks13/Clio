import { describe, expect, it } from 'vitest';
import { recordedWidget } from '../../src/domain/widgets/record';
import {
  cleanText,
  hasText,
  matchItem,
  matchSpoken,
  normalise,
  sameLabel,
} from '../../src/domain/widgets/rules';
import { summarise, widgetLine } from '../../src/domain/widgets/summary';
import {
  type ChecklistWidget,
  type ChoicesWidget,
  FONT_COVERAGE,
  type TimerWidget,
  type Widget,
} from '../../src/domain/widgets/types';

// The widgets' text rules: what the coach writes is cleaned to what the fonts can draw, matched
// loosely when the coach or the learner names something, and summed up for the coach in one line.

/** Arrow, bullet and middle-dot symbols never reach the model (as in coach.test.ts). */
const SYMBOLS = /[→←↑↓➜⟶·•]/;

const base = {
  rev: 1,
  createdT: 1000,
  updatedT: 1000,
  status: 'active',
  doneT: null,
  closeAt: null,
  leaving: false,
  stepId: 'acid',
  scope: 'step',
} as const;

const timer = (over: Partial<TimerWidget> = {}): TimerWidget => ({
  ...base,
  id: 'timer',
  seq: 1,
  kind: 'timer',
  scope: 'lesson',
  label: 'Glue sets',
  durationMs: 120_000,
  endT: 121_000,
  objectId: null,
  ...over,
});

const checklist = (over: Partial<ChecklistWidget> = {}): ChecklistWidget => ({
  ...base,
  id: 'checklist',
  seq: 3,
  kind: 'checklist',
  title: 'Gather',
  items: [
    { text: 'funnel', done: true },
    { text: 'rag', done: false },
    { text: 'washer fluid', done: false },
  ],
  ...over,
});

const choices = (over: Partial<ChoicesWidget> = {}): ChoicesWidget => ({
  ...base,
  id: 'choices',
  seq: 4,
  kind: 'choices',
  question: 'Which screwdriver do you have?',
  options: ['Phillips', 'Flat'],
  chosen: null,
  chosenVia: null,
  expiresT: 91_000,
  ...over,
});

const covered = (text: string) =>
  [...text].every((char) => {
    const cp = char.codePointAt(0) ?? 0;
    return FONT_COVERAGE.some(([lo, hi]) => cp >= lo && cp <= hi);
  });

describe('cleanText', () => {
  it('drops emoji, ticks, control characters and variation selectors', () => {
    expect(cleanText('Glue sets 🔥')).toBe('Glue sets');
    expect(cleanText('✅ Done ✓')).toBe('Done');
    expect(cleanText('Hot ♨️ pan')).toBe('Hot pan');
    expect(cleanText('Cup\u0007 A\nis full')).toBe('Cup A is full');
    expect(cleanText('👍🏽')).toBe('');
  });

  it('writes the symbols the headset bans as words or spaces', () => {
    expect(cleanText('25 N·m')).toBe('25 N m');
    expect(cleanText('Funnel • rag')).toBe('Funnel rag');
    expect(cleanText('Cup A → cup B')).toBe('Cup A to cup B');
    expect(cleanText('≈5 min')).toBe('about 5 min');
    expect(cleanText('Wait ≈ 2 minutes')).toBe('Wait about 2 minutes');
    expect(cleanText('Wait≈2 min')).toBe('Wait about 2 min');
    expect(cleanText('Cup A⟶cup B')).toBe('Cup A to cup B');
    expect(cleanText('25 N⋅m, rag ∙ cloth')).toBe('25 N m, rag cloth');
  });

  it('keeps only characters every bundled face has, base letters for accents they lack', () => {
    expect(cleanText('Crème brûlée, 20 °C, 5 €, ½ cup')).toBe('Crème brûlée, 20 °C, 5 €, ½ cup');
    expect(cleanText('Dvořák')).toBe('Dvorák');
    expect(cleanText('Tea 茶 cup')).toBe('Tea cup');
    expect(cleanText('ﬁll it')).toBe('fill it');
    for (const text of ['Łódź ✓ 🔥 → ≈ 10 ℃', 'Ω resistor ‼', 'Ψ 2 × 3 − 1']) {
      expect(covered(cleanText(text))).toBe(true);
    }
  });

  it('never lets a character the fonts lack change what a number or a unit says', () => {
    // Fractions: the fraction slash is a slash, and a whole number keeps its space.
    expect(cleanText('⅓ cup')).toBe('1/3 cup');
    expect(cleanText('1⅓ cups, ⅞ in')).toBe('1 1/3 cups, 7/8 in');
    expect(cleanText('1⁄4 turn, 1∕2 inch')).toBe('1/4 turn, 1/2 inch');
    expect(cleanText('1½ cups, ¼ turn')).toBe('1½ cups, ¼ turn');
    // Powers: superscripts the fonts lack read as one, the ones they have stay.
    expect(cleanText('2⁵ and 10⁻³ m')).toBe('2^5 and 10^−3 m');
    expect(cleanText('10¹⁵ J')).toBe('10^15 J');
    expect(cleanText('5 m², 2 cm³')).toBe('5 m², 2 cm³');
    // Units: Greek mu is the micro sign, omega an ohm, a ring a degree.
    expect(cleanText('5 \u03bcL, 5 ㎕')).toBe('5 µL, 5 µl');
    expect(cleanText('220\u2126, 10 k\u03a9')).toBe('220 ohm, 10 kohm');
    expect(cleanText('20 ℃, 20˚C')).toBe('20 °C, 20°C');
    expect(cleanText('5‰ salt')).toBe('5 per 1000 salt');
    expect(cleanText('3′ 4″')).toBe(`3' 4"`);
    // Comparisons, ranges and ratios.
    expect(cleanText('≥ 5 mm, ≤ 2 cm')).toBe('at least 5 mm, at most 2 cm');
    expect(cleanText('pH ≠ 7')).toBe('pH not 7');
    expect(cleanText('∼5 min')).toBe('about 5 min');
    expect(cleanText('1‒2 min, 1‐2 min, 1‑2 min')).toBe('1–2 min, 1-2 min, 1-2 min');
    expect(cleanText('Mix 1∶2')).toBe('Mix 1:2');
    expect(covered(cleanText('⅓ 2⁵ 10⁻² \u03bc \u2126 ‰ ≥ ≤ ≠ ∼ ′ ″ ‒ ― ⁄ ∕ ∶ ˚ ㎕ ㏀'))).toBe(
      true,
    );
  });

  it('reads the other ways of writing a comparison, a rate or a degree as the usual ones', () => {
    // Dropped, each would leave the bare number.
    expect(cleanText('⩾ 5 mm, ⩽ 2 cm')).toBe('at least 5 mm, at most 2 cm');
    expect(cleanText('≧ 5 mm, ≦ 2 cm')).toBe('at least 5 mm, at most 2 cm');
    expect(cleanText('5‱ salt')).toBe('5 per 10000 salt');
    // A superscript zero before C or F is a degree, not a power: "20^0C" would be 1 C.
    expect(cleanText('20⁰C, 68 ⁰F')).toBe('20°C, 68 °F');
    expect(cleanText('10⁰ and 2⁰ⁿ')).toBe('10^0 and 2^0n');
    expect(covered(cleanText('⩾ ⩽ ≧ ≦ ‱ ⁰C'))).toBe(true);
  });

  it('keeps the "not" of a struck-through comparison', () => {
    // Its decomposition is the comparison and a stroke the fonts lack: without the stroke "≱ 5"
    // would read "at least 5", and "≯ 7" "> 7".
    expect(cleanText('≱ 5 mm, ≰ 2 cm')).toBe('not at least 5 mm, not at most 2 cm');
    expect(cleanText('pH ≯ 7, pH ≮ 7')).toBe('pH not > 7, pH not < 7');
    expect(cleanText('x ≁ 5, x ≉ 5')).toBe('x not about 5, x not about 5');
    expect(cleanText('pH ≢ 7')).toBe('pH not 7');
    expect(cleanText('pH ≠ 7')).toBe('pH not 7');
    expect(covered(cleanText('≱ ≰ ≯ ≮ ≁ ≉ ≢ ↛ ∉'))).toBe(true);
  });

  it('collapses whitespace and trims', () => {
    expect(cleanText('  Screws\t\tout  ')).toBe('Screws out');
  });

  it('turns shouting into sentence case, keeping one-letter words and a lone acronym', () => {
    expect(cleanText('CUP A IS FULL')).toBe('Cup A is full');
    expect(cleanText('PH')).toBe('PH');
    expect(cleanText('LED')).toBe('LED');
    expect(cleanText('Check the LED')).toBe('Check the LED');
    expect(cleanText('250 ML POURED')).toBe('250 ml poured');
    expect(cleanText('"HOT PAN" AHEAD')).toBe('"Hot pan" ahead');
  });

  it('strips one trailing period from labels, never a question mark or a sentence', () => {
    expect(cleanText('Gather.', 'label')).toBe('Gather');
    expect(cleanText('Wait...', 'label')).toBe('Wait...');
    expect(cleanText('Ready?', 'label')).toBe('Ready?');
    expect(cleanText('Stop!', 'label')).toBe('Stop!');
    expect(cleanText('The pan stays hot.')).toBe('The pan stays hot.');
  });

  it('knows when nothing readable is left', () => {
    expect(hasText(cleanText('🔥🔥'))).toBe(false);
    expect(hasText('...')).toBe(false);
    expect(hasText('5')).toBe(true);
  });
});

describe('matching', () => {
  it('normalises case, punctuation and spaces', () => {
    expect(normalise('  Glue, sets!  ')).toBe('glue sets');
    expect(sameLabel('Glue sets', 'glue  sets.')).toBe(true);
    expect(sameLabel('Glue sets', 'Glue set')).toBe(false);
  });

  it('matches a checklist entry exactly, by position or by unique whole-word containment', () => {
    const items = ['Small funnel', 'Rag', 'Washer fluid'];
    expect(matchItem(items, 'rag.')).toBe(1);
    expect(matchItem(items, '3')).toBe(2);
    expect(matchItem(items, '4')).toBeNull();
    expect(matchItem(items, 'funnel')).toBe(0);
    expect(matchItem(items, 'the washer fluid bottle')).toBe(2);
    expect(matchItem(items, 'fun')).toBeNull();
    expect(matchItem(items, '')).toBeNull();
  });

  it('gives null for an ambiguous entry', () => {
    expect(matchItem(['Red cup', 'Blue cup'], 'cup')).toBeNull();
    expect(matchItem(['Red cup', 'Blue cup'], 'blue')).toBe(1);
  });

  it.each([
    ['Phillips', 0],
    ['phillips.', 0],
    ['The flat one', 1],
    ['the second one', 1],
    ['second', 1],
    ['the first', 0],
    ['last', 1],
    ['the last one', 1],
    ['not the phillips', null],
    ['no, flat', null],
    ["I don't have a phillips", null],
    ['phillips or flat', null],
    ['the first one, the flat', null],
    ['wait a second', null],
    ['first let me look', null],
    ['the third one', null],
    ['I think I have the phillips one in the drawer', null],
    ['', null],
  ])('hears %j as option %j', (transcript, expected) => {
    expect(matchSpoken(['Phillips', 'Flat'], transcript)).toBe(expected);
  });

  it('matches multi-word options as whole words, and yes or no answers', () => {
    expect(matchSpoken(['Flat head', 'Phillips'], 'the flat head one')).toBe(0);
    expect(matchSpoken(['Flat head', 'Phillips'], 'flat')).toBeNull();
    expect(matchSpoken(['Yes', 'No'], 'No.')).toBe(1);
    expect(matchSpoken(['Yes', 'Not yet'], 'not yet')).toBe(1);
    expect(matchSpoken(['A', 'B', 'C'], 'the third one')).toBe(2);
    expect(matchSpoken(['A', 'B', 'C'], 'last one')).toBe(2);
  });
});

describe('the on_screen line', () => {
  it('names each widget by its id, with what it shows', () => {
    const t = 9_000;
    const lines: [Widget, string][] = [
      [timer(), 'timer "Glue sets" 1:52 left'],
      [timer({ id: 'timer-2', label: 'Paint', status: 'done' }), 'timer-2 "Paint" done'],
      [
        {
          ...base,
          id: 'progress',
          seq: 2,
          kind: 'progress',
          label: 'Screws out',
          value: 3,
          total: 4,
          unit: null,
        },
        'progress "Screws out" 3 of 4',
      ],
      [
        {
          ...base,
          id: 'progress',
          seq: 2,
          kind: 'progress',
          label: 'Poured',
          value: 250,
          total: 250,
          unit: 'mL',
          status: 'done',
        },
        'progress "Poured" 250 of 250 mL done',
      ],
      [checklist(), 'checklist "Gather" 1 of 3 done, left: rag, washer fluid'],
      [
        checklist({
          items: [
            { text: 'funnel', done: true },
            { text: 'rag', done: true },
          ],
        }),
        'checklist "Gather" 2 of 2 done',
      ],
      [choices(), 'choices "Which screwdriver do you have?" waiting'],
      [
        choices({ chosen: 0, chosenVia: 'touch', status: 'done' }),
        'choices "Which screwdriver do you have?" answered "Phillips"',
      ],
      [
        { ...base, id: 'value', seq: 5, kind: 'value', label: 'Torque', value: '25 N m' },
        'value "Torque" 25 N m',
      ],
      [
        {
          ...base,
          id: 'caution',
          seq: 6,
          kind: 'caution',
          scope: 'lesson',
          text: 'The pan stays hot for 10 minutes',
        },
        'caution "The pan stays hot for 10 minutes"',
      ],
    ];
    for (const [w, line] of lines) {
      expect(widgetLine(w, t)).toBe(line);
      expect(line).not.toMatch(SYMBOLS);
    }
    expect(summarise([timer(), checklist()], t)).toBe(
      'timer "Glue sets" 1:52 left; checklist "Gather" 1 of 3 done, left: rag, washer fluid',
    );
  });

  it('says nothing when nothing shows, and caps a long line at 600 characters', () => {
    expect(summarise([], 0)).toBeNull();
    const long = Array.from({ length: 12 }, (_, i) =>
      checklist({
        id: `checklist-${i}`,
        title: 'Safety gear',
        items: [
          { text: 'an item with a long name', done: false },
          { text: 'another long item name', done: false },
        ],
      }),
    );
    const line = summarise(long, 0) ?? '';
    expect(line.length).toBeLessThanOrEqual(600);
    expect(line.length).toBeGreaterThan(590);
    expect(line.endsWith('…')).toBe(true);
    expect(line).not.toMatch(SYMBOLS);
  });
});

describe('recordedWidget', () => {
  it('records no absolute time, and a timer with the time it had left at t', () => {
    const w = timer({ objectId: 'cup_a' });
    expect(recordedWidget(w, 31_000.4)).toEqual({
      id: 'timer',
      seq: 1,
      kind: 'timer',
      status: 'active',
      scope: 'lesson',
      stepId: 'acid',
      label: 'Glue sets',
      durationMs: 120_000,
      remainingMs: 90_000,
      objectId: 'cup_a',
    });
    expect(recordedWidget(w, 200_000)).toMatchObject({ remainingMs: 0 });
    expect(recordedWidget(timer({ status: 'done' }), 0)).toMatchObject({ remainingMs: 0 });
    for (const record of [recordedWidget(checklist(), 0), recordedWidget(choices(), 0)]) {
      for (const key of ['createdT', 'updatedT', 'doneT', 'closeAt', 'endT', 'expiresT', 'rev']) {
        expect(record).not.toHaveProperty(key);
      }
    }
    expect(recordedWidget(choices({ chosen: 1, chosenVia: 'voice' }), 0)).toEqual({
      id: 'choices',
      seq: 4,
      kind: 'choices',
      status: 'active',
      scope: 'step',
      stepId: 'acid',
      question: 'Which screwdriver do you have?',
      options: ['Phillips', 'Flat'],
      chosen: 1,
      chosenVia: 'voice',
    });
  });
});

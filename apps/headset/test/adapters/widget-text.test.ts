import { Group } from 'three';
import { describe, expect, it } from 'vitest';
import { FONT_METRICS, SHARED_CHARS } from '../../src/adapters/render/widgets/font-metrics';
import { digitCell, TabularText, tabularSlots } from '../../src/adapters/render/widgets/tabular';
import {
  ELLIPSIS,
  FIT,
  fitLine,
  fitValue,
  measure,
  wrap,
} from '../../src/adapters/render/widgets/text-layout';
import {
  type FaceId,
  type FakeTextObject,
  fakeText,
} from '../../src/adapters/render/widgets/text-port';
import { MM } from '../../src/adapters/render/widgets/theme';
import { FONT_COVERAGE } from '../../src/domain/widgets/types';

// The widgets lay their text out themselves against generated font metrics, so a card knows its
// height on the first frame; troika only rasterises the lines it is given.

const FACES: readonly FaceId[] = ['inter400', 'inter500', 'inter600', 'interTight600'];

describe('font metrics', () => {
  it('pins the advances the layout depends on', () => {
    const tight = FONT_METRICS.interTight600.advances;
    expect(tight['0']).toBeCloseTo(0.63, 3);
    expect(tight['1']).toBeCloseTo(0.385, 3);
    expect(tight[':']).toBeCloseTo(0.282, 3);
    expect(FONT_METRICS.inter400.advances['4']).toBeCloseTo(0.646, 3);
  });

  it('has every code point widget text is cleaned to, in every face', () => {
    for (const [from, to] of FONT_COVERAGE) {
      for (let code = from; code <= to; code++) {
        const ch = String.fromCodePoint(code);
        expect(SHARED_CHARS.includes(ch), `U+${code.toString(16)}`).toBe(true);
        for (const face of FACES) {
          expect(FONT_METRICS[face].advances[ch], `${face} U+${code.toString(16)}`).toBeGreaterThan(
            0,
          );
        }
      }
    }
  });

  it('reads the vertical metrics troika reads', () => {
    for (const face of FACES) {
      const m = FONT_METRICS[face];
      expect(m.ascender).toBeGreaterThan(m.capHeight);
      expect(m.descender).toBeLessThan(0);
    }
  });
});

describe('wrap', () => {
  it('breaks the measured examples where the spec says', () => {
    expect(wrap('Which screwdriver do you have?', 'title', 148 * MM, 2).lines).toEqual([
      'Which screwdriver',
      'do you have?',
    ]);
    expect(wrap('Washer fluid bottle', 'body', 120 * MM, 2).lines).toHaveLength(2);
    expect(wrap('Funnel', 'body', 120 * MM, 2)).toMatchObject({
      lines: ['Funnel'],
      truncated: false,
    });
  });

  it('keeps every line within 97% of the box', () => {
    const text = 'Keep your fingers clear of the blade until it has stopped spinning completely';
    const { lines } = wrap(text, 'strong', 118 * MM);
    for (const line of lines) expect(measure(line, 'strong')).toBeLessThanOrEqual(118 * MM * FIT);
    expect(lines.join(' ')).toBe(text);
  });

  it('ends the last allowed line with an ellipsis', () => {
    const text = 'Keep your fingers clear of the blade until it has stopped spinning completely';
    const wrapped = wrap(text, 'strong', 118 * MM, 4);
    expect(wrapped.lines).toHaveLength(4);
    expect(wrapped.truncated).toBe(true);
    expect(wrapped.lines[3]?.endsWith(ELLIPSIS)).toBe(true);
    expect(measure(wrapped.lines[3] ?? '', 'strong')).toBeLessThanOrEqual(118 * MM * FIT);
    expect(fitLine('The pan stays hot for 10 minutes', 'strong', 60 * MM).endsWith(ELLIPSIS)).toBe(
      true,
    );
  });

  it('breaks a word too long for a line between characters', () => {
    const { lines } = wrap('Supercalifragilisticexpialidocious', 'body', 60 * MM);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join('')).toBe('Supercalifragilisticexpialidocious');
  });

  it('gives a height of lines times the line height', () => {
    expect(wrap('Gather', 'title', 148 * MM).height).toBeCloseTo(16 * 1.25 * MM, 9);
  });
});

describe('fitValue', () => {
  it('steps the figure down from 22 mm, then wraps at 18 mm, and never cuts it', () => {
    expect(fitValue('25 N m', 148 * MM)).toMatchObject({ size: 22 * MM, lines: ['25 N m'] });
    const long = fitValue('1,250.5 kPa', 148 * MM);
    expect(long.lines).toEqual(['1,250.5 kPa']);
    for (const value of [
      '25 N m',
      '1,250.5 kPa',
      '9999.99 mmHg',
      'WWWWWWWWWWWWWWWW',
      'a b c d e f g h',
    ]) {
      const fit = fitValue(value, 148 * MM);
      expect(fit.lines.join('').replaceAll(' ', '')).toBe(value.replaceAll(' ', ''));
      expect(fit.lines.some((l) => l.includes(ELLIPSIS))).toBe(false);
      expect(fit.size).toBeGreaterThanOrEqual(18 * MM);
    }
    expect(fitValue('WWWWWWWWWWWWWWWW', 148 * MM)).toMatchObject({ size: 18 * MM });
  });
});

describe('tabular digits', () => {
  it('gives every digit the widest digit cell, so positions depend only on which are digits', () => {
    const cell = digitCell('display');
    expect(cell).toBeCloseTo(0.63 * 24 * MM, 4);
    const x = (s: string) => tabularSlots(s, 'display').map((slot) => slot.x);
    expect(x('1:11')).toEqual(x('8:88'));
    expect(x('9:59')).toEqual(x('0:00'));
    const colon = (FONT_METRICS.interTight600.advances[':'] ?? 0) * 24 * MM;
    expect(x('9:59')).toEqual(
      [0, cell, cell + colon, 2 * cell + colon].map((v) => expect.closeTo(v, 9)),
    );
    expect(x('10:00')).toEqual(
      [0, cell, 2 * cell, 2 * cell + colon, 3 * cell + colon].map((v) => expect.closeTo(v, 9)),
    );
    // 60:00 fits the timer's 92 mm text column.
    const last = tabularSlots('60:00', 'display').at(-1);
    expect((last?.x ?? 0) + (last?.width ?? 0)).toBeLessThan(92 * MM);
  });

  it('re-sets only the cells whose character changed', () => {
    const clock = new TabularText(fakeText, 'display', 5);
    new Group().add(clock.object);
    const cells = clock.object.children as FakeTextObject[];
    clock.set('9:59');
    expect(cells.map((c) => c.text)).toEqual(['9', ':', '5', '9', '']);
    const before = cells.map((c) => c.syncs);
    clock.set('9:58');
    expect(cells.map((c, i) => c.syncs - (before[i] ?? 0))).toEqual([0, 0, 0, 1, 0]);
    const xs = cells.map((c) => c.position.x);
    clock.set('9:51');
    expect(cells.map((c) => c.position.x)).toEqual(xs);
    clock.set('10:00');
    expect(cells.map((c) => c.text)).toEqual(['1', '0', ':', '0', '0']);
  });
});

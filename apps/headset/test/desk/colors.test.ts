import { describe, expect, it } from 'vitest';
import { DARK_TEXT, erStroke, hex, NEUTRAL, objectStyle, rgba } from '../../src/desk/colors';
import { ACCENTS, HINT_OPACITY, styledAccent } from '../../src/domain/overlay/accents';

// The desk draws each object in the headset's role colors (domain/overlay/accents.ts).

describe('color strings', () => {
  it('writes an accent as #rrggbb and as rgba', () => {
    expect(hex(ACCENTS.act)).toBe('#24d4ed');
    expect(hex(0x0000ff)).toBe('#0000ff');
    expect(rgba(ACCENTS.destination, 0.5)).toBe('rgba(255, 210, 63, 0.5)');
    expect(rgba(ACCENTS.stop, 2)).toBe('rgba(255, 90, 90, 1)');
  });
});

describe('objectStyle', () => {
  it('lights a shown object in its role color: fill, glow, box and tag', () => {
    const style = objectStyle(true, styledAccent(ACCENTS.destination, null), 'tracking');
    expect(style.stroke).toBe('rgba(255, 210, 63, 1)');
    expect(style.fill).toBe('rgba(255, 210, 63, 0.2)');
    expect(style.glow).toBe('rgba(255, 210, 63, 0.85)');
    expect(style.box).toBe(style.stroke);
    expect(style.tagText).toBe(DARK_TEXT);
    expect(style.dashed).toBe(false);
  });

  it('draws an object followed only for the recording as a thin neutral line', () => {
    const style = objectStyle(false, styledAccent(ACCENTS.act, null), 'tracking');
    expect(style.stroke).toBe(NEUTRAL);
    expect(style.fill).toBeNull();
    expect(style.glow).toBeNull();
    expect(style.lineWidth).toBeLessThan(
      objectStyle(true, styledAccent(ACCENTS.act, null), null).lineWidth,
    );
  });

  it('a coach hint is the softer white glow; a warning is red', () => {
    const hint = objectStyle(true, styledAccent(ACCENTS.act, 'attention'), 'tracking');
    expect(hint.stroke).toBe(`rgba(242, 246, 250, ${HINT_OPACITY})`);
    const warning = objectStyle(true, styledAccent(ACCENTS.act, 'warning'), 'tracking');
    expect(warning.stroke).toBe('rgba(255, 90, 90, 1)');
  });

  it('dashes an object the tracker only predicts (coasting)', () => {
    expect(objectStyle(true, styledAccent(ACCENTS.act, null), 'coasting').dashed).toBe(true);
    expect(objectStyle(false, styledAccent(ACCENTS.act, null), 'coasting').dashed).toBe(true);
  });
});

describe('erStroke', () => {
  const accent = { color: ACCENTS.level, opacity: 1 };

  it("draws ER's box in a lit object's color, neutral on one only followed, act on an unknown one", () => {
    expect(erStroke({ accent, lit: true }, 1)).toBe('rgba(61, 220, 132, 1)');
    expect(erStroke({ accent, lit: false }, 1)).toBe('rgba(232, 238, 252, 0.62)');
    expect(erStroke(null, 1)).toBe('rgba(36, 212, 237, 1)');
  });

  it('fades with the answer', () => {
    expect(erStroke({ accent, lit: true }, 0.5)).toBe('rgba(61, 220, 132, 0.5)');
    expect(erStroke({ accent, lit: false }, 0.5)).toBe('rgba(232, 238, 252, 0.31)');
  });
});

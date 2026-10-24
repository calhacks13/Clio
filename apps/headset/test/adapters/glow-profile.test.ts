import { describe, expect, it } from 'vitest';
import { glowProfile } from '../../src/adapters/render/glow/profile';
import { HighlightMask } from '../../src/adapters/render/highlight-mask';

describe('glowProfile', () => {
  it('scales one look from a screw head to a whole tool, within bounds', () => {
    const screw = glowProfile(0.02, 0.02, 'surface');
    const caliper = glowProfile(0.25, 0.08, 'object');
    expect(screw.edge).toBeGreaterThanOrEqual(0.0015);
    expect(caliper.edge).toBeLessThanOrEqual(0.0075);
    expect(caliper.halo).toBeGreaterThan(screw.halo);
    expect(caliper.halo).toBeLessThanOrEqual(0.04);
    expect(caliper.thickness).toBeLessThanOrEqual(0.024);
  });

  it('keeps a part on its surface and lets a whole object spill light', () => {
    const part = glowProfile(0.1, 0.05, 'surface');
    const whole = glowProfile(0.1, 0.05, 'object');
    expect(part.spill).toBeLessThan(whole.spill);
    expect(part.halo).toBeLessThan(whole.halo);
    expect(part.thickness).toBeLessThanOrEqual(0.003);
    expect(whole.thickness).toBeGreaterThan(part.thickness);
  });

  it('pads the field for the flared bloom, and never makes the edge finer than a field texel', () => {
    for (const [w, h] of [
      [0.01, 0.01],
      [0.3, 0.02],
      [1.2, 0.5],
    ] as const) {
      const p = glowProfile(w, h, 'object');
      expect(p.padding).toBeGreaterThan(p.halo * 4.5);
      expect(p.edge).toBeGreaterThan((Math.max(w, h) + 2 * p.padding) / HighlightMask.SIZE);
    }
  });

  it('writes into the profile it is given', () => {
    const out = glowProfile(0.1, 0.1, 'surface');
    expect(glowProfile(0.2, 0.1, 'object', out)).toBe(out);
    expect(out.spill).toBe(1);
  });
});

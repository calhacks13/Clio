import { describe, expect, it } from 'vitest';
import {
  formatClock,
  formatCount,
  formatNumber,
  timerRemaining,
} from '../../src/domain/widgets/format';

describe('widget formats', () => {
  it('reads a clock rounded up, so a running timer never says 0:00', () => {
    expect(formatClock(120_000)).toBe('2:00');
    expect(formatClock(119_001)).toBe('2:00');
    expect(formatClock(119_000)).toBe('1:59');
    expect(formatClock(61_000)).toBe('1:01');
    expect(formatClock(1)).toBe('0:01');
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(-500)).toBe('0:00');
    expect(formatClock(3_600_000)).toBe('60:00');
  });

  it('writes whole numbers plainly and anything else with one decimal', () => {
    expect(formatNumber(3)).toBe('3');
    expect(formatNumber(2.5)).toBe('2.5');
    expect(formatNumber(2.04)).toBe('2');
    expect(formatNumber(0.25)).toBe('0.3');
  });

  it('counts toward a target, with a unit for amounts', () => {
    expect(formatCount(3, 4, null)).toBe('3 of 4');
    expect(formatCount(120, 250, 'mL')).toBe('120 of 250 mL');
    expect(formatCount(1.5, 2, 'L')).toBe('1.5 of 2 L');
  });

  it('gives the time left on a timer, and none once it is done', () => {
    const running = { status: 'active' as const, endT: 10_000 };
    expect(timerRemaining(running, 4_000)).toBe(6_000);
    expect(timerRemaining(running, 12_000)).toBe(0);
    expect(timerRemaining({ status: 'done', endT: 10_000 }, 4_000)).toBe(0);
  });
});

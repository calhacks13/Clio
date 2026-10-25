import type { TimerWidget } from './types';

// How widget numbers read, the same on the learner's screen and in what the coach hears.

/** Time left on a timer at t (ms, >= 0); 0 once done. */
export function timerRemaining(w: Pick<TimerWidget, 'status' | 'endT'>, t: number): number {
  return w.status === 'done' ? 0 : Math.max(0, w.endT - t);
}

/** m:ss, rounded up, so a running timer never reads 0:00: 119001 ms is "2:00", 1 ms "0:01". */
export function formatClock(ms: number): string {
  const s = Math.ceil(Math.max(0, ms) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** A whole number as is, anything else with one decimal: 3, 2.5. */
export function formatNumber(n: number): string {
  const tenths = Math.round(n * 10) / 10;
  return Number.isInteger(tenths) ? String(tenths) : tenths.toFixed(1);
}

/** "3 of 4", or "120 of 250 mL" with a unit. */
export function formatCount(value: number, total: number, unit: string | null): string {
  const count = `${formatNumber(value)} of ${formatNumber(total)}`;
  return unit ? `${count} ${unit}` : count;
}

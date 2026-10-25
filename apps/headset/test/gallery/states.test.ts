import { describe, expect, it } from 'vitest';
import { renderBoot } from '../../src/app/boot-view';
import { Emitter } from '../../src/core/emitter';
import type { AppEvents } from '../../src/domain/events';
import { OverlayModel } from '../../src/domain/overlay/overlay-model';
import { LAUNCH_STATES, PANEL_STATES } from '../../src/gallery/states';

// The UI gallery's states (gallery.html) are data; a broken entry should fail here, not show up
// as a blank frame.

/** Bullets, middle dots and arrows, which Clio's UI text never uses. */
const BANNED = /[·•←-↓➔➜⟶]/;

/** What the real overlay model hands the presenters, as the reference shape. */
function realSnapshot() {
  const model = new OverlayModel(new Emitter<AppEvents>(), {
    procedure: () => null,
    label: (id) => id,
    plan: () => null,
  });
  return model.snapshot(0);
}

describe('gallery launch states', () => {
  it('renders every state', () => {
    expect(LAUNCH_STATES.length).toBeGreaterThanOrEqual(6);
    for (const state of LAUNCH_STATES) {
      expect(renderBoot(state.model), state.name).toMatch(/<main[\s>]/);
    }
  });

  it('names each state once and shows some at phone width', () => {
    const names = LAUNCH_STATES.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    expect(LAUNCH_STATES.some((s) => s.phone)).toBe(true);
  });
});

describe('gallery launch progress states', () => {
  it('show every way the button narrates a start', () => {
    const names = LAUNCH_STATES.filter((s) => s.after).map((s) => s.name);
    expect(names).toEqual([
      'Asking for microphone and camera',
      'Entering AR',
      'In AR',
      'Could not start',
    ]);
  });
});

describe('gallery panel states', () => {
  const keys = Object.keys(realSnapshot()).sort();

  it('names each state once', () => {
    const names = PANEL_STATES.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('gives every state a snapshot shaped like the overlay model’s', () => {
    for (const { name, snapshot } of PANEL_STATES) {
      expect(Object.keys(snapshot).sort(), name).toEqual(keys);
      const step = snapshot.instruction;
      if (step) {
        expect(step.text, name).not.toBe('');
        expect(step.index, name).toBeLessThan(step.total);
        expect(step.progress, name).toBeGreaterThanOrEqual(0);
        expect(step.progress, name).toBeLessThanOrEqual(1);
      }
      if (snapshot.toast) expect(snapshot.toast.text, name).not.toBe('');
      if (snapshot.caption) expect(snapshot.caption.text, name).not.toBe('');
    }
  });

  it('covers every coach connection state, both directions of speech and thinking', () => {
    const coach = new Set(PANEL_STATES.map((s) => s.snapshot.coach));
    for (const state of ['connecting', 'ready', 'reconnecting', 'error', 'off'] as const) {
      expect(coach.has(state), state).toBe(true);
    }
    const voice = new Set(PANEL_STATES.map((s) => s.snapshot.voice));
    expect([...voice].sort()).toEqual(['hearing', 'quiet', 'speaking', 'thinking']);
  });

  it('uses no bullet, middle-dot or arrow characters in its text', () => {
    for (const { name, snapshot, calibration } of PANEL_STATES) {
      const text = JSON.stringify({ snapshot, calibration });
      expect(text, name).not.toMatch(BANNED);
    }
  });
});

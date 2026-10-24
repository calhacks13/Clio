import { describe, expect, it } from 'vitest';
import type { AgentState } from '../../src/domain/coach/agent';
import type { CoachVoice, LessonPhase } from '../../src/domain/events';
import { coachStatus } from '../../src/domain/overlay/coach-status';

const status = (coach: AgentState | 'off', voice: CoachVoice, phase: LessonPhase = 'lesson') =>
  coachStatus({ coach, voice, phase });

describe('coachStatus', () => {
  it.each([
    // The connection outranks the conversation, and the conversation outranks planning.
    ['error', 'speaking', 'planning', 'offline', 'Voice offline'],
    ['closed', 'hearing', 'lesson', 'offline', 'Voice offline'],
    ['connecting', 'speaking', 'lesson', 'connecting', 'Connecting'],
    ['reconnecting', 'hearing', 'planning', 'connecting', 'Connecting'],
    ['ready', 'speaking', 'planning', 'speaking', 'Speaking'],
    ['ready', 'hearing', 'planning', 'hearing', 'Listening'],
    ['ready', 'quiet', 'planning', 'planning', 'Planning'],
    ['ready', 'quiet', 'lesson', 'listening', 'Listening'],
    ['ready', 'quiet', 'idle', 'listening', 'Listening'],
  ] as const)('%s, %s while %s: %s', (coach, voice, phase, state, label) => {
    expect(status(coach, voice, phase)).toEqual({ state, label });
  });

  it('shows nothing without a coach that hears: none, or the scripted one', () => {
    expect(status('off', 'off')).toBeNull();
    expect(status('off', 'quiet')).toBeNull();
    expect(status('ready', 'off')).toBeNull();
    expect(status('error', 'off')).toBeNull();
  });

  it('answers every frame with the same objects', () => {
    expect(status('ready', 'quiet')).toBe(status('ready', 'quiet'));
  });

  it('labels in a word or two, with no bullet, middle-dot or arrow symbols', () => {
    for (const coach of ['ready', 'connecting', 'error'] as const) {
      for (const voice of ['quiet', 'hearing', 'speaking'] as const) {
        const label = status(coach, voice)?.label ?? '';
        expect(label.split(' ').length).toBeLessThanOrEqual(2);
        expect(label).not.toMatch(/[·•←-⇿➔➜⟶]/);
      }
    }
  });
});

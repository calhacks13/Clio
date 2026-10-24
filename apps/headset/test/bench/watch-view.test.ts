import { ProcedureSchema } from '@clio/protocol';
import { describe, expect, it } from 'vitest';
import { type WatchLook, WatchSession } from '../../src/bench/live-watch';
import {
  AS_FAST_AS_IT_ANSWERS,
  renderSaveTest,
  renderWatchControls,
  renderWatchLog,
  renderWatchStatus,
  stepBadge,
  suggestedExpect,
} from '../../src/bench/watch-view';

// The live watch panel: the cadence, how far along a step looks, wrong answers, the point that
// decided a look, and the form that keeps a look as a watcher test.

const { steps } = ProcedureSchema.parse({
  schema: 'clio.procedure/1',
  id: 'fridge',
  version: 1,
  title: 'Yogurt drink',
  summary: 'Get a yogurt drink.',
  workspace: { size: [0.8, 0.6] },
  objects: [{ id: 'yogurt', label: 'yogurt drink', placement: { method: 'detect' } }],
  steps: [
    {
      id: 'take',
      instruction: 'Take the yogurt drink.',
      doneWhen: 'The learner holds the pink bottle.',
      success: { type: 'confirm' },
    },
    { id: 'close', instruction: 'Close the door.', success: { type: 'confirm' } },
  ],
});

const IMAGE = 'data:image/jpeg;base64,bm93';
const BEFORE = 'data:image/jpeg;base64,YmVmb3Jl';
const asked = {
  step: { id: 'take', instruction: 'Take the yogurt drink.', doneWhen: 'Holds the <pink> bottle.' },
  objects: [{ id: 'yogurt', label: 'yogurt drink', look: 'small pink bottle' }],
  confusions: ['the milk carton'],
};
const AUTO = { autoAdvance: true, needed: 2 };
const status = { now: 5000, paused: false, looking: false, needed: 2, suggest: false };

function milkLook(): WatchLook {
  return {
    at: 3000,
    step: 0,
    verdict: 'not_done',
    observation: 'holding a white carton',
    progress: 35,
    wrong: 'picked up the milk, not the yogurt drink',
    evidence: { label: 'milk carton', point: [0.25, 0.6] },
    latencyMs: 1200,
    model: 'gemini-robotics-er-2-preview',
    asked,
    image: IMAGE,
    before: BEFORE,
  };
}

describe('renderWatchControls', () => {
  it('offers looking as fast as the model answers, chosen by default', () => {
    const html = renderWatchControls({
      paused: false,
      complete: false,
      intervalMs: AS_FAST_AS_IT_ANSWERS,
      autoAdvance: true,
      needed: 2,
      model: 'gemini-robotics-er-2-preview',
      models: ['gemini-robotics-er-2-preview'],
    });
    expect(html).toContain(
      '<option value="0" selected>as fast as it answers (like the headset)</option>',
    );
    expect(html).toContain('<option value="6000" >every 6 s</option>');
    expect(html).toContain('<option value="2" selected>2 “done” in a row</option>');
  });
});

describe('renderWatchStatus', () => {
  it('shows a wrong answer in red, how far along the step looks, and where it looked', () => {
    const s = new WatchSession(steps, 0);
    s.record(milkLook(), AUTO);
    const html = renderWatchStatus(s, 'Yogurt drink', status);
    expect(html).toContain(
      '<p class="watch-wrong">Wrong: picked up the milk, not the yogurt drink</p>',
    );
    expect(html).toContain('<span class="badge fail">1 wrong</span>');
    expect(html).toContain('style="width:35%"');
    expect(html).toContain('Looks 35% along.');
    expect(html).toContain('style="--along:35%"');
    expect(html).toContain('class="evidence" style="left:25.0%;top:60.0%" title="milk carton"');
    expect(html).toContain('<span class="evidence-label"');
    expect(html).toContain('Decided by: milk carton');
  });

  it('shows a hazard the watcher noticed, whatever the step', () => {
    const s = new WatchSession(steps, 0);
    s.record({ ...milkLook(), hazard: 'kitchen knife by cup A' }, AUTO);
    expect(renderWatchStatus(s, 'Yogurt drink', status)).toContain(
      '<span class="verdict hazard">hazard</span> kitchen knife by cup A',
    );
  });

  it('works without the new fields', () => {
    const s = new WatchSession(steps, 0);
    s.record({ at: 1000, step: 0, verdict: 'not_done', observation: 'fridge closed' }, AUTO);
    const html = renderWatchStatus(s, 'Yogurt drink', status);
    expect(html).not.toContain('watch-wrong');
    expect(html).not.toContain('step-meter');
    expect(html).not.toContain('evidence');
    expect(html).toContain('not done</span> fridge closed');
  });
});

describe('renderWatchLog', () => {
  it('counts the wrong answers and offers to save each look with its frame', () => {
    const s = new WatchSession(steps, 0);
    s.record(milkLook(), AUTO);
    s.record({ at: 4000, step: 0, error: 'timeout' }, AUTO);
    const html = renderWatchLog(s);
    expect(html).toContain('<summary>Every look (2, 1 wrong)</summary>');
    expect(html).toContain('<li class="wrong">');
    expect(html.match(/data-watch="save-test"/g)).toHaveLength(1);
    expect(html).toContain('data-look="1"');
  });
});

describe('renderSaveTest', () => {
  it('shows both frames, the hints and what it said, and suggests the expected answer', () => {
    const look = milkLook();
    look.n = 7;
    const html = renderSaveTest(look, 'Get a <yogurt> drink');
    expect(html).toContain('Save look 7 as a watcher test');
    expect(html).toContain(`<img src="${BEFORE}"`);
    expect(html).toContain(`<img src="${IMAGE}"`);
    expect(html).toContain('Get a &#60;yogurt&#62; drink');
    expect(html).toContain('Holds the &#60;pink&#62; bottle.');
    expect(html).toContain('<strong>yogurt drink</strong>: small pink bottle');
    expect(html).toContain('the milk carton');
    expect(html).toContain('value="wrong" checked');
    expect(html).toContain('value="Take the yogurt drink. (said not done)"');
  });

  it('suggests the opposite of what the watcher said', () => {
    expect(suggestedExpect({ at: 0, step: 0, verdict: 'done' })).toBe('not_done');
    expect(suggestedExpect({ at: 0, step: 0, verdict: 'not_done' })).toBe('done');
    expect(suggestedExpect({ at: 0, step: 0, verdict: 'done', wrong: 'milk' })).toBe('wrong');
    expect(renderSaveTest({ at: 0, step: 0, verdict: 'done' }, 'goal')).toBe('');
  });
});

describe('stepBadge', () => {
  it('shows how far along the step being done is', () => {
    expect(stepBadge({ status: 'todo', percent: 60 }, true)).toContain('doing now · 60%');
    expect(stepBadge({ status: 'done', by: 'watcher' }, false)).toContain('seen done');
  });
});

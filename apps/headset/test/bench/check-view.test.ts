import type { BenchCheckRun, BenchCheckTestDetail, BenchCheckTestSummary } from '@clio/protocol';
import { describe, expect, it } from 'vitest';
import {
  renderCheckRun,
  renderCheckTestDetail,
  renderCheckTestItem,
  renderTallies,
} from '../../src/bench/check-view';

// The watcher tests in the library: passes per model, a test opened up, and each answer.

const summary: BenchCheckTestSummary = {
  id: 'milk',
  title: 'Milk <not> yogurt',
  goal: 'Get a yogurt drink',
  instruction: 'Take the yogurt drink.',
  expect: 'wrong',
  thumb: 'now-1.jpg',
  hasBefore: true,
  createdAt: '2026-10-24T03:15:02.000Z',
  runCount: 4,
  models: [
    { model: 'gemini-robotics-er-2-preview', runs: 3, passed: 3 },
    { model: 'gemini-3.8-flash', runs: 1, passed: 0 },
  ],
  lastRun: null,
};

const failedRun: BenchCheckRun = {
  id: 'run-1',
  createdAt: '2026-10-24T03:16:00.000Z',
  model: 'gemini-3.8-flash',
  latencyMs: 1400,
  expect: 'wrong',
  result: { ok: true, answer: { verdict: 'done', observation: 'holding a carton' } },
  passed: false,
};

describe('watcher test list', () => {
  it('shows the expected answer and the passes per model', () => {
    const html = renderCheckTestItem(summary, '/frame.jpg');
    expect(html).toContain('Milk &#60;not&#62; yogurt');
    expect(html).toContain('should say wrong');
    expect(html).toContain('before + now');
    expect(html).toContain('<span class="badge pass"');
    expect(html).toContain('robotics-er-2-preview 3/3');
    expect(html).toContain('<span class="badge fail"');
    expect(html).toContain('aria-expanded="false"');
    expect(renderTallies([])).toContain('not run');
  });

  it('opens a test with its frames, hints, expectation and answers', () => {
    const detail: BenchCheckTestDetail = {
      test: {
        id: 'milk',
        title: 'Milk',
        expect: 'wrong',
        goal: 'Get a yogurt drink',
        step: { id: 'take', instruction: 'Take the yogurt drink.', doneWhen: 'Holds it.' },
        objects: [{ id: 'yogurt', label: 'yogurt drink', look: 'small pink bottle' }],
        confusions: ['the milk carton'],
        before: [{ file: 'before-1.jpg', mimeType: 'image/jpeg' }],
        now: [{ file: 'now-1.jpg', mimeType: 'image/jpeg' }],
        seen: {
          verdict: 'done',
          observation: 'holding a carton',
          model: 'gemini-robotics-er-2-preview',
          latencyMs: 1100,
        },
        createdAt: '2026-10-24T03:15:02.000Z',
        updatedAt: '2026-10-24T03:15:02.000Z',
      },
      runs: [failedRun],
    };
    const options = { frameUrl: (f: string) => `/frames/${f}`, running: [], models: ['m1', 'm2'] };
    const html = renderCheckTestItem(summary, '/t.jpg', renderCheckTestDetail(detail, options));
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('src="/frames/before-1.jpg"');
    expect(html).toContain('src="/frames/now-1.jpg"');
    expect(html).toContain('<option value="wrong" selected>wrong</option>');
    expect(html).toContain('When saved, robotics-er-2-preview said');
    expect(html).toContain('Run with 2 models');
    expect(html).toContain('<li class="fail"');
    const running = renderCheckTestDetail(detail, { ...options, running: ['gemini-3.8-flash'] });
    expect(running).toContain('Running with 3.8-flash…');
  });

  it('shows a failed call as a failed answer', () => {
    const html = renderCheckRun({
      ...failedRun,
      result: { ok: false, code: 'upstream_failed', message: 'Step check failed: quota' },
    });
    expect(html).toContain('<span class="verdict fail">failed</span> Step check failed: quota');
    expect(renderCheckRun({ ...failedRun, passed: true })).toContain('<li class="pass"');
  });
});

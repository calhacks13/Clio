import type { BenchCheckTest } from '@clio/protocol';
import { describe, expect, it } from 'vitest';
import { checkPasses, checkTestRequest } from '../src/services/bench-checks';

// Watcher tests: when an answer meets what the tester expected, and the request they replay.

const answer = (verdict: 'done' | 'not_done' | 'unsure', wrong?: string) => ({
  verdict,
  observation: 'a white carton in hand',
  ...(wrong === undefined ? {} : { wrong }),
});

describe('checkPasses', () => {
  it('needs a clean "done" for done, and anything else for not done', () => {
    expect(checkPasses('done', answer('done'))).toBe(true);
    expect(checkPasses('done', answer('unsure'))).toBe(false);
    expect(checkPasses('done', answer('done', 'picked up the milk'))).toBe(false);
    expect(checkPasses('not_done', answer('not_done'))).toBe(true);
    expect(checkPasses('not_done', answer('unsure'))).toBe(true);
    expect(checkPasses('not_done', answer('done'))).toBe(false);
    expect(checkPasses('not_done', answer('done', 'picked up the milk'))).toBe(true);
  });

  it('needs the mistake named, and no done, for wrong', () => {
    expect(checkPasses('wrong', answer('not_done', 'picked up the milk'))).toBe(true);
    expect(checkPasses('wrong', answer('not_done'))).toBe(false);
    expect(checkPasses('wrong', answer('not_done', '  '))).toBe(false);
    expect(checkPasses('wrong', answer('done', 'picked up the milk'))).toBe(false);
  });
});

describe('checkTestRequest', () => {
  const test: BenchCheckTest = {
    id: 'milk',
    title: 'Milk',
    expect: 'wrong',
    goal: 'Get a yogurt drink',
    step: { id: 'take', instruction: 'Take the yogurt drink.' },
    objects: [],
    confusions: [],
    before: [],
    now: [{ file: 'now-1.jpg', mimeType: 'image/jpeg' }],
    createdAt: '2026-10-24T03:15:02.000Z',
    updatedAt: '2026-10-24T03:15:02.000Z',
  };
  const image = { mimeType: 'image/jpeg' as const, data: 'eA==' };

  it('leaves out the hints a test was saved without', () => {
    expect(checkTestRequest(test, { before: [], now: [image] })).toEqual({
      goal: 'Get a yogurt drink',
      step: { id: 'take', instruction: 'Take the yogurt drink.' },
      images: [image],
    });
    const withHints = { ...test, confusions: ['the milk'] };
    expect(checkTestRequest(withHints, { before: [image], now: [image] })).toMatchObject({
      before: [image],
      confusions: ['the milk'],
    });
  });
});

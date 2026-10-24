import { SlugSchema } from '@clio/protocol';
import { describe, expect, it } from 'vitest';
import {
  goalIdCandidates,
  revisionIdCandidates,
  revisionRoot,
  slugFromGoal,
} from '../src/services/plan-ids';

const first = (ids: Iterable<string>, n: number) => {
  const out: string[] = [];
  for (const id of ids) {
    out.push(id);
    if (out.length === n) break;
  }
  return out;
};

describe('slugFromGoal', () => {
  it.each([
    ['Refill the windshield washer fluid!', 'refill-the-windshield-washer-fluid'],
    ['  Café crème: make it  ', 'cafe-creme-make-it'],
    ['Change a bike tire (rear)', 'change-a-bike-tire-rear'],
    ['???', 'plan'],
    ['a'.repeat(100), 'a'.repeat(48)],
    ['word '.repeat(20), 'word-word-word-word-word-word-word-word-word'],
  ])('%j -> %j', (goal, slug) => {
    expect(slugFromGoal(goal)).toBe(slug);
    expect(SlugSchema.safeParse(slug).success).toBe(true);
  });
});

describe('goalIdCandidates', () => {
  it('tries the slug, then -2, -3, …', () => {
    expect(first(goalIdCandidates('fold-towel'), 3)).toEqual([
      'fold-towel',
      'fold-towel-2',
      'fold-towel-3',
    ]);
  });
});

describe('revision ids', () => {
  it('strips a previous revision suffix to find the root', () => {
    expect(revisionRoot('fold-towel')).toBe('fold-towel');
    expect(revisionRoot('fold-towel-r3')).toBe('fold-towel');
    expect(revisionRoot('fold-towel-2')).toBe('fold-towel-2');
  });

  it('numbers revisions of the root: -r1, -r2, …', () => {
    expect(first(revisionIdCandidates('fold-towel'), 2)).toEqual([
      'fold-towel-r1',
      'fold-towel-r2',
    ]);
    expect(first(revisionIdCandidates('fold-towel-r1'), 2)).toEqual([
      'fold-towel-r1',
      'fold-towel-r2',
    ]);
  });

  it('keeps ids within the 64-character slug limit', () => {
    const [id] = first(revisionIdCandidates('a'.repeat(64)), 1);
    expect(id).toBe(`${'a'.repeat(61)}-r1`);
    expect(SlugSchema.safeParse(id).success).toBe(true);
  });
});

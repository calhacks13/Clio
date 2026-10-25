import type { ObjectSpec } from '@clio/protocol';
import { describe, expect, it } from 'vitest';
import { findWords } from '../../src/domain/world/find-words';

const spec = (o: Partial<ObjectSpec>): ObjectSpec =>
  ({
    id: 'shelf',
    label: 'shelf',
    kind: 'item',
    radius: 0.2,
    hidden: false,
    placement: { method: 'detect' },
    ...o,
  }) as ObjectSpec;

describe('findWords', () => {
  it('gives the finder where the object is, not only what it looks like', () => {
    const shelf = spec({
      tracking: { query: 'White wire shelf.', moves: false },
      placement: { method: 'detect', hint: 'second from the top inside the mini fridge' },
    });
    expect(findWords(shelf)).toBe('White wire shelf, second from the top inside the mini fridge');
  });

  it('leaves a query that already says where alone', () => {
    const query = 'White wire shelf, second from the top inside the mini fridge';
    const shelf = spec({
      tracking: { query, moves: false },
      placement: { method: 'detect', hint: 'Second from the top inside the mini fridge' },
    });
    expect(findWords(shelf)).toBe(query);
  });

  it('falls back to the description, then the label', () => {
    expect(findWords(spec({ description: 'A glass jar' }))).toBe('A glass jar');
    expect(findWords(spec({}))).toBe('shelf');
  });
});

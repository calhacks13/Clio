import { describe, expect, it } from 'vitest';
import { isSafeId, isSafeMediaName, newEpisodeId } from '../src/ids';

const sequence = (...values: number[]) => {
  let i = 0;
  return () => values[i++ % values.length] ?? 0;
};

describe('newEpisodeId', () => {
  it('formats the UTC timestamp and a 4-character base36 suffix', () => {
    const id = newEpisodeId(new Date('2026-10-24T03:15:02.123Z'), sequence(0.29, 0.31, 0.34, 0.99));
    expect(id).toBe('ep-20261024-031502-abcz');
  });

  it('zero-pads every field', () => {
    expect(newEpisodeId(new Date('2027-01-02T04:05:06.000Z'), () => 0)).toBe(
      'ep-20270102-040506-0000',
    );
  });

  it('uses UTC, not local time', () => {
    expect(newEpisodeId(new Date('2026-12-31T23:59:59.999Z'), () => 0.5)).toBe(
      'ep-20261231-235959-iiii',
    );
  });

  it('defaults to a random suffix that is a valid id', () => {
    const id = newEpisodeId(new Date('2026-10-24T03:15:02Z'));
    expect(id).toMatch(/^ep-20261024-031502-[0-9a-z]{4}$/);
    expect(isSafeId(id)).toBe(true);
  });
});

describe('isSafeId', () => {
  it.each(['ep-20261024-031502-k3f9', 'shirt-fold', 'a', 'A.b_c-1', 'a'.repeat(128)])(
    'accepts %s',
    (id) => {
      expect(isSafeId(id)).toBe(true);
    },
  );

  it.each([
    '',
    '..',
    '.hidden',
    '-x',
    '_x',
    'a/b',
    'a\\b',
    '../etc',
    'a b',
    'café',
    'a'.repeat(129),
  ])('rejects %j', (id) => {
    expect(isSafeId(id)).toBe(false);
  });
});

describe('isSafeMediaName', () => {
  it('accepts plain file names up to 64 characters', () => {
    expect(isSafeMediaName('egocentric.webm')).toBe(true);
    expect(isSafeMediaName('a'.repeat(64))).toBe(true);
  });

  it('rejects longer names and anything path-like', () => {
    expect(isSafeMediaName('a'.repeat(65))).toBe(false);
    expect(isSafeMediaName('../meta.json')).toBe(false);
    expect(isSafeMediaName('.env')).toBe(false);
    expect(isSafeMediaName('media/x.webm')).toBe(false);
  });
});

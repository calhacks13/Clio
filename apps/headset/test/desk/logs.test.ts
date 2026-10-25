import { describe, expect, it } from 'vitest';
import { brief, TOOL_LOG_MAX, ToolLog, TRANSCRIPT_MAX, Transcript } from '../../src/desk/logs';

// The side panel's conversation and tool-call log.

describe('Transcript', () => {
  it('keeps one line per turn, growing while partial', () => {
    const t = new Transcript();
    t.caption(1, 'user', 'I want', false);
    t.caption(2, 'user', 'I want to water the basil', false);
    t.caption(3, 'user', 'I want to water the basil', true);
    expect(t.lines).toEqual([
      { t: 1, role: 'user', text: 'I want to water the basil', final: true },
    ]);
    t.caption(4, 'user', 'Thanks', true);
    expect(t.lines.map((l) => l.text)).toEqual(['I want to water the basil', 'Thanks']);
  });

  it('keeps the learner and the coach apart when their partials interleave', () => {
    const t = new Transcript();
    t.caption(1, 'coach', 'Sure,', false);
    t.caption(2, 'user', 'wait', false);
    t.caption(3, 'coach', "Sure, let's start", false);
    t.caption(4, 'user', 'wait', true);
    t.caption(5, 'coach', "Sure, let's start.", true);
    expect(t.lines.map((l) => [l.role, l.text, l.final])).toEqual([
      ['coach', "Sure, let's start.", true],
      ['user', 'wait', true],
    ]);
  });

  it('lists typed turns and the [app] messages the voice was sent', () => {
    const t = new Transcript();
    t.typed(1, 'water the basil');
    t.narration(2, '[app] Plan ready.');
    expect(t.lines).toEqual([
      { t: 1, role: 'user', text: 'water the basil', final: true, typed: true },
      { t: 2, role: 'app', text: '[app] Plan ready.', final: true },
    ]);
  });

  it('skips an empty fragment and keeps only the newest lines', () => {
    const t = new Transcript();
    t.caption(0, 'user', '  ', false);
    expect(t.lines).toEqual([]);
    for (let i = 0; i < TRANSCRIPT_MAX + 5; i++) t.narration(i, `n${i}`);
    expect(t.lines).toHaveLength(TRANSCRIPT_MAX);
    expect(t.lines[0]?.text).toBe('n5');
  });
});

describe('ToolLog', () => {
  it('pairs each call with its result and how long it took', () => {
    const log = new ToolLog();
    log.call(100, 'c1', 'highlight', { object_id: 'cup' });
    log.call(110, 'c2', 'start_lesson', { goal: 'basil' });
    log.result(130, 'c1', true, { shown: true });
    expect(log.entries[0]).toEqual({
      callId: 'c1',
      name: 'highlight',
      args: { object_id: 'cup' },
      t: 100,
      ok: true,
      result: { shown: true },
      ms: 30,
    });
    expect(log.entries[1]?.ok).toBeUndefined();
    expect(log.counts()).toEqual({ highlight: 1, start_lesson: 1 });
  });

  it('ignores a result for a call it never saw, and keeps only the newest calls', () => {
    const log = new ToolLog();
    log.result(1, 'nope', true, null);
    expect(log.entries).toEqual([]);
    for (let i = 0; i < TOOL_LOG_MAX + 3; i++) log.call(i, `c${i}`, 'add_step', {});
    expect(log.entries).toHaveLength(TOOL_LOG_MAX);
    expect(log.entries[0]?.callId).toBe('c3');
  });
});

describe('brief', () => {
  it('writes short JSON and cuts long values', () => {
    expect(brief({ a: 1 })).toBe('{"a":1}');
    expect(brief('plain')).toBe('plain');
    expect(brief(undefined)).toBe('undefined');
    expect(brief('x'.repeat(50), 10)).toBe(`${'x'.repeat(9)}…`);
  });
});

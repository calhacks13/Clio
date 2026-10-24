import { describe, expect, it } from 'vitest';
import { COACH_TOOL_NAMES, parseToolArgs, toolParametersJsonSchema } from '../src/index';

describe('coach tools', () => {
  it('fills the default highlight style', () => {
    expect(parseToolArgs('highlight', { object_id: 'cup_a' })).toEqual({
      ok: true,
      name: 'highlight',
      args: { object_id: 'cup_a', style: 'target' },
    });
  });

  it('returns a readable error for missing arguments instead of throwing', () => {
    const r = parseToolArgs('advance_step', {});
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.error).toMatch(/reason/);
  });

  it('rejects unknown tools', () => {
    const r = parseToolArgs('teleport', {});
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.error).toMatch(/unknown tool "teleport"/i);
  });

  it('describes each tool with a JSON Schema that marks required arguments', () => {
    expect(COACH_TOOL_NAMES).toEqual(['highlight', 'show_demo', 'advance_step', 'flag_mistake']);
    expect(toolParametersJsonSchema('advance_step').required).toEqual(['reason']);
    expect(toolParametersJsonSchema('flag_mistake').required).toEqual(['kind', 'message']);
    expect(toolParametersJsonSchema('show_demo').required).toBeUndefined();
  });
});

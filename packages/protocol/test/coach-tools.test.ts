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
    const r = parseToolArgs('complete_step', { step_id: 'cap', evidence: 'seen' });
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.error).toMatch(/reason/);
  });

  it('accepts only the listed status changes and evidence', () => {
    expect(parseToolArgs('update_step', { step_id: 'cap', status: 'skipped' }).ok).toBe(true);
    expect(parseToolArgs('update_step', { step_id: 'cap', status: 'done' }).ok).toBe(false);
    expect(
      parseToolArgs('complete_step', { step_id: 'cap', reason: 'r', evidence: 'guessed' }).ok,
    ).toBe(false);
  });

  it('declares only flat arguments (the Live converter cannot express unions)', () => {
    for (const name of COACH_TOOL_NAMES) {
      const schema = JSON.stringify(toolParametersJsonSchema(name));
      expect(schema, name).not.toMatch(/"(anyOf|oneOf|allOf)"/);
    }
  });

  it('rejects unknown tools', () => {
    const r = parseToolArgs('teleport', {});
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.error).toMatch(/unknown tool "teleport"/i);
  });

  it('describes each tool with a JSON Schema that marks required arguments', () => {
    expect(COACH_TOOL_NAMES).toEqual([
      'start_lesson',
      'revise_plan',
      'add_step',
      'update_step',
      'complete_step',
      'add_material',
      'highlight',
      'show_demo',
      'flag_mistake',
    ]);
    expect(toolParametersJsonSchema('start_lesson').required).toEqual(['goal']);
    expect(toolParametersJsonSchema('revise_plan').required).toEqual(['reason']);
    expect(toolParametersJsonSchema('add_step').required).toEqual(['text', 'done_when']);
    expect(toolParametersJsonSchema('update_step').required).toEqual(['step_id']);
    expect(toolParametersJsonSchema('complete_step').required).toEqual([
      'step_id',
      'reason',
      'evidence',
    ]);
    expect(toolParametersJsonSchema('add_material').required).toEqual(['label']);
    expect(toolParametersJsonSchema('flag_mistake').required).toEqual(['kind', 'message']);
    expect(toolParametersJsonSchema('show_demo').required).toBeUndefined();
  });
});

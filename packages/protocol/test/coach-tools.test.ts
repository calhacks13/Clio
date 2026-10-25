import { describe, expect, it } from 'vitest';
import {
  COACH_TOOL_NAMES,
  COACH_TOOLS,
  isNonBlockingTool,
  isWidgetTool,
  parseToolArgs,
  toolParametersJsonSchema,
  WIDGET_KINDS,
  WIDGET_TEXT_MAX,
  WIDGET_TOOL_NAMES,
  type WidgetToolName,
} from '../src/index';

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

  it('marks only look_closer non-blocking: it waits on the smart model', () => {
    expect(COACH_TOOL_NAMES.filter(isNonBlockingTool)).toEqual(['look_closer']);
    expect(isNonBlockingTool('teleport')).toBe(false);
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
      'look_closer',
      'show_timer',
      'show_progress',
      'show_checklist',
      'show_choices',
      'show_value',
      'show_caution',
      'clear_widget',
    ]);
    expect(toolParametersJsonSchema('start_lesson').required).toEqual(['goal']);
    expect(toolParametersJsonSchema('look_closer').required).toEqual(['question']);
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

  describe('widgets', () => {
    it('declares one show tool per kind and clear_widget, all among the coach tools', () => {
      expect(WIDGET_TOOL_NAMES).toEqual([
        ...WIDGET_KINDS.map((kind) => `show_${kind}`),
        'clear_widget',
      ]);
      for (const name of WIDGET_TOOL_NAMES) {
        expect(COACH_TOOL_NAMES).toContain(name);
        expect(isWidgetTool(name)).toBe(true);
      }
      expect(isWidgetTool('highlight')).toBe(false);
      expect(isWidgetTool('show_demo')).toBe(false);
    });

    it('marks the arguments each kind needs as required', () => {
      const required = (name: (typeof WIDGET_TOOL_NAMES)[number]) =>
        toolParametersJsonSchema(name).required;
      expect(required('show_timer')).toEqual(['seconds', 'label']);
      expect(required('show_progress')).toEqual(['label', 'value', 'total']);
      expect(required('show_checklist')).toEqual(['title', 'items']);
      expect(required('show_choices')).toEqual(['question', 'options']);
      expect(required('show_value')).toEqual(['label', 'value']);
      expect(required('show_caution')).toEqual(['text']);
      expect(required('clear_widget')).toEqual(['widget_id']);
    });

    it('enforces the hard limits', () => {
      const ok = (name: string, args: unknown) => parseToolArgs(name, args).ok;
      expect(ok('show_timer', { seconds: 5, label: 'Glue sets' })).toBe(true);
      expect(ok('show_timer', { seconds: 3600, label: 'Glue sets' })).toBe(true);
      expect(ok('show_timer', { seconds: 4, label: 'Glue sets' })).toBe(false);
      expect(ok('show_timer', { seconds: 3601, label: 'Glue sets' })).toBe(false);
      expect(ok('show_timer', { seconds: 90.5, label: 'Glue sets' })).toBe(false);
      expect(ok('show_choices', { question: 'Which one?', options: ['A'] })).toBe(false);
      expect(ok('show_choices', { question: 'Which one?', options: ['A', 'B', 'C', 'D'] })).toBe(
        false,
      );
      expect(ok('show_checklist', { title: 'Gather', items: ['funnel'] })).toBe(false);
      const six = ['a', 'b', 'c', 'd', 'e', 'f'];
      expect(ok('show_checklist', { title: 'Gather', items: six })).toBe(false);
      expect(ok('show_value', { label: 'Torque', value: '12345678901234567' })).toBe(false);
      expect(ok('show_value', { label: 'Torque', value: '25 N m' })).toBe(true);
      expect(ok('show_progress', { label: 'Screws', value: 1, total: 0 })).toBe(false);
    });

    it('takes each text up to the length its card draws whole, and says so in its description', () => {
      const M = WIDGET_TEXT_MAX;
      // Each field once: its tool, its argument, a call that carries it, and its limit.
      const fields: [WidgetToolName, string, (s: string) => object, number][] = [
        ['show_timer', 'label', (s) => ({ seconds: 60, label: s }), M.timerLabel],
        ['show_progress', 'label', (s) => ({ label: s, value: 1, total: 4 }), M.progressLabel],
        ['show_progress', 'unit', (s) => ({ label: 'A', value: 1, total: 4, unit: s }), M.unit],
        ['show_checklist', 'title', (s) => ({ title: s, items: ['A', 'B'] }), M.checklistTitle],
        ['show_checklist', 'items', (s) => ({ title: 'A', items: [s, 'B'] }), M.checklistItem],
        ['show_choices', 'question', (s) => ({ question: s, options: ['A', 'B'] }), M.question],
        ['show_choices', 'options', (s) => ({ question: 'Ready?', options: [s, 'B'] }), M.option],
        ['show_value', 'label', (s) => ({ label: s, value: '25 N m' }), M.valueLabel],
        ['show_value', 'value', (s) => ({ label: 'A', value: s }), M.value],
        ['show_caution', 'text', (s) => ({ text: s }), M.caution],
      ];
      for (const [name, arg, call, max] of fields) {
        const at = `${name} ${arg}`;
        expect(parseToolArgs(name, call('a'.repeat(max))).ok, at).toBe(true);
        expect(parseToolArgs(name, call('a'.repeat(max + 1))).ok, at).toBe(false);
        const property = toolParametersJsonSchema(name).properties[arg] as { description?: string };
        expect(property.description, at).toContain(`${max} characters`);
      }
      const done = (s: string) => ({ title: 'A', items: ['A', 'B'], done: [s] });
      expect(parseToolArgs('show_checklist', done('a'.repeat(M.checklistItem))).ok).toBe(true);
      expect(parseToolArgs('show_checklist', done('a'.repeat(M.checklistItem + 1))).ok).toBe(false);
    });

    it('lets clear_widget name any widget by its whole text, the longest a caution', () => {
      const longest = Math.max(...Object.values(WIDGET_TEXT_MAX));
      const clear = (s: string) => parseToolArgs('clear_widget', { widget_id: s }).ok;
      expect(clear('Never put your hand under the mower deck while it is running')).toBe(true);
      expect(clear('a'.repeat(longest))).toBe(true);
      expect(clear('a'.repeat(longest + 1))).toBe(false);
    });

    it('keeps each widget description short enough for the voice', () => {
      for (const name of WIDGET_TOOL_NAMES) {
        expect(COACH_TOOLS[name].description.length, name).toBeLessThanOrEqual(450);
        expect('nonBlocking' in COACH_TOOLS[name], name).toBe(false);
      }
    });
  });
});

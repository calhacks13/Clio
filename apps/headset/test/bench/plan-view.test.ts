import { type BenchRun, ProcedureSchema } from '@clio/protocol';
import { describe, expect, it } from 'vitest';
import {
  describeAction,
  describeCheck,
  lastRunBadge,
  renderRun,
  renderRunChip,
} from '../../src/bench/plan-view';

// The planner bench page's HTML: checks and actions in words, and model text always escaped.

const procedure = ProcedureSchema.parse({
  schema: 'clio.procedure/1',
  id: 'ph',
  version: 1,
  title: 'Test <acid> & base',
  summary: 'Indicator colors.',
  workspace: { size: [0.8, 0.6] },
  objects: [
    { id: 'cup_a', label: 'cup A', placement: { method: 'detect' } },
    { id: 'vinegar', label: 'vinegar', kind: 'container', placement: { method: 'detect' } },
  ],
  steps: [
    {
      id: 'acid',
      instruction: 'Pour vinegar into cup A.',
      doneWhen: 'Cup A has turned pink.',
      targets: ['vinegar', 'cup_a'],
      action: { verb: 'pour', object: 'vinegar', target: 'cup_a' },
      success: {
        type: 'sequence',
        of: [
          { type: 'object_near', object: 'vinegar', target: 'cup_a' },
          { type: 'confirm', by: 'coach', prompt: 'cup A is pink' },
        ],
      },
    },
  ],
});

const run: BenchRun = {
  id: 'run-20261024-031502-abcd',
  createdAt: '2026-10-24T03:15:02.000Z',
  model: 'gemini-3.8-flash',
  latencyMs: 5300,
  attempts: 2,
  firstAttemptErrors: 'steps.0.targets: Unknown object "ghost"',
  request: { goal: 'Test an acid', views: 2 },
  result: { ok: true, planId: 'ph', procedure, warnings: ['Wear <gloves>'] },
};

describe('describeCheck', () => {
  it('puts checks in words, sequences as arrows', () => {
    expect(describeCheck(procedure.steps[0]?.success ?? { type: 'elapsed', ms: 1 })).toBe(
      'vinegar within 6 cm of cup_a → coach confirms: “cup A is pink”',
    );
    expect(describeCheck({ type: 'elapsed', ms: 5000 })).toBe('after 5.0 s');
    expect(
      describeCheck({ type: 'pinch_near', object: 'cap', hand: 'right', radius: 0.04, dwellMs: 0 }),
    ).toBe('right hand pinches within 4 cm of cap');
  });

  it('describes an action with its direction and amount', () => {
    expect(
      describeAction({ verb: 'twist', object: 'cap', hand: 'right', direction: 'ccw', amount: 2 }),
    ).toBe('twist(cap) ccw 2, right hand');
  });
});

describe('renderRun', () => {
  it('escapes what the model wrote and shows the retry and warnings', () => {
    const html = renderRun(run, {
      saved: false,
      judgeBlocked: 'Save the scenario to judge its runs.',
      judgeModel: 'gemini-pro-latest',
      judging: false,
      checks: new Map(),
      watching: false,
      canWatch: true,
    });
    expect(html).toContain('Test &#60;acid&#62; &#38; base');
    expect(html).not.toContain('<acid>');
    expect(html).toContain('Wear &#60;gloves&#62;');
    expect(html).toContain('failed validation and was retried');
    expect(html).toContain('Cup A has turned pink.');
    expect(html).toContain('pour(vinegar → cup_a)');
    expect(html).toContain('Grades are kept when you save the scenario.');
    expect(html).toContain('data-action="replan-open" data-step="0"');
    expect(html).toContain('data-action="watch-start"');
    expect(html).toContain('<span class="watch-status"></span>');
  });

  it('shows a failed run with the server error', () => {
    const failed: BenchRun = {
      ...run,
      result: {
        ok: false,
        code: 'plan_invalid',
        message: 'The planner returned an invalid plan twice',
        details: { errors: 'steps: Required' },
      },
    };
    const html = renderRun(failed, {
      saved: true,
      judgeBlocked: 'There is no plan to judge.',
      judgeModel: 'gemini-pro-latest',
      judging: false,
      checks: new Map(),
      watching: false,
      canWatch: true,
    });
    expect(html).toContain('plan_invalid');
    expect(html).toContain('<pre>steps: Required</pre>');
    expect(renderRunChip(failed, false, false)).toContain('failed: plan_invalid');
  });
});

describe('lastRunBadge', () => {
  it('prefers the grade and the judge over "ungraded"', () => {
    expect(lastRunBadge(null)).toContain('not run');
    const base = { model: 'm', createdAt: 'x', ok: true, judged: false };
    expect(lastRunBadge(base)).toContain('ungraded');
    expect(lastRunBadge({ ...base, grade: 'fail' })).toContain('fail');
    expect(lastRunBadge({ ...base, judged: true, passed: true })).toContain('judge ✓');
  });
});

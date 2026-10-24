import { type BenchRun, ProcedureSchema } from '@clio/protocol';
import { describe, expect, it } from 'vitest';
import {
  describeAction,
  describeCheck,
  lastRunBadge,
  renderChipList,
  renderRun,
  renderRunChip,
  renderSightings,
  stepMark,
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

describe('two-stage plans', () => {
  const twoSteps = ProcedureSchema.parse({
    ...procedure,
    steps: [
      procedure.steps[0],
      { id: 'base', instruction: 'Pour soap into cup B.', success: { type: 'confirm' } },
    ],
  });
  const first: BenchRun = {
    ...run,
    id: 'run-first',
    createdAt: '2026-10-24T03:15:00.000Z',
    latencyMs: 3000,
    attempts: 1,
    request: { goal: 'Test an acid', views: 2, stage: 'first' },
    result: { ok: true, planId: 'ph', procedure: twoSteps, warnings: [], outlineFrom: 1 },
  };
  const rest: BenchRun = {
    ...first,
    id: 'run-rest',
    createdAt: '2026-10-24T03:15:03.500Z',
    latencyMs: 6000,
    request: {
      goal: 'Test an acid',
      views: 2,
      stage: 'rest',
      revise: { fromStepIndex: 1, reason: 'Refine the outline' },
    },
    result: { ok: true, planId: 'ph-2', procedure: twoSteps, warnings: [] },
  };
  const options = {
    saved: false,
    judgeBlocked: null,
    judgeModel: 'gemini-pro-latest',
    judging: false,
    checks: new Map(),
    watching: false,
    canWatch: true,
  };

  it('marks the outline steps of stage 1 and how the stages went', () => {
    expect([0, 1].map((i) => stepMark(first, i))).toEqual([null, 'outline']);
    expect([0, 1].map((i) => stepMark(rest, i))).toEqual(['stage1', 'refined']);
    const refining = renderRun(first, { ...options, stage: { first, refining: true } });
    expect(refining).toContain('Step 2 is only an outline');
    expect(refining).toContain('<li class="step outline" data-step="1">');
    expect(refining).toContain('Step 1 ready in 3.0 s; refining the rest…');
    const done = renderRun(first, { ...options, stage: { first, rest, refining: false } });
    expect(done).toContain('Step 1 ready in 3.0 s, the rest refined 6.5 s later.');
    expect(done).toContain('data-action="select-run" data-run="run-rest"');
    const refined = renderRun(rest, { ...options, stage: { first, rest, refining: false } });
    expect(refined).toContain('this refined rest 6.5 s later');
    expect(refined).toContain('as in stage 1');
    expect(refined).not.toContain('Re-plan from step');
  });

  it('keeps the two stages together in the chips, with the rest in flight', () => {
    const waiting = renderChipList(
      [first],
      [{ model: 'gemini-3.8-flash', elapsedMs: 1200, stage: 'rest', after: 'run-first' }],
      { selected: 'run-first', goal: 'Test an acid' },
    );
    expect(waiting).toMatch(/class="chip-pair"[\s\S]*run-first[\s\S]*refining the rest… 1\.2 s/);
    const both = renderChipList([rest, first], [], { selected: 'run-rest' });
    expect(both.match(/chip-pair/g)).toHaveLength(1);
    expect(both.indexOf('run-first')).toBeLessThan(both.indexOf('run-rest'));
    expect(both).toContain('2 steps · stage 1');
    expect(both).toContain('2 steps · the rest');
  });

  it('shows a step check that names a mistake and how far along it is', () => {
    const html = renderRun(run, {
      ...options,
      checks: new Map([
        [
          0,
          {
            pending: false,
            result: {
              verdict: 'not_done' as const,
              observation: 'holding a white carton',
              model: 'gemini-robotics-er-2-preview',
              latencyMs: 1300,
              progress: 20,
              wrong: 'picked up the <milk>',
            },
          },
        ],
      ]),
    });
    expect(html).toContain('<span class="verdict wrong">wrong</span> picked up the &#60;milk&#62;');
    expect(html).toContain('20% along');
  });
});

describe('renderSightings', () => {
  const size = { width: 1000, height: 750 };

  it('draws the sightings in one view at the frame size, labeled by object', () => {
    const svg = renderSightings(
      [
        { objectId: 'cup_a', view: 0, point: [0.5, 0.4], box: [0.4, 0.3, 0.6, 0.5] },
        { objectId: 'vinegar', view: 1, point: [0.1, 0.1], box: null },
        { objectId: 'ghost<', view: 0, point: [0.9, 0.02], box: null },
      ],
      procedure.objects,
      0,
      size,
    );
    expect(svg).toContain('viewBox="0 0 1000 750"');
    expect(svg).toContain('<rect x="400" y="225" width="200" height="150"/>');
    expect(svg).toContain('<circle cx="500" cy="300"');
    expect(svg).toContain('>cup A</text>');
    expect(svg).not.toContain('vinegar');
    expect(svg).toContain('ghost&#60;');
    expect(svg.match(/<g class="sighting">/g)).toHaveLength(2);
  });

  it('draws nothing without sightings in that view or a frame size', () => {
    const one = [{ objectId: 'cup_a', view: 0, point: [0.5, 0.5] as [number, number], box: null }];
    expect(renderSightings(one, procedure.objects, 1, size)).toBe('');
    expect(renderSightings(one, procedure.objects, 0, { width: 0, height: 0 })).toBe('');
  });
});

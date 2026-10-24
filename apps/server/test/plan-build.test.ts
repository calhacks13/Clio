import { safeParseProcedure } from '@clio/protocol';
import { describe, expect, it } from 'vitest';
import { parseModelJson } from '../src/services/model-json';
import {
  buildFirstStageCandidate,
  buildPlanCandidate,
  mergeRevision,
  type PlanContext,
} from '../src/services/plan-build';
import { modelFirstStage, modelPlan, modelRevision } from './plan-fixtures';

const ctx: PlanContext = {
  id: 'refill-washer-fluid',
  goal: 'refill washer fluid',
  model: 'planner-test',
  createdAt: '2026-10-24T03:15:02.123Z',
};

function parsed(candidate: unknown) {
  const r = safeParseProcedure(candidate);
  if (!r.ok) throw new Error(r.error);
  return r.procedure;
}

describe('parseModelJson', () => {
  it('parses plain JSON and JSON wrapped in a markdown fence', () => {
    expect(parseModelJson('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseModelJson('```json\n{"a":1}\n```')).toEqual({ ok: true, value: { a: 1 } });
  });

  it('explains what is wrong with anything else', () => {
    const r = parseModelJson('Sure! Here is your plan:');
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.error).toMatch(/^The response was not valid JSON/);
  });
});

describe('buildPlanCandidate', () => {
  it('forces schema, version, origin and id over what the model wrote', () => {
    const { candidate, warnings } = buildPlanCandidate(
      { ...modelPlan(), schema: 'nope', id: 'Bad Id', version: 7, origin: { kind: 'curated' } },
      ctx,
    );
    const p = parsed(candidate);
    expect(p.schema).toBe('clio.procedure/1');
    expect(p.id).toBe('refill-washer-fluid');
    expect(p.version).toBe(1);
    expect(p.origin).toEqual({
      kind: 'generated',
      goal: 'refill washer fluid',
      model: 'planner-test',
      createdAt: '2026-10-24T03:15:02.123Z',
    });
    expect(p.title).toBe('Refill washer fluid');
    expect(p.steps.map((s) => s.id)).toEqual(['open-cap', 'pour-fluid', 'close-cap']);
    expect(p.steps[1]?.action).toEqual({
      verb: 'pour',
      object: 'fluid_jug',
      target: 'washer_cap',
      hand: 'either',
    });
    expect(p.steps[1]?.show.map((item) => [item.object, item.phrase])).toEqual([
      ['fluid_jug', 'washer fluid jug'],
      ['washer_cap', 'washer reservoir opening'],
    ]);
    expect(warnings).toEqual(['Make sure the engine is off and cool.']);
  });

  it('keeps only non-empty string warnings and leaves them out of the procedure', () => {
    const { candidate, warnings } = buildPlanCandidate(
      { ...modelPlan(), warnings: ['  Wear gloves. ', '', 42, null] },
      ctx,
    );
    expect(warnings).toEqual(['Wear gloves.']);
    expect(candidate).not.toHaveProperty('warnings');
  });

  it('makes every object camera-detected, keeping a hint', () => {
    const plan = modelPlan();
    const [cap, coolant, jug] = plan.objects;
    const objects = [
      { ...cap, placement: { method: 'layout', position: [0, 0, 0], hint: 'left' } },
      { ...coolant, placement: undefined },
      jug,
    ];
    const p = parsed(buildPlanCandidate({ ...plan, objects }, ctx).candidate);
    expect(p.objects.map((o) => o.placement)).toEqual([
      { method: 'detect', hint: 'left' },
      { method: 'detect' },
      { method: 'detect' },
    ]);
  });

  it('defaults a missing workspace to a tabletop', () => {
    const { workspace: _dropped, ...plan } = modelPlan();
    expect(parsed(buildPlanCandidate(plan, ctx).candidate).workspace).toEqual({
      size: [0.8, 0.6],
    });
  });

  it('still produces a candidate (that fails validation) for nonsense output', () => {
    const r = safeParseProcedure(buildPlanCandidate(['not', 'a', 'plan'], ctx).candidate);
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.error).toMatch(/title/);
  });

  it('turns sightings into our convention and keeps them out of the procedure', () => {
    const sightings = [
      { object: 'washer_cap', view: 1, point: [400, 250], box_2d: [380, 230, 420, 270] },
      // Only a box: its center stands in for the point.
      { object: 'fluid_jug', view: 2, box_2d: [500, 700, 700, 900] },
      { object: 'ghost', view: 1, point: [10, 10], box_2d: [0, 0, 20, 20] },
      { object: 'washer_cap', view: 3, point: [10, 10], box_2d: [0, 0, 20, 20] },
      { object: 'washer_cap', view: 0, point: [10, 10], box_2d: [0, 0, 20, 20] },
      { object: 'coolant_cap', view: 1, point: 'left', box_2d: null },
    ];
    const built = buildPlanCandidate({ ...modelPlan(), sightings }, { ...ctx, views: 2 });
    expect(built.candidate).not.toHaveProperty('sightings');
    expect(built.sightings).toEqual([
      { objectId: 'washer_cap', view: 0, point: [0.25, 0.4], box: [0.23, 0.38, 0.27, 0.42] },
      { objectId: 'fluid_jug', view: 1, point: [0.8, 0.6], box: [0.7, 0.5, 0.9, 0.7] },
    ]);
    expect(buildPlanCandidate({ ...modelPlan(), sightings }, ctx).sightings).toEqual([]);
  });
});

describe('buildFirstStageCandidate', () => {
  it('writes the first step in full and the rest of the outline as steps to confirm', () => {
    const built = buildFirstStageCandidate(modelFirstStage(), { ...ctx, views: 2 });
    const p = parsed(built.candidate);
    const full = parsed(buildPlanCandidate(modelPlan(), ctx).candidate);
    expect(p.steps[0]).toEqual(full.steps[0]);
    expect(p.steps.slice(1)).toEqual([
      {
        id: 'pour-fluid',
        instruction: 'Pour the fluid into the reservoir.',
        doneWhen: 'The blue fluid reaches the top mark on the reservoir.',
        targets: ['fluid_jug', 'washer_cap'],
        hand: 'either',
        show: [],
        success: {
          type: 'confirm',
          by: 'either',
          prompt: 'The blue fluid reaches the top mark on the reservoir.',
        },
        mistakes: [],
      },
      expect.objectContaining({
        id: 'close-cap',
        success: expect.objectContaining({ type: 'confirm' }),
      }),
    ]);
    expect(built.outlineFrom).toBe(1);
    expect(built.sightings.map((s) => s.objectId)).toEqual(['washer_cap', 'fluid_jug']);
    expect(built.candidate).not.toHaveProperty('outline');
    expect(built.candidate).not.toHaveProperty('firstStep');
    expect(built.warnings).toEqual(['Make sure the engine is off and cool.']);
  });

  it('has no outline when the lesson is only its first step', () => {
    const answer = modelFirstStage();
    const built = buildFirstStageCandidate({ ...answer, outline: answer.outline.slice(0, 1) }, ctx);
    expect(parsed(built.candidate).steps.map((s) => s.id)).toEqual(['open-cap']);
    expect(built).not.toHaveProperty('outlineFrom');
  });

  it('leaves a missing first step for validation (and the retry) to catch', () => {
    const { firstStep: _missing, ...answer } = modelFirstStage();
    const r = safeParseProcedure(buildFirstStageCandidate(answer, ctx).candidate);
    expect(r.ok ? '' : r.error).toMatch(/steps\[0\]|steps\.0/);
  });
});

describe('mergeRevision', () => {
  const base = parsed(buildPlanCandidate(modelPlan(), ctx).candidate);
  const revisionCtx: PlanContext = {
    ...ctx,
    id: 'refill-washer-fluid-r1',
    goal: 'refill washer fluid with a funnel',
    revisionOf: 'refill-washer-fluid',
  };

  it('keeps the steps before fromStepIndex verbatim and appends the new ones', () => {
    const { candidate, warnings } = mergeRevision(base, modelRevision(), 1, revisionCtx);
    const p = parsed(candidate);
    expect(p.steps[0]).toEqual(base.steps[0]);
    expect(p.steps.map((s) => s.id)).toEqual(['open-cap', 'open-cap-2', 'pour-slowly']);
    expect(p.steps[1]?.instruction).toBe('Set the funnel in the reservoir neck.');
    expect(warnings).toEqual(['Wipe up any spilled fluid.']);
  });

  it('adds new objects after the existing ones and ignores redeclared ids', () => {
    const revision = modelRevision();
    const redeclared = { ...revision.objects[0], id: 'washer_cap', label: 'imposter' };
    const { candidate } = mergeRevision(
      base,
      { ...revision, objects: [...revision.objects, redeclared] },
      1,
      revisionCtx,
    );
    const p = parsed(candidate);
    expect(p.objects.map((o) => o.id)).toEqual([
      'washer_cap',
      'coolant_cap',
      'fluid_jug',
      'funnel',
    ]);
    expect(p.objects[0]).toEqual(base.objects[0]);
  });

  it('keeps the base plan around the steps and records what it revises', () => {
    const p = parsed(mergeRevision(base, modelRevision(), 1, revisionCtx).candidate);
    expect(p).toMatchObject({
      schema: 'clio.procedure/1',
      id: 'refill-washer-fluid-r1',
      version: 1,
      title: base.title,
      summary: base.summary,
      domain: base.domain,
      workspace: base.workspace,
      coach: base.coach,
      origin: {
        kind: 'generated',
        goal: 'refill washer fluid with a funnel',
        model: 'planner-test',
        createdAt: '2026-10-24T03:15:02.123Z',
        revisionOf: 'refill-washer-fluid',
      },
    });
  });

  it('can replace every step', () => {
    const p = parsed(mergeRevision(base, modelRevision(), 0, revisionCtx).candidate);
    expect(p.steps.map((s) => s.id)).toEqual(['open-cap', 'pour-slowly']);
  });
});

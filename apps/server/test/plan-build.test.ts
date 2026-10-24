import { safeParseProcedure } from '@clio/protocol';
import { describe, expect, it } from 'vitest';
import { parseModelJson } from '../src/services/model-json';
import { buildPlanCandidate, mergeRevision, type PlanContext } from '../src/services/plan-build';
import { modelPlan, modelRevision } from './plan-fixtures';

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

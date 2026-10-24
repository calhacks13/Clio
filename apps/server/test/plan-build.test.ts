import { ObjectSpecSchema, safeParseProcedure } from '@clio/protocol';
import { describe, expect, it } from 'vitest';
import { parseModelJson } from '../src/services/model-json';
import {
  buildFirstStageCandidate,
  buildPlanCandidate,
  cardObject,
  cardStep,
  mergeRevision,
  type PlanContext,
} from '../src/services/plan-build';
import { modelFirstStage, modelPlan, modelRestStage, modelRevision } from './plan-fixtures';

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

describe('cardObject', () => {
  const [washerCap] = modelFirstStage().objects;

  it('makes a card an object found by its look, with the default kind and size', () => {
    const spec = cardObject(washerCap);
    expect(spec).toEqual({
      id: 'washer_cap',
      label: 'washer cap',
      kind: 'item',
      placement: { method: 'detect' },
      tracking: { query: washerCap?.look, moves: false },
    });
    expect(ObjectSpecSchema.parse(spec)).toMatchObject({ radius: 0.03, hidden: false });
  });

  it('tracks it as moving only when the card says exactly true', () => {
    const moves = (value: unknown) =>
      (cardObject({ ...washerCap, moves: value }) as { tracking: { moves: boolean } }).tracking
        .moves;
    expect([moves(true), moves('true'), moves(1), moves(undefined), moves(false)]).toEqual([
      true,
      false,
      false,
      false,
      false,
    ]);
  });

  it('leaves anything that is not a card for validation to catch', () => {
    expect(cardObject('washer_cap')).toBe('washer_cap');
  });
});

describe('cardStep', () => {
  const { objects, firstStep } = modelFirstStage();
  const card = (patch: Record<string, unknown>) => ({ ...firstStep, ...patch });

  it('outlines each shown object by its phrase and look, and confirms the step by its done-when', () => {
    expect(cardStep(firstStep, objects)).toEqual({
      id: 'open-cap',
      instruction: 'Flip open the blue washer fluid cap.',
      doneWhen: 'The blue cap is flipped open and the reservoir neck is visible.',
      targets: ['washer_cap'],
      action: { verb: 'twist', object: 'washer_cap', direction: 'ccw', amount: 0.5 },
      show: [{ object: 'washer_cap', phrase: 'washer fluid cap', description: objects[0]?.look }],
      mistakes: [
        {
          kind: 'wrong_cap',
          message: 'That is the coolant cap. Use the blue one.',
          when: { type: 'hand_near', object: 'coolant_cap', dwellMs: 700 },
        },
      ],
      success: {
        type: 'confirm',
        prompt: 'The blue cap is flipped open and the reservoir neck is visible.',
      },
    });
  });

  it('shows each declared object once, and names it by its label without a phrase', () => {
    const cards = [{ ...objects[0], phrase: ' ' }, objects[1]];
    const step = cardStep(card({ show: ['ghost', 'washer_cap', 'washer_cap', 7] }), cards);
    expect((step as { show: unknown[] }).show).toEqual([
      { object: 'washer_cap', phrase: 'washer cap', description: objects[0]?.look },
    ]);
  });

  it('cuts a phrase to 60 characters and a look to 300, as the show items allow', () => {
    const cards = [{ ...objects[0], phrase: 'p'.repeat(80), look: 'l'.repeat(400) }];
    const [item] = (
      cardStep(firstStep, cards) as { show: { phrase: string; description: string }[] }
    ).show;
    expect([item?.phrase.length, item?.description.length]).toEqual([60, 300]);
  });

  it('drops a mistake made with an undeclared object or one the step itself uses', () => {
    const mistakes = [
      { kind: 'ghost', message: 'No.', object: 'ghost' },
      { kind: 'own_target', message: 'No.', object: 'washer_cap' },
      { kind: 'shown', message: 'No.', object: 'coolant_cap' },
      { kind: 'not_a_record', message: 'No.' },
    ];
    const shownLookAlike = cardStep(
      card({ show: ['washer_cap', 'coolant_cap'], mistakes }),
      objects,
    ) as { mistakes: unknown[] };
    expect(shownLookAlike.mistakes).toEqual([]);
    const acted = cardStep(
      card({
        targets: [],
        show: [],
        action: { verb: 'pour', object: 'washer_cap', target: 'coolant_cap' },
        mistakes,
      }),
      objects,
    ) as { mistakes: unknown[] };
    expect(acted.mistakes).toEqual([]);
  });

  it('is confirmed without a prompt when the card has no done-when', () => {
    const { doneWhen: _none, ...step } = firstStep;
    expect((cardStep(step, objects) as { success: unknown }).success).toEqual({ type: 'confirm' });
  });
});

describe('buildFirstStageCandidate', () => {
  it('writes the first step from its card and the rest of the outline as steps to confirm', () => {
    const built = buildFirstStageCandidate(modelFirstStage(), { ...ctx, views: 2 });
    const p = parsed(built.candidate);
    expect(p.steps[0]).toEqual({
      id: 'open-cap',
      instruction: 'Flip open the blue washer fluid cap.',
      doneWhen: 'The blue cap is flipped open and the reservoir neck is visible.',
      targets: ['washer_cap'],
      hand: 'either',
      action: {
        verb: 'twist',
        object: 'washer_cap',
        direction: 'ccw',
        amount: 0.5,
        hand: 'either',
      },
      show: [
        {
          object: 'washer_cap',
          phrase: 'washer fluid cap',
          description: modelFirstStage().objects[0]?.look,
        },
      ],
      success: {
        type: 'confirm',
        by: 'either',
        prompt: 'The blue cap is flipped open and the reservoir neck is visible.',
      },
      mistakes: [
        {
          kind: 'wrong_cap',
          message: 'That is the coolant cap. Use the blue one.',
          when: {
            type: 'hand_near',
            object: 'coolant_cap',
            hand: 'either',
            point: 'pinch',
            radius: 0.06,
            dwellMs: 700,
          },
          cooldownMs: 4000,
        },
      ],
    });
    const outlined = (id: string, instruction: string) => ({
      id,
      instruction,
      targets: [],
      hand: 'either',
      show: [],
      success: { type: 'confirm', by: 'either', prompt: instruction },
      mistakes: [],
    });
    expect(p.steps.slice(1)).toEqual([
      outlined('pour-fluid', 'Pour the fluid into the reservoir.'),
      outlined('close-cap', 'Close the washer fluid cap.'),
    ]);
    expect(p.objects).toEqual(
      modelFirstStage().objects.map((card) => ({
        id: card.id,
        label: card.label,
        kind: 'item',
        radius: 0.03,
        hidden: false,
        placement: { method: 'detect' },
        tracking: { query: card.look, moves: false },
      })),
    );
    expect(p.workspace).toEqual({ size: [0.8, 0.6] });
    expect(built.outlineFrom).toBe(1);
    // The jug was seen but is not declared until stage rest.
    expect(built.sightings.map((s) => [s.objectId, s.view])).toEqual([
      ['washer_cap', 0],
      ['coolant_cap', 1],
    ]);
    expect(built.candidate).not.toHaveProperty('outline');
    expect(built.candidate).not.toHaveProperty('firstStep');
    expect(built.warnings).toEqual(['Make sure the engine is off and cool.']);
  });

  const ids = (answer: unknown) =>
    parsed(buildFirstStageCandidate(answer, ctx).candidate).steps.map((s) => s.id);
  const [opening, pouring, closing] = modelFirstStage().outline;

  it('takes the first step out of the outline wherever its line is', () => {
    const answer = modelFirstStage();
    expect(ids({ ...answer, outline: [pouring, opening, closing] })).toEqual([
      'open-cap',
      'pour-fluid',
      'close-cap',
    ]);
  });

  it('keeps every line when none is the first step, unless outline[0] says the same', () => {
    const answer = modelFirstStage();
    // The bug this guards against: outline[0] taken for the first step, losing pour-fluid.
    expect(ids({ ...answer, outline: [pouring, closing] })).toEqual([
      'open-cap',
      'pour-fluid',
      'close-cap',
    ]);
    const renamed = { id: 'open-washer-cap', instruction: 'flip open the blue washer fluid cap' };
    expect(ids({ ...answer, outline: [renamed, pouring, closing] })).toEqual([
      'open-cap',
      'pour-fluid',
      'close-cap',
    ]);
    const other = { id: 'check-level', instruction: 'Check the fluid level.' };
    expect(ids({ ...answer, outline: [other, pouring] })).toEqual([
      'open-cap',
      'check-level',
      'pour-fluid',
    ]);
  });

  it('has no outline when the lesson is only its first step', () => {
    const answer = modelFirstStage();
    for (const outline of [[opening], [], undefined]) {
      const built = buildFirstStageCandidate({ ...answer, outline }, ctx);
      expect(parsed(built.candidate).steps.map((s) => s.id)).toEqual(['open-cap']);
      expect(built).not.toHaveProperty('outlineFrom');
    }
  });

  it('leaves a missing or broken first step for validation (and the retry) to catch', () => {
    const { firstStep: _missing, ...answer } = modelFirstStage();
    for (const firstStep of [undefined, 'open-cap']) {
      const r = safeParseProcedure(
        buildFirstStageCandidate({ ...answer, firstStep }, ctx).candidate,
      );
      expect(r.ok ? '' : r.error).toMatch(/steps\[0\]|steps\.0/);
    }
  });

  it('leaves undeclared targets and duplicate cards for validation to name', () => {
    const answer = modelFirstStage();
    const error = (patch: Record<string, unknown>) => {
      const r = safeParseProcedure(
        buildFirstStageCandidate({ ...answer, ...patch }, ctx).candidate,
      );
      return r.ok ? '' : r.error;
    };
    expect(error({ firstStep: { ...answer.firstStep, targets: ['fluid_jug'] } })).toMatch(
      /Unknown object "fluid_jug"[\s\S]*steps\[0\]\.targets\[0\]/,
    );
    expect(error({ objects: [...answer.objects, answer.objects[0]] })).toMatch(
      /Duplicate object id "washer_cap"[\s\S]*objects\[2\]\.id/,
    );
    expect(error({ objects: [{ ...answer.objects[0], look: '' }, answer.objects[1]] })).toMatch(
      /objects\[0\]\.tracking\.query/,
    );
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

  describe('upgrading a first stage', () => {
    const first = parsed(buildFirstStageCandidate(modelFirstStage(), ctx).candidate);
    const restCtx = { ...revisionCtx, goal: ctx.goal };

    it('fills in the objects its cards declared, keeping their ids, labels and places', () => {
      const answer = modelRestStage();
      const fullCap = { ...answer.objects[0], kind: 'tool', radius: 0.04, label: 'blue cap' };
      const p = parsed(
        mergeRevision(
          first,
          { ...answer, objects: [fullCap, ...answer.objects.slice(1)] },
          1,
          restCtx,
          {
            upgrade: true,
          },
        ).candidate,
      );
      expect(p.objects.map((o) => o.id)).toEqual([
        'washer_cap',
        'coolant_cap',
        'fluid_jug',
        'funnel',
      ]);
      expect(p.objects[0]).toEqual({
        id: 'washer_cap',
        label: 'washer cap',
        kind: 'tool',
        radius: 0.04,
        hidden: false,
        placement: { method: 'detect', hint: 'front left of the engine bay' },
        tracking: { query: 'blue cap with a windshield symbol', moves: false },
      });
      // Not written again: the card stays as it was.
      expect(p.objects[1]).toEqual(first.objects[1]);
      expect(p.steps[0]).toEqual(first.steps[0]);
    });

    it('lets stage rest make a card a part of a whole object it declares then', () => {
      const answer = modelRestStage();
      const whole = {
        id: 'reservoir',
        label: 'washer reservoir',
        kind: 'container',
        radius: 0.12,
        placement: { method: 'detect' },
        tracking: { query: 'The white washer fluid tank at the front left', moves: false },
      };
      const part = { ...answer.objects[0], partOf: 'reservoir' };
      const p = parsed(
        mergeRevision(
          first,
          { ...answer, objects: [part, ...answer.objects.slice(1), whole] },
          1,
          restCtx,
          { upgrade: true },
        ).candidate,
      );
      expect(p.objects[0]).toMatchObject({ id: 'washer_cap', partOf: 'reservoir' });
      expect(p.objects.at(-1)).toMatchObject({ id: 'reservoir', kind: 'container' });
    });

    it('keeps the card when the new declaration is not a valid object', () => {
      const answer = modelRestStage();
      const broken = { ...answer.objects[0], kind: 'banana', radius: 9 };
      const p = parsed(
        mergeRevision(
          first,
          { ...answer, objects: [broken, ...answer.objects.slice(1)] },
          1,
          restCtx,
          {
            upgrade: true,
          },
        ).candidate,
      );
      expect(p.objects[0]).toEqual(first.objects[0]);
    });

    it('takes only the first of two declarations of the same object', () => {
      const answer = modelRestStage();
      const again = { ...answer.objects[0], radius: 0.2 };
      const p = parsed(
        mergeRevision(first, { ...answer, objects: [...answer.objects, again] }, 1, restCtx, {
          upgrade: true,
        }).candidate,
      );
      expect(p.objects[0]?.radius).toBe(0.03);
      expect(p.objects[0]?.placement).toEqual({
        method: 'detect',
        hint: 'front left of the engine bay',
      });
    });

    it('ignores them without upgrade, as a revise_plan does', () => {
      const p = parsed(mergeRevision(first, modelRestStage(), 1, restCtx).candidate);
      expect(p.objects.slice(0, 2)).toEqual(first.objects);
    });
  });
});

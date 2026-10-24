import { describe, expect, it } from 'vitest';
import { briefStep, type PlanView, recitePlan } from '../../src/domain/plan/recital';

const plan: PlanView = {
  goal: 'Test an acid and a base',
  title: 'Acid or base?',
  rev: 4,
  focusId: 'acid-to-a',
  steps: [
    { id: 'draw', instruction: 'Fill the syringe.', status: 'done', uses: ['syringe'], demo: true },
    {
      id: 'acid-to-a',
      instruction: 'Add vinegar to cup A',
      doneWhen: 'cup A has turned pink',
      note: 'left-handed',
      status: 'todo',
      uses: ['vinegar bottle', 'cup A'],
      demo: true,
      coachNotes: 'Mention the cup letter.',
    },
    {
      id: 'base-to-b',
      instruction: 'Add base to cup B.',
      doneWhen: 'cup B is blue-green',
      status: 'todo',
      uses: [],
      demo: false,
    },
    { id: 'compare', instruction: 'Compare the cups.', status: 'todo', uses: [], demo: false },
    { id: 'rinse', instruction: 'Rinse the syringe.', status: 'skipped', uses: [], demo: false },
  ],
  materials: [
    { id: 'cup_a', label: 'cup A' },
    { id: 'vinegar', label: 'vinegar bottle' },
  ],
};

describe('recitePlan', () => {
  it('lists what is done, the step now, the next one, and the rest by id', () => {
    expect(recitePlan(plan)).toBe(
      [
        'Goal: Test an acid and a base (plan rev 4)',
        'Done: draw',
        'Now: acid-to-a: Add vinegar to cup A. Done when: cup A has turned pink. Note: left-handed.',
        'Next: base-to-b: Add base to cup B. Done when: cup B is blue-green.',
        'Later: compare',
        'Skipped: rinse',
        'Materials: cup_a (cup A), vinegar (vinegar bottle)',
      ].join('\n'),
    );
  });

  it('says when nothing is left, and stays short however long the plan is', () => {
    expect(recitePlan({ ...plan, focusId: null })).toContain('Now: nothing left to do');
    const long = {
      ...plan,
      steps: Array.from({ length: 60 }, (_, i) => ({
        id: `step-number-${i}`,
        instruction: 'Do a thing that takes a long sentence to describe properly.',
        status: 'todo' as const,
        uses: [],
        demo: false,
      })),
    };
    expect(recitePlan(long).length).toBeLessThanOrEqual(1200);
  });

  it('names as next the step the focus will move to, and keeps notes on the other steps', () => {
    const around: PlanView = {
      ...plan,
      focusId: 'base-to-b',
      steps: plan.steps.map((s) =>
        s.id === 'draw'
          ? { ...s, note: 'they spilled some' }
          : s.id === 'rinse'
            ? { ...s, note: 'no sink' }
            : s,
      ),
    };
    const text = recitePlan(around);
    expect(text).toContain('Next: acid-to-a: Add vinegar to cup A.');
    expect(text).toContain('Notes: draw: they spilled some; rinse: no sink');
    expect(briefStep(around, 'base-to-b')).toMatch(/Next: Add vinegar to cup A\.$/);
  });

  it('uses no arrow or bullet symbols', () => {
    expect(recitePlan(plan)).not.toMatch(/[→←↑↓➜⟶·•]/);
  });
});

describe('briefStep', () => {
  it('gives the step, how to tell it is done, what it uses, the notes, and what comes next', () => {
    expect(briefStep(plan, 'acid-to-a')).toBe(
      '1 of 4 done. Now acid-to-a: "Add vinegar to cup A." Done when: cup A has turned pink. ' +
        'Uses: vinegar bottle, cup A. Notes: Mention the cup letter. Your note: left-handed. ' +
        'Next: Add base to cup B.',
    );
  });

  it('marks the last step, and an unknown one', () => {
    const last = {
      ...plan,
      focusId: 'compare',
      steps: plan.steps.map((s) => (s.id === 'compare' ? s : { ...s, status: 'done' as const })),
    };
    expect(briefStep(last, 'compare')).toMatch(/4 of 5 done\..*This is the last step\.$/);
    // A step still to do earlier in the list comes next once this one is done.
    expect(briefStep({ ...plan, focusId: 'compare' }, 'compare')).toMatch(/Next: Add vinegar/);
    expect(briefStep(plan, 'nope')).toBe('Step "nope" is not in the plan.');
  });
});

// What a well-behaved planner model returns (the shape of buildPlanJsonSchema), written by hand.

export const modelPlan = () => ({
  title: 'Refill washer fluid',
  summary: 'Open the washer reservoir, pour in fluid, and close it.',
  domain: 'car',
  workspace: { size: [1.2, 0.8], notes: 'Engine bay with the hood open.' },
  objects: [
    {
      id: 'washer_cap',
      label: 'washer cap',
      kind: 'item',
      radius: 0.03,
      placement: { method: 'detect', hint: 'front left of the engine bay' },
      tracking: { query: 'blue cap with a windshield symbol', moves: false },
    },
    {
      id: 'coolant_cap',
      label: 'coolant cap',
      kind: 'item',
      radius: 0.03,
      placement: { method: 'detect' },
      tracking: { query: 'yellow cap with a warning symbol', moves: false },
    },
    {
      id: 'fluid_jug',
      label: 'fluid jug',
      kind: 'container',
      radius: 0.12,
      placement: { method: 'detect' },
      tracking: { query: 'blue plastic jug of washer fluid', moves: true },
    },
  ],
  steps: [
    {
      id: 'open-cap',
      instruction: 'Flip open the blue washer fluid cap.',
      targets: ['washer_cap'],
      hand: 'right',
      action: { verb: 'twist', object: 'washer_cap', direction: 'ccw', amount: 0.5 },
      success: {
        type: 'sequence',
        of: [
          { type: 'pinch_near', object: 'washer_cap' },
          { type: 'confirm', prompt: 'The cap is open' },
        ],
      },
      mistakes: [
        {
          kind: 'wrong_cap',
          message: 'That is the coolant cap. Use the blue one.',
          when: { type: 'hand_near', object: 'coolant_cap', dwellMs: 700 },
        },
      ],
    },
    {
      id: 'pour-fluid',
      instruction: 'Pour the fluid into the reservoir.',
      targets: ['fluid_jug', 'washer_cap'],
      hand: 'both',
      action: { verb: 'pour', object: 'fluid_jug', target: 'washer_cap' },
      success: { type: 'confirm', prompt: 'The reservoir is full' },
      mistakes: [],
      coachNotes: 'Watch the level through the reservoir wall.',
    },
    {
      id: 'close-cap',
      instruction: 'Close the washer fluid cap.',
      targets: ['washer_cap'],
      action: { verb: 'press', object: 'washer_cap' },
      success: { type: 'hand_near', object: 'washer_cap', dwellMs: 500 },
      mistakes: [],
    },
  ],
  warnings: ['Make sure the engine is off and cool.'],
});

/** A revision answer: the remaining steps (reusing an id that is already taken) and one object. */
export const modelRevision = () => ({
  objects: [
    {
      id: 'funnel',
      label: 'funnel',
      kind: 'tool',
      radius: 0.06,
      placement: { method: 'detect' },
      tracking: { query: 'small orange funnel', moves: true },
    },
  ],
  steps: [
    {
      id: 'open-cap',
      instruction: 'Set the funnel in the reservoir neck.',
      targets: ['funnel', 'washer_cap'],
      action: { verb: 'place', object: 'funnel', target: 'washer_cap' },
      success: { type: 'object_near', object: 'funnel', target: 'washer_cap' },
      mistakes: [],
    },
    {
      id: 'pour-slowly',
      instruction: 'Pour the fluid slowly through the funnel.',
      targets: ['fluid_jug', 'funnel'],
      action: { verb: 'pour', object: 'fluid_jug', target: 'funnel' },
      success: { type: 'confirm', prompt: 'The reservoir is full' },
      mistakes: [],
    },
  ],
  warnings: ['Wipe up any spilled fluid.'],
});

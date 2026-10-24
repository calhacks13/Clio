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
      doneWhen: 'The blue cap is flipped open and the reservoir neck is visible.',
      targets: ['washer_cap'],
      hand: 'right',
      action: { verb: 'twist', object: 'washer_cap', direction: 'ccw', amount: 0.5 },
      show: [
        {
          object: 'washer_cap',
          phrase: 'blue washer fluid cap',
          description:
            'Round blue plastic cap with a windshield-spray symbol, at the front left of the ' +
            'engine bay, next to a yellow coolant cap',
        },
      ],
      success: {
        type: 'sequence',
        of: [
          { type: 'pinch_near', object: 'washer_cap' },
          { type: 'confirm', prompt: 'The blue cap is flipped open' },
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
      doneWhen: 'The blue fluid reaches the top mark on the reservoir.',
      targets: ['fluid_jug', 'washer_cap'],
      hand: 'both',
      action: { verb: 'pour', object: 'fluid_jug', target: 'washer_cap' },
      show: [
        {
          object: 'fluid_jug',
          phrase: 'washer fluid jug',
          description: 'Blue plastic jug of washer fluid with a white label, held by the learner',
        },
        {
          object: 'washer_cap',
          phrase: 'washer reservoir opening',
          description:
            'Open neck of the washer fluid reservoir at the front left of the engine bay, its ' +
            'blue cap flipped open',
        },
      ],
      success: { type: 'confirm', prompt: 'The blue fluid reaches the top mark' },
      mistakes: [],
      coachNotes: 'Watch the level through the reservoir wall.',
    },
    {
      id: 'close-cap',
      instruction: 'Close the washer fluid cap.',
      doneWhen: 'The blue cap is shut flat on the reservoir.',
      targets: ['washer_cap'],
      action: { verb: 'press', object: 'washer_cap' },
      show: [
        {
          object: 'washer_cap',
          phrase: 'blue washer fluid cap',
          description: 'Open blue cap on the washer fluid reservoir, front left of the engine bay',
        },
      ],
      success: { type: 'hand_near', object: 'washer_cap', dwellMs: 500 },
      mistakes: [],
    },
  ],
  warnings: ['Make sure the engine is off and cool.'],
});

/**
 * A first-stage answer (buildPlanJsonSchema('first')): every step in outline, the first step's
 * objects as cards, where it saw them, the hazards, then the first step as a card. Points and
 * boxes are Gemini's [y, x] in 0..1000; the fluid jug is seen but not declared yet.
 */
export const modelFirstStage = () => ({
  title: 'Refill washer fluid',
  summary: 'Open the washer reservoir, pour in fluid, and close it.',
  outline: [
    { id: 'open-cap', instruction: 'Flip open the blue washer fluid cap.' },
    { id: 'pour-fluid', instruction: 'Pour the fluid into the reservoir.' },
    { id: 'close-cap', instruction: 'Close the washer fluid cap.' },
  ],
  objects: [
    {
      id: 'washer_cap',
      label: 'washer cap',
      phrase: 'washer fluid cap',
      look:
        'Round blue plastic cap with a windshield-spray symbol, at the front left of the engine ' +
        'bay, next to a yellow coolant cap',
      moves: false,
    },
    {
      id: 'coolant_cap',
      label: 'coolant cap',
      phrase: 'coolant reservoir cap',
      look: 'Yellow plastic cap with a warning symbol, right of the blue washer cap',
      moves: false,
    },
  ],
  sightings: [
    { object: 'washer_cap', view: 1, point: [400, 250], box_2d: [380, 230, 420, 270] },
    { object: 'coolant_cap', view: 2, point: [600, 800], box_2d: [500, 700, 700, 900] },
    { object: 'fluid_jug', view: 2, point: [300, 100], box_2d: [200, 50, 400, 150] },
  ],
  warnings: ['Make sure the engine is off and cool.'],
  firstStep: {
    id: 'open-cap',
    instruction: 'Flip open the blue washer fluid cap.',
    doneWhen: 'The blue cap is flipped open and the reservoir neck is visible.',
    targets: ['washer_cap'],
    action: { verb: 'twist', object: 'washer_cap', direction: 'ccw', amount: 0.5 },
    show: ['washer_cap'],
    mistakes: [
      {
        kind: 'wrong_cap',
        message: 'That is the coolant cap. Use the blue one.',
        object: 'coolant_cap',
      },
    ],
  },
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
      doneWhen: 'The orange funnel sits upright in the reservoir neck.',
      targets: ['funnel', 'washer_cap'],
      action: { verb: 'place', object: 'funnel', target: 'washer_cap' },
      show: [
        {
          object: 'funnel',
          phrase: 'orange funnel',
          description: 'Small orange plastic funnel lying on the fender',
        },
      ],
      success: { type: 'object_near', object: 'funnel', target: 'washer_cap' },
      mistakes: [],
    },
    {
      id: 'pour-slowly',
      instruction: 'Pour the fluid slowly through the funnel.',
      doneWhen: 'The blue fluid reaches the top mark on the reservoir.',
      targets: ['fluid_jug', 'funnel'],
      action: { verb: 'pour', object: 'fluid_jug', target: 'funnel' },
      success: { type: 'confirm', prompt: 'The blue fluid reaches the top mark' },
      mistakes: [],
    },
  ],
  warnings: ['Wipe up any spilled fluid.'],
});

/**
 * A stage rest answer on top of modelFirstStage: the washer cap written again in full, the jug
 * the later steps need, and the revision's steps.
 */
export const modelRestStage = () => {
  const [washerCap, , fluidJug] = modelPlan().objects;
  const revision = modelRevision();
  return { ...revision, objects: [washerCap, fluidJug, ...revision.objects] };
};

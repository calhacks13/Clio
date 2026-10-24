import { ACTION_VERB_NAMES } from '@clio/protocol';

// The planner's structured-output schema, built by hand rather than from zod: Gemini supports
// only a JSON Schema subset (no pattern/maxLength/default/additionalProperties), rejects recursion
// in required fields, and can 400 on very large schemas. It also answers 400 INVALID_ARGUMENT
// when an array of $ref or anyOf items has minItems/maxItems, so those counts go in descriptions.
// Checks are flattened to leaf checks plus ONE level of all/any/sequence over leaves. Anything
// the subset cannot express (slug ids, cross-references, verb arguments, those counts) is
// enforced afterwards by safeParseProcedure, or asked for in the prompt.

export type JsonSchema = { [keyword: string]: unknown };
/** plan: a whole plan. first: an outline and its first step as a card. revision: the rest of one. */
export type PlanSchemaKind = 'plan' | 'first' | 'revision';

const described = (schema: JsonSchema, description?: string): JsonSchema =>
  description ? { ...schema, description } : schema;
const str = (description?: string) => described({ type: 'string' }, description);
const num = (minimum: number, maximum: number, description?: string) =>
  described({ type: 'number', minimum, maximum }, description);
const int = (minimum: number, maximum: number, description?: string) =>
  described({ type: 'integer', minimum, maximum }, description);
const oneOf = (values: readonly string[], description?: string) =>
  described({ type: 'string', enum: [...values] }, description);
const bool = (description?: string) => described({ type: 'boolean' }, description);
const ref = (name: string): JsonSchema => ({ $ref: `#/$defs/${name}` });

function obj(properties: Record<string, JsonSchema>, required: string[], description?: string) {
  const schema: JsonSchema = { type: 'object', properties };
  if (required.length) schema.required = required;
  return described(schema, description);
}

function arr(items: JsonSchema, opts: { min?: number; max?: number; description?: string } = {}) {
  const schema: JsonSchema = { type: 'array', items };
  if (opts.min !== undefined) schema.minItems = opts.min;
  if (opts.max !== undefined) schema.maxItems = opts.max;
  return described(schema, opts.description);
}

const HAND = ['left', 'right', 'either'];
const HAND_POINTS = ['pinch', 'index_tip', 'thumb_tip', 'palm', 'wrist'];
const objectId = str('An object id declared in objects');
const radius = num(0.01, 0.5, 'Meters from the object that count as near');
const dwellMs = int(0, 10_000, 'How long the state must hold, in ms');

const LEAF_CHECKS: JsonSchema[] = [
  obj(
    { type: oneOf(['pinch_near']), object: objectId, hand: oneOf(HAND), radius, dwellMs },
    ['type', 'object'],
    'The hand is pinching within radius of the object',
  ),
  obj(
    {
      type: oneOf(['hand_near']),
      object: objectId,
      hand: oneOf(HAND),
      point: oneOf(HAND_POINTS),
      radius,
      dwellMs,
    },
    ['type', 'object'],
    'A point on the hand stays near the object',
  ),
  obj(
    {
      type: oneOf(['lift']),
      hand: oneOf(HAND),
      point: oneOf(HAND_POINTS),
      height: num(0.02, 1.5, 'Meters above the table'),
      dwellMs,
    },
    ['type'],
    'The hand is raised above the table',
  ),
  obj(
    {
      type: oneOf(['object_near']),
      object: str('A tracked object with tracking.moves = true'),
      target: objectId,
      radius,
      dwellMs,
    },
    ['type', 'object', 'target'],
    'A moving, tracked object is near another object',
  ),
  obj(
    {
      type: oneOf(['confirm']),
      by: oneOf(['coach', 'user', 'either']),
      prompt: str('What must be true, e.g. "the cap is off"'),
    },
    ['type', 'prompt'],
    'The coach or learner confirms a visible result',
  ),
  obj(
    { type: oneOf(['elapsed']), ms: int(1, 600_000) },
    ['type', 'ms'],
    'The step has been active this long',
  ),
];

const DEFS: Record<string, JsonSchema> = {
  leafCheck: { anyOf: LEAF_CHECKS },
  check: {
    anyOf: [
      ref('leafCheck'),
      obj(
        {
          type: oneOf(['all', 'any', 'sequence']),
          of: arr(ref('leafCheck'), { description: '1 to 4 leaf checks' }),
        },
        ['type', 'of'],
        'all: every child at once; any: one child; sequence: children in order',
      ),
    ],
  },
  action: obj(
    {
      verb: oneOf(ACTION_VERB_NAMES, 'See the verb list in the instructions'),
      object: str('The object acted on'),
      target: str('Destination or recipient (place, pour, insert, fold)'),
      hand: oneOf(['left', 'right', 'either', 'both']),
      direction: oneOf(['cw', 'ccw', 'up', 'down', 'toward', 'away', 'left', 'right']),
      amount: num(0.001, 600, 'Turns for twist, meters for lift or pull, seconds for wait'),
      note: str(),
    },
    ['verb'],
  ),
  object: obj(
    {
      id: str('Lowercase slug, e.g. "washer_cap"'),
      label: str('Short spoken name, 1 to 3 words'),
      kind: oneOf(['point', 'item', 'container', 'tool', 'region']),
      partOf: str(
        "Only for a component or a bounded area of a larger declared object: that object's id. " +
          'Leave it out otherwise',
      ),
      description: str(),
      radius: num(0.01, 0.5, 'Approximate size in meters (half the largest dimension)'),
      placement: obj(
        {
          method: oneOf(['detect']),
          hint: str('Where to look, e.g. "front left of the engine bay"'),
        },
        ['method'],
      ),
      tracking: obj(
        {
          query: str(
            'One sentence of 15 to 35 words that finds this one object on its own: color, ' +
              'shape, markings, which one it is among similar things, and where it is',
          ),
          moves: bool('true if it gets picked up and carried during the task'),
        },
        ['query', 'moves'],
      ),
    },
    ['id', 'label', 'kind', 'radius', 'placement', 'tracking'],
  ),
  step: obj(
    {
      id: str('Lowercase slug, unique in the plan, e.g. "open-cap"'),
      instruction: str('One imperative sentence, at most 15 words'),
      doneWhen: str(
        'The finished state as a camera or the learner would see it, one sentence of 3 to 200 ' +
          'characters that names how the right object looks, e.g. "the blue cap is off"',
      ),
      detail: str(),
      targets: arr(str(), { description: 'Ids of the objects this step touches or looks at' }),
      hand: oneOf(['left', 'right', 'either', 'both']),
      action: ref('action'),
      show: arr(
        obj(
          {
            object: objectId,
            phrase: str('2 to 5 words naming it, e.g. "blue washer fluid cap"'),
            description: str(
              'One sentence of 15 to 35 words that finds this one thing in a camera frame on ' +
                'its own: what it is, color, material, shape, size, markings, which one it is ' +
                'among similar things, and where it is at this point in the task',
            ),
          },
          ['object', 'phrase', 'description'],
        ),
        { max: 3, description: 'What Clio outlines in AR during this step, most important first' },
      ),
      success: ref('check'),
      mistakes: arr(
        obj(
          {
            kind: str('Lowercase slug label, e.g. "wrong_bottle"'),
            message: str('A short spoken correction that says how to tell the right one apart'),
            when: ref('check'),
          },
          ['kind', 'message', 'when'],
        ),
        { max: 2, description: 'Likely errors, a look-alike in view first' },
      ),
      coachNotes: str('One or two sentences of advice for the coach'),
      stuckAfterMs: int(5_000, 120_000, 'Offer help after this long'),
    },
    ['id', 'instruction', 'doneWhen', 'targets', 'action', 'show', 'success', 'mistakes'],
  ),
};

const warnings = arr(str(), {
  max: 5,
  description: 'Every hazard in view first, then setup assumptions and other caveats',
});

/** Where the model saw each declared object, in Gemini's own [y, x] 0..1000 convention. */
const sightings = arr(
  obj(
    {
      object: objectId,
      view: int(1, 3, 'Which camera view, numbered from 1 in the order attached'),
      point: arr(int(0, 1000), { min: 2, max: 2, description: '[y, x] on the object, 0 to 1000' }),
      box_2d: arr(int(0, 1000), {
        min: 4,
        max: 4,
        description: '[ymin, xmin, ymax, xmax] around the object, 0 to 1000',
      }),
    },
    ['object', 'view', 'point', 'box_2d'],
  ),
  { description: 'Each declared object you can see, once per view it is in; [] without views' },
);

/**
 * A line of the first stage's outline: just what the step does. The stage "rest" writes the
 * step in full a few seconds later; until then the line is what the coach says comes next.
 */
const outlineLine = obj(
  {
    id: str('Lowercase slug, unique in the plan, e.g. "open-cap"'),
    instruction: str('One imperative sentence, at most 15 words'),
  },
  ['id', 'instruction'],
);

// The first stage writes the first step as a card, not in full: every token is time the learner
// waits. plan-build.ts expands the card into an ordinary step and objects: an object's `look` is
// its detector query and the description its outline is found by, with its `phrase` as the short
// name, a mistake's object becomes a hand_near rule, and the step is confirmed by its done-when.

const cardObject = obj(
  {
    id: str('Lowercase slug, e.g. "yogurt_drink"'),
    label: str('Short spoken name, 1 to 3 words'),
    phrase: str(
      '2 to 5 words naming what it is, like a label on a box, for an object detector, e.g. ' +
        '"washer fluid cap". No colors, positions or verbs',
    ),
    look: str(
      'One sentence of 15 to 35 words that finds this one object in a camera frame on its own: ' +
        'what it is, color, shape, markings, which one it is among similar things (e.g. the ' +
        'leftmost of three), and where it is next to large things that stay put',
    ),
    moves: bool('true if it gets picked up and carried during the task'),
  },
  ['id', 'label', 'phrase', 'look', 'moves'],
);

const cardStep = obj(
  {
    id: str('Lowercase slug, unique in the plan, e.g. "open-cap"'),
    instruction: str('One imperative sentence, at most 15 words'),
    doneWhen: str(
      'The finished state as a camera or the learner would see it, one sentence of 3 to 200 ' +
        'characters that names how the right object looks, e.g. "the blue cap is off"',
    ),
    targets: arr(str(), { description: 'Ids of the objects this step touches or looks at' }),
    action: ref('action'),
    show: arr(objectId, { max: 3, description: 'Objects to outline in AR, most important first' }),
    mistakes: arr(
      obj(
        {
          kind: str('Lowercase slug label, e.g. "wrong_bottle"'),
          message: str('A short spoken correction that says how to tell the right one apart'),
          object: str(
            'The declared object the mistake is made with, e.g. the look-alike; never one this ' +
              'step targets or shows',
          ),
        },
        ['kind', 'message', 'object'],
      ),
      { max: 2, description: 'Likely errors, a look-alike in view first' },
    ),
  },
  ['id', 'instruction', 'doneWhen', 'targets', 'action', 'show', 'mistakes'],
);

/** What every new plan starts with: what it is about, the scene, and the hazards in it. */
const PLAN_HEAD: Record<string, JsonSchema> = {
  title: str('Short lesson title'),
  summary: str('One sentence: what the learner will do'),
  domain: str('e.g. "car", "kitchen", "lab"'),
  workspace: obj(
    {
      size: arr(num(0.1, 5), { min: 2, max: 2, description: '[width, depth] in meters' }),
      notes: str('Setup notes for the learner'),
    },
    ['size'],
  ),
  objects: arr(ref('object'), { description: '1 to 16 objects' }),
  sightings,
  warnings,
};
const PLAN_HEAD_REQUIRED = ['title', 'summary', 'workspace', 'objects', 'sightings', 'warnings'];
const coach = obj({ persona: str(), notes: str() }, []);

export function buildPlanJsonSchema(kind: PlanSchemaKind): JsonSchema {
  if (kind === 'revision') {
    return {
      ...obj(
        {
          objects: arr(ref('object'), {
            description:
              'Only NEW objects, plus any declared object the request asks to write again; at ' +
              'most 16; [] if none',
          }),
          steps: arr(ref('step'), { description: 'The new remaining steps, 1 to 10' }),
          warnings,
        },
        ['objects', 'steps', 'warnings'],
      ),
      $defs: DEFS,
    };
  }
  if (kind === 'first') {
    // The lesson starts on this answer, and every token of it is time the learner waits, so it
    // holds only what the first step needs: the lesson in one line a step (so the first step
    // fits it), the first step's objects and where they are, the hazards, and the first step as
    // a card. The workspace takes its default; the later steps and their objects come with stage
    // rest. Only `action` is a shared definition here, so the other $defs stay out.
    return {
      ...obj(
        {
          title: PLAN_HEAD.title as JsonSchema,
          summary: PLAN_HEAD.summary as JsonSchema,
          outline: arr(outlineLine, {
            min: 1,
            max: 10,
            description: 'Every step in order, 3 to 10: id and instruction; the first is firstStep',
          }),
          objects: arr(cardObject, {
            max: 8,
            description:
              'Only the objects the first step uses and the look-alikes it guards against',
          }),
          sightings,
          warnings,
          firstStep: cardStep,
        },
        ['title', 'summary', 'outline', 'objects', 'sightings', 'warnings', 'firstStep'],
      ),
      $defs: { action: DEFS.action as JsonSchema },
    };
  }
  return {
    ...obj({ ...PLAN_HEAD, steps: arr(ref('step'), { description: '3 to 10 steps' }), coach }, [
      ...PLAN_HEAD_REQUIRED,
      'steps',
    ]),
    $defs: DEFS,
  };
}

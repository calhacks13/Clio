import { ACTION_VERB_NAMES } from '@clio/protocol';

// The planner's structured-output schema, built by hand rather than from zod: Gemini supports
// only a JSON Schema subset (no pattern/maxLength/default/additionalProperties), rejects recursion
// in required fields, and can 400 on very large schemas. So checks are flattened to leaf checks
// plus ONE level of all/any/sequence over leaves. Anything the subset cannot express (slug ids,
// cross-references, verb arguments) is enforced afterwards by safeParseProcedure.

export type JsonSchema = { [keyword: string]: unknown };
export type PlanSchemaKind = 'plan' | 'revision';

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
          of: arr(ref('leafCheck'), { min: 1, max: 4 }),
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
          query: str('What it looks like in the camera images: color, shape, markings'),
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
              'One sentence that finds it in a camera frame on its own: what it is, color, ' +
                'shape, size, markings, and where it is at this point in the task',
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
            message: str('A short spoken correction'),
            when: ref('check'),
          },
          ['kind', 'message', 'when'],
        ),
        { max: 2 },
      ),
      coachNotes: str('One or two sentences of advice for the coach'),
      stuckAfterMs: int(5_000, 120_000, 'Offer help after this long'),
    },
    ['id', 'instruction', 'targets', 'action', 'show', 'success', 'mistakes'],
  ),
};

const warnings = arr(str(), { max: 5, description: 'Safety caveats and setup assumptions' });

export function buildPlanJsonSchema(kind: PlanSchemaKind): JsonSchema {
  if (kind === 'revision') {
    return {
      ...obj(
        {
          objects: arr(ref('object'), { max: 16, description: 'Only NEW objects; [] if none' }),
          steps: arr(ref('step'), { min: 1, max: 10, description: 'The new remaining steps' }),
          warnings,
        },
        ['objects', 'steps', 'warnings'],
      ),
      $defs: DEFS,
    };
  }
  return {
    ...obj(
      {
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
        objects: arr(ref('object'), { min: 1, max: 16 }),
        steps: arr(ref('step'), { min: 3, max: 10 }),
        coach: obj({ persona: str(), notes: str() }, []),
        warnings,
      },
      ['title', 'summary', 'workspace', 'objects', 'steps', 'warnings'],
    ),
    $defs: DEFS,
  };
}

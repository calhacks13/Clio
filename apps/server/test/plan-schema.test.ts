import { ACTION_VERB_NAMES } from '@clio/protocol';
import { describe, expect, it } from 'vitest';
import { buildPlanJsonSchema, type JsonSchema } from '../src/services/plan-schema';

// Gemini structured output supports a subset of JSON Schema, rejects recursion in required
// fields, and can 400 on very large schemas. These tests pin the schema to that subset.

const SUPPORTED = new Set([
  'type',
  'enum',
  'items',
  'prefixItems',
  'properties',
  'required',
  'anyOf',
  'oneOf',
  '$defs',
  '$ref',
  'description',
  'minItems',
  'maxItems',
  'minimum',
  'maximum',
]);

function walk(schema: JsonSchema, visit: (key: string, node: JsonSchema) => void): void {
  for (const [key, value] of Object.entries(schema)) {
    visit(key, schema);
    if (key === 'properties' || key === '$defs') {
      for (const child of Object.values(value as Record<string, JsonSchema>)) walk(child, visit);
    } else if (key === 'items') {
      walk(value as JsonSchema, visit);
    } else if (key === 'anyOf' || key === 'oneOf' || key === 'prefixItems') {
      for (const child of value as JsonSchema[]) walk(child, visit);
    }
  }
}

function refsIn(schema: JsonSchema): string[] {
  const refs: string[] = [];
  walk(schema, (key, node) => {
    if (key === '$ref') refs.push(String(node.$ref).replace('#/$defs/', ''));
  });
  return refs;
}

const defs = (schema: JsonSchema) => schema.$defs as Record<string, JsonSchema>;
const props = (schema: JsonSchema) => schema.properties as Record<string, JsonSchema>;

describe.each(['plan', 'first', 'revision'] as const)('buildPlanJsonSchema(%s)', (kind) => {
  const schema = buildPlanJsonSchema(kind);

  it('uses only the JSON Schema keywords Gemini supports', () => {
    const unsupported = new Set<string>();
    walk(schema, (key) => {
      if (!SUPPORTED.has(key)) unsupported.add(key);
    });
    expect([...unsupported]).toEqual([]);
  });

  it('never bounds an array of $ref or anyOf items, which Gemini rejects with a 400', () => {
    // Found against gemini-3.5-flash-lite: minItems/maxItems on such an array makes the whole
    // request INVALID_ARGUMENT. Counts for those arrays live in descriptions and the prompt.
    const bounded: string[] = [];
    walk(schema, (key, node) => {
      const items = node.items as JsonSchema | undefined;
      if (key !== 'items' || !items || (items.$ref === undefined && items.anyOf === undefined))
        return;
      if (node.minItems !== undefined || node.maxItems !== undefined)
        bounded.push(JSON.stringify(items).slice(0, 40));
    });
    expect(bounded).toEqual([]);
  });

  it('has refs that resolve and never recurse', () => {
    const { $defs: all, ...top } = schema as { $defs: Record<string, JsonSchema> };
    for (const name of refsIn(top)) expect(Object.keys(all)).toContain(name);
    const visiting = new Set<string>();
    const visit = (name: string): void => {
      expect(visiting.has(name), `cycle through ${name}`).toBe(false);
      visiting.add(name);
      for (const next of refsIn(all[name] as JsonSchema)) visit(next);
      visiting.delete(name);
    };
    for (const name of Object.keys(all)) visit(name);
  });

  it('offers every action verb', () => {
    expect((props(defs(schema).action as JsonSchema).verb as { enum: string[] }).enum).toEqual(
      ACTION_VERB_NAMES,
    );
  });
});

// The first stage writes no checks, steps or full objects of its own (it writes cards), so only
// a whole plan and a revision carry those definitions.
describe.each(['plan', 'revision'] as const)('buildPlanJsonSchema(%s) in full', (kind) => {
  const schema = buildPlanJsonSchema(kind);

  it('nests composite checks exactly one level deep, over leaf checks', () => {
    const check = defs(schema).check as { anyOf: JsonSchema[] };
    expect(check.anyOf[0]).toEqual({ $ref: '#/$defs/leafCheck' });
    const composite = props(check.anyOf[1] as JsonSchema);
    expect(composite.type).toEqual({ type: 'string', enum: ['all', 'any', 'sequence'] });
    expect((composite.of as JsonSchema).items).toEqual({ $ref: '#/$defs/leafCheck' });
    const leaves = (defs(schema).leafCheck as { anyOf: JsonSchema[] }).anyOf;
    expect(leaves.map((l) => (props(l).type as { enum: string[] }).enum)).toEqual([
      ['pinch_near'],
      ['hand_near'],
      ['lift'],
      ['object_near'],
      ['confirm'],
      ['elapsed'],
    ]);
    expect(refsIn(defs(schema).leafCheck as JsonSchema)).toEqual([]);
  });

  it('offers detect-only placement with a visual query', () => {
    const object = defs(schema).object as JsonSchema;
    expect(props(props(object).placement as JsonSchema).method).toEqual({
      type: 'string',
      enum: ['detect'],
    });
    expect(object.required).toEqual(['id', 'label', 'kind', 'radius', 'placement', 'tracking']);
    expect((props(object).tracking as JsonSchema).required).toEqual(['query', 'moves']);
    const step = defs(schema).step as JsonSchema;
    expect(step.required).toEqual([
      'id',
      'instruction',
      'doneWhen',
      'targets',
      'action',
      'show',
      'success',
      'mistakes',
    ]);
    expect(props(step).mistakes).toMatchObject({ type: 'array', maxItems: 2 });
  });

  it('asks every step for doneWhen: its finished state, as a camera would see it', () => {
    const step = defs(schema).step as JsonSchema;
    const doneWhen = props(step).doneWhen as JsonSchema;
    expect(doneWhen.type).toBe('string');
    expect(doneWhen.description).toContain('3 to 200 characters');
    expect(doneWhen.description).toContain('as a camera or the learner would see it');
    expect(doneWhen.description).toContain('"the blue cap is off"');
    // Written right after the instruction, before the AR fields.
    const order = Object.keys(props(step));
    expect(order.indexOf('doneWhen')).toBe(order.indexOf('instruction') + 1);
  });

  it('asks each step what to outline: an object, a short phrase and a standalone description', () => {
    const step = defs(schema).step as JsonSchema;
    const show = props(step).show as JsonSchema;
    expect(show).toMatchObject({ type: 'array', maxItems: 3 });
    const item = show.items as JsonSchema;
    expect(Object.keys(props(item))).toEqual(['object', 'phrase', 'description']);
    expect(item.required).toEqual(['object', 'phrase', 'description']);
    // Gemini writes properties in schema order: it decides what to show right after the action.
    const order = Object.keys(props(step));
    expect(order.indexOf('show')).toBe(order.indexOf('action') + 1);
  });
});

describe('plan, first stage and revision', () => {
  it('asks a new plan for every top-level field, and 3 to 10 steps in words', () => {
    const schema = buildPlanJsonSchema('plan');
    expect(schema.required).toEqual([
      'title',
      'summary',
      'workspace',
      'objects',
      'sightings',
      'warnings',
      'steps',
    ]);
    expect(props(schema).steps).toEqual({
      type: 'array',
      items: { $ref: '#/$defs/step' },
      description: '3 to 10 steps',
    });
  });

  it('has a new plan point at its objects and list the hazards before it writes the steps', () => {
    for (const kind of ['plan', 'first'] as const) {
      const order = Object.keys(props(buildPlanJsonSchema(kind)));
      expect(order.indexOf('sightings')).toBe(order.indexOf('objects') + 1);
      expect(order.indexOf('warnings')).toBe(order.indexOf('sightings') + 1);
    }
    const sightings = props(buildPlanJsonSchema('plan')).sightings as JsonSchema;
    const sighting = sightings.items as JsonSchema;
    expect(sighting.required).toEqual(['object', 'view', 'point', 'box_2d']);
    expect(props(sighting).view).toMatchObject({ type: 'integer', minimum: 1, maximum: 3 });
    expect(props(sighting).point).toMatchObject({
      type: 'array',
      items: { type: 'integer', minimum: 0, maximum: 1000 },
      minItems: 2,
      maxItems: 2,
    });
    expect(props(sighting).box_2d).toMatchObject({ minItems: 4, maxItems: 4 });
  });

  it('asks a first stage for the whole lesson in outline, then its first step as a card', () => {
    const schema = buildPlanJsonSchema('first');
    const fields = ['title', 'summary', 'outline', 'objects', 'sightings', 'warnings', 'firstStep'];
    // Gemini writes properties in schema order: the first step comes last, fitted to the rest.
    expect(Object.keys(props(schema))).toEqual(fields);
    expect(schema.required).toEqual(fields);
    // Only the action is shared; the step, object and check definitions would be unused.
    expect(Object.keys(defs(schema))).toEqual(['action']);

    const outline = props(schema).outline as JsonSchema;
    expect(outline).toMatchObject({ type: 'array', minItems: 1, maxItems: 10 });
    const line = outline.items as JsonSchema;
    expect(Object.keys(props(line))).toEqual(['id', 'instruction']);
    expect(line.required).toEqual(['id', 'instruction']);

    const objects = props(schema).objects as JsonSchema;
    expect(objects).toMatchObject({ type: 'array', maxItems: 8 });
    const card = objects.items as JsonSchema;
    expect(Object.keys(props(card))).toEqual(['id', 'label', 'phrase', 'look', 'moves']);
    expect(card.required).toEqual(['id', 'label', 'phrase', 'look', 'moves']);
    expect((props(card).phrase as JsonSchema).description).toContain('2 to 5 words');
    expect((props(card).phrase as JsonSchema).description).toContain('No colors, positions');
    expect(props(card).moves).toMatchObject({ type: 'boolean' });

    const step = props(schema).firstStep as JsonSchema;
    expect(step.required).toEqual([
      'id',
      'instruction',
      'doneWhen',
      'targets',
      'action',
      'show',
      'mistakes',
    ]);
    expect(Object.keys(props(step))).toEqual(step.required);
    expect(props(step).action).toEqual({ $ref: '#/$defs/action' });
    expect(props(step).show).toMatchObject({
      type: 'array',
      maxItems: 3,
      items: { type: 'string', description: 'An object id declared in objects' },
    });
    const mistakes = props(step).mistakes as JsonSchema;
    expect(mistakes).toMatchObject({ type: 'array', maxItems: 2 });
    expect((mistakes.items as JsonSchema).required).toEqual(['kind', 'message', 'object']);
    expect((props(step).doneWhen as JsonSchema).description).toContain('3 to 200 characters');
  });

  it('asks a revision only for new objects, the remaining steps and warnings', () => {
    const schema = buildPlanJsonSchema('revision');
    expect(Object.keys(props(schema))).toEqual(['objects', 'steps', 'warnings']);
    expect(props(schema).steps).toMatchObject({ description: 'The new remaining steps, 1 to 10' });
  });
});

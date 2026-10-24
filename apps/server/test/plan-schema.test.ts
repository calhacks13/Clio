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

describe.each(['plan', 'revision'] as const)('buildPlanJsonSchema(%s)', (kind) => {
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

  it('offers every action verb and detect-only placement with a visual query', () => {
    expect((props(defs(schema).action as JsonSchema).verb as { enum: string[] }).enum).toEqual(
      ACTION_VERB_NAMES,
    );
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
      'targets',
      'action',
      'show',
      'success',
      'mistakes',
    ]);
    expect(props(step).mistakes).toMatchObject({ type: 'array', maxItems: 2 });
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

describe('plan vs revision', () => {
  it('asks a new plan for every top-level field, and 3 to 10 steps in words', () => {
    const schema = buildPlanJsonSchema('plan');
    expect(schema.required).toEqual([
      'title',
      'summary',
      'workspace',
      'objects',
      'steps',
      'warnings',
    ]);
    expect(props(schema).steps).toEqual({
      type: 'array',
      items: { $ref: '#/$defs/step' },
      description: '3 to 10 steps',
    });
  });

  it('asks a revision only for new objects, the remaining steps and warnings', () => {
    const schema = buildPlanJsonSchema('revision');
    expect(Object.keys(props(schema))).toEqual(['objects', 'steps', 'warnings']);
    expect(props(schema).steps).toMatchObject({ description: 'The new remaining steps, 1 to 10' });
  });
});

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildJsonSchemas } from '../src/json-schema';

const schemaDir = join(import.meta.dirname, '..', 'schema');

describe('generated JSON Schemas', () => {
  it('are up to date with the zod sources (run `pnpm gen:schema` if this fails)', async () => {
    const built = buildJsonSchemas();
    expect(Object.keys(built).length).toBeGreaterThan(0);
    for (const [file, schema] of Object.entries(built)) {
      const committed = JSON.parse(await readFile(join(schemaDir, file), 'utf8'));
      expect(committed, file).toEqual(schema);
    }
  });

  it('let authors omit defaulted procedure fields (input schema)', () => {
    const procedure = buildJsonSchemas()['procedure.schema.json'] as {
      required?: string[];
    };
    expect(procedure.required).toContain('steps');
    expect(procedure.required).not.toContain('coach');
  });

  it('keep the optional object fields optional, so older episodes still validate', () => {
    const track = buildJsonSchemas()['object-track.schema.json'] as {
      properties: { objects: { items: { properties: object; required: string[] } } };
    };
    const state = track.properties.objects.items;
    expect(Object.keys(state.properties)).toEqual(
      expect.arrayContaining(['locationFlags', 'heldBy', 'observedT']),
    );
    expect(state.required).toEqual(['id', 'position', 'orientation', 'confidence', 'source']);
    const meta = buildJsonSchemas()['episode-meta.schema.json'] as { required: string[] };
    expect(meta.required).not.toContain('features');
  });
});

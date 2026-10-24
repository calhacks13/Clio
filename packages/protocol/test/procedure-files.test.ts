import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { safeParseProcedure } from '../src/index';

const dir = join(import.meta.dirname, '..', '..', '..', 'procedures');
const files = (await readdir(dir)).filter((f) => f.endsWith('.json'));

describe('procedures/*.json', () => {
  it('has the demo procedures', () => {
    expect(files).toEqual(expect.arrayContaining(['shirt-fold.json', 'ph-indicator.json']));
  });

  it.each(files)('%s is a valid procedure whose id matches its file name', async (file) => {
    const r = safeParseProcedure(JSON.parse(await readFile(join(dir, file), 'utf8')));
    if (!r.ok) throw new Error(r.error);
    expect(`${r.procedure.id}.json`).toBe(file);
  });

  it.each(files)('%s says how every step ends', async (file) => {
    const r = safeParseProcedure(JSON.parse(await readFile(join(dir, file), 'utf8')));
    if (!r.ok) throw new Error(r.error);
    for (const step of r.procedure.steps) expect(step.doneWhen, step.id).toBeTruthy();
  });
});

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  EpisodeEventSchema,
  EpisodeFinishSchema,
  EpisodeMetaSchema,
  FrameRecordSchema,
  ObjectTrackRecordSchema,
} from '../src/index';

// Committed episodes, including ones recorded before the optional object extension, must keep
// parsing with the current schemas.
const root = join(import.meta.dirname, '..', '..', '..', 'fixtures', 'episodes');
const episodes = (await readdir(root, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

function parseOrThrow(schema: z.ZodType, value: unknown, where: string): void {
  const r = schema.safeParse(value);
  if (!r.success) throw new Error(`${where}: ${r.error.message}`);
}

/** Parses every line of an NDJSON file and returns how many there were. */
async function parseLines(dir: string, file: string, schema: z.ZodType): Promise<number> {
  const lines = (await readFile(join(dir, file), 'utf8')).split('\n').filter((l) => l.trim());
  for (const [i, line] of lines.entries()) {
    parseOrThrow(schema, JSON.parse(line), `${file}:${i + 1}`);
  }
  return lines.length;
}

async function parseJson(dir: string, file: string, schema: z.ZodType): Promise<void> {
  parseOrThrow(schema, JSON.parse(await readFile(join(dir, file), 'utf8')), file);
}

describe('fixtures/episodes', () => {
  it('has the synthetic shirt-fold episode', () => {
    expect(episodes).toContain('synthetic-shirt-fold');
  });

  it.each(episodes)('%s parses with the current protocol', async (name) => {
    const dir = join(root, name);
    const files = await readdir(dir);
    await parseJson(dir, 'meta.json', EpisodeMetaSchema);
    expect(await parseLines(dir, 'frames.ndjson', FrameRecordSchema)).toBeGreaterThan(0);
    expect(await parseLines(dir, 'events.ndjson', EpisodeEventSchema)).toBeGreaterThan(0);
    if (files.includes('objects.ndjson')) {
      await parseLines(dir, 'objects.ndjson', ObjectTrackRecordSchema);
    }
    if (files.includes('finish.json')) await parseJson(dir, 'finish.json', EpisodeFinishSchema);
  });
});

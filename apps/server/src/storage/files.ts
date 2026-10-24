import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { link, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// Filesystem helpers for the stores. JSON documents are written atomically (temp file + rename)
// so a crash never leaves half a meta.json behind.

export function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

/** `undefined` when the file does not exist. Throws on unreadable files or invalid JSON. */
export async function readJson(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  return JSON.parse(text);
}

export async function writeJsonAtomic(path: string, value: unknown, pretty = true): Promise<void> {
  const tmp = join(dirname(path), `.${randomUUID()}.tmp`);
  const text = `${pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value)}\n`;
  try {
    await writeFile(tmp, text);
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

/**
 * Creates `path` with `text` only if it does not exist yet. Atomic: the file appears complete or
 * not at all (written to a temp file, then hard-linked). Returns false if `path` already exists.
 */
export async function createFileExclusive(path: string, text: string): Promise<boolean> {
  const tmp = join(dirname(path), `.${randomUUID()}.tmp`);
  await writeFile(tmp, text);
  try {
    await link(tmp, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  } finally {
    await rm(tmp, { force: true });
  }
}

export function toNdjson(records: readonly unknown[]): string {
  let out = '';
  for (const record of records) out += `${JSON.stringify(record)}\n`;
  return out;
}

/** Counts complete lines in the first `size` bytes of a file (0 if it does not exist). */
export async function countLines(path: string, size?: number): Promise<number> {
  if (size === 0) return 0;
  let lines = 0;
  try {
    const stream = createReadStream(path, size === undefined ? {} : { start: 0, end: size - 1 });
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      for (let i = chunk.indexOf(10); i !== -1; i = chunk.indexOf(10, i + 1)) lines++;
    }
  } catch (error) {
    if (isMissing(error)) return 0;
    throw error;
  }
  return lines;
}

import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  type FileHandle,
  link,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
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

/**
 * Counts the newlines in bytes [start, end) of a file, to its end when `end` is omitted (0 if it
 * does not exist). Counts over adjacent ranges add up, so a growing file can be counted in pieces.
 */
export async function countLines(path: string, start = 0, end?: number): Promise<number> {
  if (end !== undefined && end <= start) return 0;
  let lines = 0;
  try {
    const stream = createReadStream(path, end === undefined ? { start } : { start, end: end - 1 });
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      for (let i = chunk.indexOf(10); i !== -1; i = chunk.indexOf(10, i + 1)) lines++;
    }
  } catch (error) {
    if (isMissing(error)) return 0;
    throw error;
  }
  return lines;
}

const TAIL_CHUNK = 4096;

/**
 * The offset just past the last newline in bytes [floor, size) of a file, or `floor` if there is
 * none. Reads backwards from `size`, so it costs one small read when the file ends in a newline.
 */
export async function lastLineEnd(path: string, floor: number, size: number): Promise<number> {
  if (size <= floor) return floor;
  let handle: FileHandle;
  try {
    handle = await open(path, 'r');
  } catch (error) {
    if (isMissing(error)) return floor;
    throw error;
  }
  try {
    const buffer = Buffer.alloc(Math.min(TAIL_CHUNK, size - floor));
    for (let end = size; end > floor; ) {
      const start = Math.max(floor, end - buffer.length);
      const { bytesRead } = await handle.read(buffer, 0, end - start, start);
      const newline = buffer.subarray(0, bytesRead).lastIndexOf(10);
      if (newline !== -1) return start + newline + 1;
      end = start;
    }
    return floor;
  } finally {
    await handle.close();
  }
}

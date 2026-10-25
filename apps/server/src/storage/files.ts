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
import { Readable } from 'node:stream';
import type { z } from 'zod';
import { describeError } from '../log';

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

/** Whether `path` is a regular file; false when it is missing, a directory or unreadable. */
export async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export interface OpenedFile {
  stream: ReadableStream<Uint8Array>;
  bytes: number;
}

/**
 * A file's bytes and size, or null when it does not exist or is not a file. Opened before
 * streaming, so a writer replacing the file mid-request cannot turn a found file into a broken
 * stream: the stream keeps reading the file that was found.
 */
export async function openFile(path: string): Promise<OpenedFile | null> {
  let handle: FileHandle;
  try {
    handle = await open(path, 'r');
  } catch (error) {
    if (isMissing(error) || (error as NodeJS.ErrnoException).code === 'EISDIR') return null;
    throw error;
  }
  let bytes: number;
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      await handle.close();
      return null;
    }
    bytes = info.size;
  } catch (error) {
    await handle.close();
    throw error;
  }
  const stream = Readable.toWeb(handle.createReadStream()) as ReadableStream<Uint8Array>;
  return { stream, bytes };
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

/** invalid: the document exists but cannot be read or fails the schema. */
export type DocRead<T> = { status: 'missing' } | { status: 'invalid' } | { status: 'ok'; doc: T };

/**
 * Reads one kind of JSON document that another program writes (a compile's manifest.json, a
 * scene.json), checked against `schema`. `warn` hears about an invalid one once per version of the
 * file (its mtime and size), not on every status request.
 */
export class DocReader<T> {
  readonly #schema: z.ZodType<T>;
  readonly #warn: (key: string, why: string) => void;
  /** Per key, which invalid version of the file was last warned about. */
  readonly #warned = new Map<string, string>();

  constructor(schema: z.ZodType<T>, warn: (key: string, why: string) => void) {
    this.#schema = schema;
    this.#warn = warn;
  }

  async read(key: string, path: string): Promise<DocRead<T>> {
    let handle: FileHandle;
    try {
      handle = await open(path, 'r');
    } catch (error) {
      if (isMissing(error)) {
        this.#warned.delete(key);
        return { status: 'missing' };
      }
      const code = (error as NodeJS.ErrnoException).code ?? 'error';
      return this.#invalid(key, code, `unreadable (${describeError(error)})`);
    }
    try {
      const { mtimeMs, size } = await handle.stat();
      const version = `${mtimeMs}:${size}`;
      let raw: unknown;
      try {
        raw = JSON.parse(await handle.readFile('utf8'));
      } catch (error) {
        return this.#invalid(key, version, `unreadable (${describeError(error)})`);
      }
      const parsed = this.#schema.safeParse(raw);
      if (!parsed.success) return this.#invalid(key, version, 'does not match the schema');
      this.#warned.delete(key);
      return { status: 'ok', doc: parsed.data };
    } finally {
      await handle.close();
    }
  }

  #invalid(key: string, version: string, why: string): DocRead<T> {
    if (this.#warned.get(key) !== version) {
      this.#warned.set(key, version);
      this.#warn(key, why);
    }
    return { status: 'invalid' };
  }
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

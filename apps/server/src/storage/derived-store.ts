import { type FileHandle, open } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { type CompileManifest, CompileManifestSchema, DERIVED_FILE_NAME } from '@clio/protocol';
import { isSafeId } from '../ids';
import { describeError, type Logger } from '../log';
import { isMissing } from './files';

// <root>/<episodeId>/ manifest.json, tracks.json, environment.json, retarget-<profile>.json, written
// by the pipeline's `clio compile` (docs/data-pipeline.md). The server only reads them: a compile
// replaces them, and the whole directory can be deleted and rebuilt from the raw episode.

/** Raw episode files a compile reads. Its manifest lists the ones that existed, with their sizes. */
export const COMPILE_INPUTS = [
  'meta.json',
  'frames.ndjson',
  'events.ndjson',
  'objects.ndjson',
  'observations.ndjson',
  'finish.json',
  'batches.json',
] as const;

/**
 * Pure: whether the raw files changed since `manifest` was compiled, given the current `sizes` of
 * the compile inputs that exist. Cheap on purpose: a file that appeared, vanished or changed size
 * makes it stale. Raw files only grow, so this catches every late batch; a rewrite that keeps the
 * size (a second finish with same-length values) needs the manifest's hashes to notice.
 */
export function isStale(manifest: CompileManifest, sizes: ReadonlyMap<string, number>): boolean {
  const listed = new Map(manifest.inputs.map((input) => [input.name, input.bytes]));
  return COMPILE_INPUTS.some((name) => listed.get(name) !== sizes.get(name));
}

/**
 * The last compile's manifest.json. invalid: it exists but cannot be read or fails the schema, as
 * one written by an older pipeline: there is a compile, but it needs redoing.
 */
export type ManifestRead =
  | { status: 'missing' }
  | { status: 'invalid' }
  | { status: 'ok'; manifest: CompileManifest };

export interface DerivedStoreOptions {
  logger?: Logger;
}

export class DerivedStore {
  readonly #root: string;
  readonly #logger: Logger | undefined;
  /** Per episode, which invalid manifest (mtime and size) was last warned about. */
  readonly #warned = new Map<string, string>();

  constructor(root: string, options: DerivedStoreOptions = {}) {
    this.#root = root;
    this.#logger = options.logger;
  }

  #path(id: string, name: string): string {
    if (!isSafeId(id) || !isSafeId(name) || !DERIVED_FILE_NAME.test(name)) {
      throw new Error(`Unsafe derived path: ${id}/${name}`);
    }
    return join(this.#root, id, name);
  }

  /** Warns about an invalid manifest once per version of the file, not on every status request. */
  async readManifest(id: string): Promise<ManifestRead> {
    if (!isSafeId(id)) return { status: 'missing' };
    let handle: FileHandle;
    try {
      handle = await open(this.#path(id, 'manifest.json'), 'r');
    } catch (error) {
      if (isMissing(error)) {
        this.#warned.delete(id);
        return { status: 'missing' };
      }
      const code = (error as NodeJS.ErrnoException).code ?? 'error';
      return this.#invalid(id, code, `unreadable (${describeError(error)})`);
    }
    try {
      const { mtimeMs, size } = await handle.stat();
      const version = `${mtimeMs}:${size}`;
      let raw: unknown;
      try {
        raw = JSON.parse(await handle.readFile('utf8'));
      } catch (error) {
        return this.#invalid(id, version, `unreadable (${describeError(error)})`);
      }
      const parsed = CompileManifestSchema.safeParse(raw);
      if (!parsed.success) return this.#invalid(id, version, 'does not match the schema');
      this.#warned.delete(id);
      return { status: 'ok', manifest: parsed.data };
    } finally {
      await handle.close();
    }
  }

  #invalid(id: string, version: string, why: string): ManifestRead {
    if (this.#warned.get(id) !== version) {
      this.#warned.set(id, version);
      this.#logger?.warn(`Episode ${id}: derived manifest.json ${why}; reported as stale`);
    }
    return { status: 'invalid' };
  }

  /**
   * A compiled file's bytes, or null when it does not exist. Rejects a name that DERIVED_FILE_NAME
   * refuses. Opened before streaming, so a compile replacing the file mid-request cannot turn a
   * found file into a broken stream.
   */
  async open(id: string, name: string): Promise<ReadableStream<Uint8Array> | null> {
    const path = this.#path(id, name);
    let handle: FileHandle;
    try {
      handle = await open(path, 'r');
    } catch (error) {
      if (isMissing(error) || (error as NodeJS.ErrnoException).code === 'EISDIR') return null;
      throw error;
    }
    try {
      if (!(await handle.stat()).isFile()) {
        await handle.close();
        return null;
      }
    } catch (error) {
      await handle.close();
      throw error;
    }
    return Readable.toWeb(handle.createReadStream()) as ReadableStream<Uint8Array>;
  }
}

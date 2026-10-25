import { join } from 'node:path';
import { type CompileManifest, CompileManifestSchema, DERIVED_FILE_NAME } from '@clio/protocol';
import { isSafeId } from '../ids';
import type { Logger } from '../log';
import { DocReader, type OpenedFile, openFile } from './files';

// <root>/<episodeId>/ manifest.json, tracks.json, environment.json, shapes.json, room.glb,
// retarget-<profile>.json, written by the pipeline's `clio compile` (docs/data-pipeline.md). The
// server only reads them: a compile replaces them, and the whole directory can be deleted and
// rebuilt from the raw episode.

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
  readonly #manifests: DocReader<CompileManifest>;

  constructor(root: string, options: DerivedStoreOptions = {}) {
    this.#root = root;
    this.#manifests = new DocReader(CompileManifestSchema, (id, why) =>
      options.logger?.warn(`Episode ${id}: derived manifest.json ${why}; reported as stale`),
    );
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
    const read = await this.#manifests.read(id, this.#path(id, 'manifest.json'));
    return read.status === 'ok' ? { status: 'ok', manifest: read.doc } : read;
  }

  /**
   * A compiled file's bytes and size, or null when it does not exist. Rejects a name that
   * DERIVED_FILE_NAME refuses.
   */
  open(id: string, name: string): Promise<OpenedFile | null> {
    return openFile(this.#path(id, name));
  }
}

import { join } from 'node:path';
import {
  type CompileManifest,
  CompileManifestSchema,
  DERIVED_FILE_NAME,
  ROOM_SCAN_MEDIA,
} from '@clio/protocol';
import { isSafeId, isSafeMediaName } from '../ids';
import type { Logger } from '../log';
import { DocReader, type OpenedFile, openFile } from './files';

// <root>/<episodeId>/ manifest.json, tracks.json, environment.json, shapes.json, room.glb,
// retarget-<profile>.json, written by the pipeline's `clio compile` (docs/data-pipeline.md). The
// server only reads them: a compile replaces them, and the whole directory can be deleted and
// rebuilt from the raw episode.

/**
 * Raw episode files a compile reads. Its manifest lists the ones that existed, with their sizes,
 * and the room scans in media/ (ROOM_SCAN_MEDIA) beside them.
 */
export const COMPILE_INPUTS = [
  'meta.json',
  'frames.ndjson',
  'events.ndjson',
  'objects.ndjson',
  'observations.ndjson',
  'finish.json',
  'batches.json',
] as const;

/** Where a compile's media inputs live in the episode: its room scans, as "media/room-scan-1.glb". */
const MEDIA = 'media/';

/**
 * The episode files `isStale` needs the sizes of, as paths inside the episode: the compile inputs,
 * the media files `manifest` lists, and every room scan among `media` (the names in media/), read
 * by that compile or not. Keyframes are not compile inputs.
 */
export function inputsToCheck(manifest: CompileManifest, media: readonly string[]): string[] {
  const names = new Set<string>(COMPILE_INPUTS);
  for (const { name } of manifest.inputs) {
    // One this server cannot stat stays unmeasured, so it counts as vanished.
    if (name.startsWith(MEDIA) && isSafeMediaName(name.slice(MEDIA.length))) names.add(name);
  }
  for (const name of media) if (ROOM_SCAN_MEDIA.test(name)) names.add(MEDIA + name);
  return [...names];
}

/**
 * Pure: whether the raw files changed since `manifest` was compiled, given the current `sizes` of
 * the files `inputsToCheck` names that exist. Cheap on purpose: a compile input or a listed media
 * file that appeared, vanished or changed size makes it stale, and so does a room scan the compile
 * did not read. Raw files only grow, so this catches every late batch; a rewrite that keeps the
 * size (a second finish with same-length values) needs the manifest's hashes to notice.
 */
export function isStale(manifest: CompileManifest, sizes: ReadonlyMap<string, number>): boolean {
  const listed = new Map(manifest.inputs.map((input) => [input.name, input.bytes]));
  if (COMPILE_INPUTS.some((name) => listed.get(name) !== sizes.get(name))) return true;
  for (const [name, bytes] of listed) {
    if (name.startsWith(MEDIA) && sizes.get(name) !== bytes) return true;
  }
  return [...sizes.keys()].some(
    (name) =>
      name.startsWith(MEDIA) && ROOM_SCAN_MEDIA.test(name.slice(MEDIA.length)) && !listed.has(name),
  );
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

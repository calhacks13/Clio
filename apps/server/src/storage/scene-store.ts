import { join } from 'node:path';
import { SCENE_FILE_NAME, type SceneDoc, SceneDocSchema } from '@clio/protocol';
import { isSafeId } from '../ids';
import type { Logger } from '../log';
import { DocReader, type OpenedFile, openFile } from './files';

// <root>/<episodeId>/ scene.json, model-<id>.glb, cad-<id>.json, crop-<id>-<n>.jpg, written by the
// pipeline's `clio scene` (docs/room-scene.md). The server only reads them: a build replaces them,
// and the whole directory can be deleted and built again from the episode and its compile.

/**
 * The last build's scene.json. invalid: it exists but cannot be read or fails the schema, as one
 * written by an older pipeline: there is a scene, but it needs building again.
 */
export type SceneRead =
  | { status: 'missing' }
  | { status: 'invalid' }
  | { status: 'ok'; scene: SceneDoc };

export interface SceneStoreOptions {
  logger?: Logger;
}

export class SceneStore {
  readonly #root: string;
  readonly #docs: DocReader<SceneDoc>;

  constructor(root: string, options: SceneStoreOptions = {}) {
    this.#root = root;
    this.#docs = new DocReader(SceneDocSchema, (id, why) =>
      options.logger?.warn(`Episode ${id}: scene.json ${why}; reported as stale`),
    );
  }

  #path(id: string, name: string): string {
    if (!isSafeId(id) || !isSafeId(name) || !SCENE_FILE_NAME.test(name)) {
      throw new Error(`Unsafe scene path: ${id}/${name}`);
    }
    return join(this.#root, id, name);
  }

  /** Warns about an invalid scene.json once per version of the file, not on every status request. */
  async readScene(id: string): Promise<SceneRead> {
    if (!isSafeId(id)) return { status: 'missing' };
    const read = await this.#docs.read(id, this.#path(id, 'scene.json'));
    return read.status === 'ok' ? { status: 'ok', scene: read.doc } : read;
  }

  /**
   * A scene file's bytes and size, or null when it does not exist. Rejects a name that
   * SCENE_FILE_NAME refuses.
   */
  open(id: string, name: string): Promise<OpenedFile | null> {
    return openFile(this.#path(id, name));
  }
}

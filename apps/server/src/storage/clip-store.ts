import { createReadStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { DemoClip } from '@clio/protocol';
import { isSafeId } from '../ids';
import { exists, writeJsonAtomic } from './files';

// <root>/<procedureId>/<stepId>.json. Re-slicing a step replaces its clip.

export class ClipStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  #path(procedureId: string, stepId: string): string {
    if (!isSafeId(procedureId) || !isSafeId(stepId)) {
      throw new Error(`Unsafe clip path: ${procedureId}/${stepId}`);
    }
    return join(this.#root, procedureId, `${stepId}.json`);
  }

  async save(clip: DemoClip): Promise<void> {
    const path = this.#path(clip.procedureId, clip.stepId);
    await mkdir(join(this.#root, clip.procedureId), { recursive: true });
    // Compact: a clip holds thousands of 200-number hand samples.
    await writeJsonAtomic(path, clip, false);
  }

  /** The stored clip's JSON bytes (validated when written), or null if there is none. */
  async open(procedureId: string, stepId: string): Promise<ReadableStream<Uint8Array> | null> {
    const path = this.#path(procedureId, stepId);
    if (!(await exists(path))) return null;
    return Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>;
  }
}

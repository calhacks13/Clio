import {
  DERIVED_FILE_NAME,
  type EpisodeBatchResponse,
  EpisodeBatchSchema,
  type EpisodeCompileResponse,
  type EpisodeCreateResponse,
  EpisodeCreateSchema,
  type EpisodeDerivedStatus,
  type EpisodeDetailResponse,
  type EpisodeFinishResponseSchema,
  EpisodeFinishSchema,
  type EpisodeListResponse,
} from '@clio/protocol';
import { Hono } from 'hono';
import type { z } from 'zod';
import type { ServerDeps } from '../deps';
import { ApiError, invalidName, notFound, payloadTooLarge } from '../errors';
import { isSafeMediaName } from '../ids';
import { COMPILE_INPUTS, isStale } from '../storage/derived-store';
import { NDJSON_FILES, type NdjsonFile } from '../storage/episode-store';
import { limitBody, parseBody, safeId } from './request';

// Episode ingest (create → batches → finish, plus media), browsing, and the compiled files the
// pipeline writes after an episode finishes. See docs/data-format.md and docs/data-pipeline.md.

// @clio/protocol exports the schema but not this type.
type EpisodeFinishResponse = z.infer<typeof EpisodeFinishResponseSchema>;

export function episodeRoutes({ episodes, derived, compiler, limits }: ServerDeps): Hono {
  const app = new Hono();
  const missing = (id: string) => notFound(`No episode "${id}"`);
  const existing = async (param: string | undefined) => {
    const id = safeId(param, 'episode id');
    if (!(await episodes.exists(id))) throw missing(id);
    return id;
  };

  /** The compiler's queue first; then the manifest on disk, checked against the raw files. */
  const derivedStatus = async (id: string): Promise<EpisodeDerivedStatus> => {
    const job = compiler?.state(id) ?? 'idle';
    const error = compiler?.lastError(id) ?? null;
    const read = await derived.readManifest(id);
    const manifest = read.status === 'ok' ? read.manifest : null;
    if (job !== 'idle') return { state: job, manifest, error };
    // Compiled, but by a pipeline whose manifest this server cannot read, or damaged: recompile it.
    if (read.status === 'invalid') return { state: 'stale', manifest, error };
    if (manifest) {
      const stale = isStale(manifest, await episodes.fileSizes(id, COMPILE_INPUTS));
      return { state: stale ? 'stale' : 'ok', manifest, error };
    }
    return { state: error === null ? 'none' : 'failed', manifest, error };
  };

  app.post('/api/episodes', limitBody(limits.jsonBytes), async (c) => {
    const body = await parseBody(c, EpisodeCreateSchema, 'episode');
    const meta = await episodes.create(body);
    return c.json({ episodeId: meta.episodeId } satisfies EpisodeCreateResponse, 201);
  });

  app.post('/api/episodes/:id/batches', limitBody(limits.batchBytes), async (c) => {
    const id = await existing(c.req.param('id'));
    const batch = await parseBody(c, EpisodeBatchSchema, 'batch');
    const result = await episodes.appendBatch(id, batch);
    if (result === 'not_found') throw missing(id);
    if (result === 'finished') {
      throw new ApiError(409, 'episode_finished', `Episode ${id} is finished; start a new one`);
    }
    return c.json({ ok: true, duplicate: result === 'duplicate' } satisfies EpisodeBatchResponse);
  });

  app.post('/api/episodes/:id/finish', limitBody(limits.jsonBytes), async (c) => {
    const id = await existing(c.req.param('id'));
    const finish = await parseBody(c, EpisodeFinishSchema, 'finish');
    if ((await episodes.finish(id, finish)) === 'not_found') throw missing(id);
    // Not awaited: the compile runs in the background and the headset only waits for this ack. A
    // repeated finish that changed nothing finds the compile up to date (`--if-stale`).
    compiler?.enqueue(id);
    return c.json({ ok: true } satisfies EpisodeFinishResponse);
  });

  app.put('/api/episodes/:id/media/:name', async (c) => {
    const id = safeId(c.req.param('id'), 'episode id');
    const name = c.req.param('name');
    if (!isSafeMediaName(name)) throw invalidName('media name');
    const result = await episodes.writeMedia(id, name, c.req.raw.body, limits.mediaBytes);
    if (result.status === 'not_found') throw missing(id);
    if (result.status === 'too_large') throw payloadTooLarge(limits.mediaBytes);
    // No compile: media is not a compile input (COMPILE_INPUTS).
    return c.json({ ok: true, name, bytes: result.bytes });
  });

  app.post('/api/episodes/:id/compile', async (c) => {
    const id = await existing(c.req.param('id'));
    if (!compiler) {
      throw new ApiError(
        503,
        'compile_not_configured',
        'Compiling is off: set CLIO_COMPILE=auto and install uv on the server',
      );
    }
    // Asked for by hand: compile again even when the compile on disk is up to date.
    compiler.enqueue(id, { force: true });
    const state = compiler.state(id) === 'running' ? 'running' : 'queued';
    return c.json({ ok: true, state } satisfies EpisodeCompileResponse, 202);
  });

  app.get('/api/episodes/:id/derived/:name', async (c) => {
    const id = safeId(c.req.param('id'), 'episode id');
    const name = c.req.param('name');
    if (!DERIVED_FILE_NAME.test(name)) {
      throw new ApiError(
        400,
        'invalid_name',
        'Invalid derived file name: use lowercase letters, digits, ".", "_" or "-", ending in .json or .glb',
      );
    }
    const file = await derived.open(id, name);
    if (!file) throw notFound(`No compiled file "${name}" for episode "${id}"`);
    return c.body(file.stream, 200, fileHeaders(name, file.bytes));
  });

  app.get('/api/episodes', async (c) =>
    c.json({ episodes: await episodes.list() } satisfies EpisodeListResponse),
  );

  app.get('/api/episodes/:id', async (c) => {
    const id = safeId(c.req.param('id'), 'episode id');
    const detail = await episodes.get(id);
    if (!detail) throw missing(id);
    detail.derived = await derivedStatus(id);
    return c.json(detail satisfies EpisodeDetailResponse);
  });

  // `?from=<byte offset>` answers only the lines after that offset. `x-next-from` is the offset to
  // pass next time, so a viewer following a live episode never downloads a line twice.
  app.get('/api/episodes/:id/:file{frames|events|objects|observations}', async (c) => {
    const id = safeId(c.req.param('id'), 'episode id');
    const file = c.req.param('file');
    if (!isNdjsonFile(file)) throw notFound(`No such episode file "${file}"`);
    const opened = await episodes.openNdjson(id, file, byteOffset(c.req.query('from')));
    if (!opened) throw missing(id);
    return c.body(opened.stream, 200, {
      'content-type': 'application/x-ndjson',
      'x-next-from': String(opened.end),
    });
  });

  return app;
}

/** By extension, for the compiled and scene files (DERIVED_FILE_NAME, SCENE_FILE_NAME). */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  json: 'application/json',
  glb: 'model/gltf-binary',
  ply: 'application/octet-stream',
  jpg: 'image/jpeg',
};

function fileHeaders(name: string, bytes: number): Record<string, string> {
  return {
    'content-type':
      CONTENT_TYPES[name.slice(name.lastIndexOf('.') + 1)] ?? 'application/octet-stream',
    // A splat or a room mesh runs to tens of MB: the length lets a viewer show progress.
    'content-length': String(bytes),
    // A compile or a scene build replaces these files in place.
    'cache-control': 'no-store',
  };
}

function isNdjsonFile(value: string): value is NdjsonFile {
  return (NDJSON_FILES as readonly string[]).includes(value);
}

function byteOffset(value: string | undefined): number {
  if (value === undefined) return 0;
  const offset = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(offset)) {
    throw new ApiError(400, 'invalid_offset', 'Invalid from: use a byte offset (a whole number)');
  }
  return offset;
}

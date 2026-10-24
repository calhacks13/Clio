import {
  type EpisodeBatchResponse,
  EpisodeBatchSchema,
  type EpisodeCreateResponse,
  EpisodeCreateSchema,
  type EpisodeFinishResponseSchema,
  EpisodeFinishSchema,
  type EpisodeListResponse,
} from '@clio/protocol';
import { Hono } from 'hono';
import type { z } from 'zod';
import type { ServerDeps } from '../deps';
import { ApiError, invalidName, notFound, payloadTooLarge } from '../errors';
import { isSafeMediaName } from '../ids';
import { NDJSON_FILES, type NdjsonFile } from '../storage/episode-store';
import { limitBody, parseBody, safeId } from './request';

// Episode ingest (create → batches → finish, plus media) and browsing. See docs/data-format.md.

// @clio/protocol exports the schema but not this type.
type EpisodeFinishResponse = z.infer<typeof EpisodeFinishResponseSchema>;

export function episodeRoutes({ episodes, limits }: ServerDeps): Hono {
  const app = new Hono();
  const missing = (id: string) => notFound(`No episode "${id}"`);
  const existing = async (param: string | undefined) => {
    const id = safeId(param, 'episode id');
    if (!(await episodes.exists(id))) throw missing(id);
    return id;
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
    return c.json({ ok: true } satisfies EpisodeFinishResponse);
  });

  app.put('/api/episodes/:id/media/:name', async (c) => {
    const id = safeId(c.req.param('id'), 'episode id');
    const name = c.req.param('name');
    if (!isSafeMediaName(name)) throw invalidName('media name');
    const result = await episodes.writeMedia(id, name, c.req.raw.body, limits.mediaBytes);
    if (result.status === 'not_found') throw missing(id);
    if (result.status === 'too_large') throw payloadTooLarge(limits.mediaBytes);
    return c.json({ ok: true, name, bytes: result.bytes });
  });

  app.get('/api/episodes', async (c) =>
    c.json({ episodes: await episodes.list() } satisfies EpisodeListResponse),
  );

  app.get('/api/episodes/:id', async (c) => {
    const id = safeId(c.req.param('id'), 'episode id');
    const detail = await episodes.get(id);
    if (!detail) throw missing(id);
    return c.json(detail);
  });

  app.get('/api/episodes/:id/:file{frames|events|objects}', async (c) => {
    const id = safeId(c.req.param('id'), 'episode id');
    const file = c.req.param('file');
    if (!isNdjsonFile(file)) throw notFound(`No such episode file "${file}"`);
    const stream = await episodes.openNdjson(id, file);
    if (!stream) throw missing(id);
    return c.body(stream, 200, { 'content-type': 'application/x-ndjson' });
  });

  return app;
}

function isNdjsonFile(value: string): value is NdjsonFile {
  return (NDJSON_FILES as readonly string[]).includes(value);
}

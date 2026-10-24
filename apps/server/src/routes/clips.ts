import {
  ClipsFromEpisodeRequestSchema,
  type ClipsFromEpisodeResponse,
  DemoClipSchema,
} from '@clio/protocol';
import { Hono } from 'hono';
import type { ServerDeps } from '../deps';
import { ApiError, notFound } from '../errors';
import { isSafeId } from '../ids';
import { sliceClips } from '../services/clip-slicer';
import { limitBody, parseBody, safeId } from './request';

// The flywheel: slice a good episode into per-step ghost-hand clips, then serve them.

export function clipRoutes({ episodes, clips, limits, logger }: ServerDeps): Hono {
  const app = new Hono();

  app.post('/api/clips/from-episode', limitBody(limits.jsonBytes), async (c) => {
    const body = await parseBody(c, ClipsFromEpisodeRequestSchema, 'clip request');
    const episodeId = safeId(body.episodeId, 'episode id');
    const meta = await episodes.readMeta(episodeId);
    if (!meta) throw notFound(`No episode "${episodeId}"`);
    if (!meta.procedure) {
      throw new ApiError(400, 'no_procedure', `Episode ${episodeId} has no procedure to slice`);
    }
    safeId(meta.procedure.id, 'procedure id');

    const [frames, events] = await Promise.all([
      episodes.readFrames(episodeId),
      episodes.readEvents(episodeId),
    ]);
    const saved: ClipsFromEpisodeResponse['clips'] = [];
    for (const clip of sliceClips(meta, frames, events, body.stepIds)) {
      const valid = DemoClipSchema.safeParse(clip);
      if (!valid.success || !isSafeId(clip.stepId)) {
        logger.warn(`Episode ${episodeId}: skipped invalid clip for step "${clip.stepId}"`);
        continue;
      }
      await clips.save(valid.data);
      saved.push({
        clipId: clip.clipId,
        stepId: clip.stepId,
        durationMs: clip.durationMs,
        frameCount: clip.frames.length,
      });
    }
    return c.json({ clips: saved } satisfies ClipsFromEpisodeResponse);
  });

  app.get('/api/clips/:procedureId/:stepId', async (c) => {
    const procedureId = safeId(c.req.param('procedureId'), 'procedure id');
    const stepId = safeId(c.req.param('stepId'), 'step id');
    const stream = await clips.open(procedureId, stepId);
    if (!stream) throw notFound(`No clip "${procedureId}/${stepId}"`);
    return c.body(stream, 200, { 'content-type': 'application/json' });
  });

  return app;
}

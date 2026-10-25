import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { DatasetExportRequestSchema } from '@clio/protocol';
import { Hono } from 'hono';
import type { ServerDeps } from '../deps';
import { ApiError, notFound } from '../errors';
import { limitBody, parseBody, safeId } from './request';

export function datasetRoutes({ datasetExporter, episodes, limits }: ServerDeps): Hono {
  const app = new Hono();
  const exporter = () => {
    if (!datasetExporter)
      throw new ApiError(
        503,
        'export_unavailable',
        'Dataset export is unavailable. Install uv and restart the Clio server.',
      );
    return datasetExporter;
  };

  app.post('/api/datasets/exports', limitBody(limits.jsonBytes), async (c) => {
    const service = exporter();
    const request = await parseBody(c, DatasetExportRequestSchema, 'dataset export');
    // Validate the entire selection before starting a job. Finished raw data cannot grow.
    for (const id of request.episodeIds) {
      const detail = await episodes.get(id);
      if (!detail) throw notFound(`No episode "${id}"`);
      if (!detail.finish || detail.summary.frameCount === 0) {
        throw new ApiError(
          409,
          'episode_not_ready',
          `Episode "${id}" must be finished and have frames`,
        );
      }
      if (
        detail.batches &&
        (detail.batches.gaps.length > 0 || detail.batches.received !== detail.finish.batches)
      ) {
        throw new ApiError(409, 'incomplete_episode', `Episode "${id}" has missing batches`);
      }
    }
    c.header('cache-control', 'no-store');
    return c.json(service.create(request), 202);
  });

  app.get('/api/datasets/exports/:id', (c) => {
    const status = exporter().status(safeId(c.req.param('id'), 'export id'));
    if (!status) throw notFound('This export expired or the server restarted. Create it again.');
    c.header('cache-control', 'no-store');
    return c.json(status);
  });

  app.get('/api/datasets/exports/:id/download', async (c) => {
    const id = safeId(c.req.param('id'), 'export id');
    const service = exporter();
    const status = service.status(id);
    if (!status) throw notFound('This export expired or the server restarted. Create it again.');
    const path = service.archive(id);
    if (!path) throw new ApiError(409, 'export_not_ready', 'The dataset is not ready to download');
    const { size } = await stat(path);
    return c.body(Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>, 200, {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="${status.name}.zip"`,
      'content-length': String(size),
      'cache-control': 'no-store',
    });
  });
  return app;
}

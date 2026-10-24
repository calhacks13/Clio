import type { ProcedureListResponse } from '@clio/protocol';
import { Hono } from 'hono';
import type { ServerDeps } from '../deps';
import { notFound } from '../errors';
import { safeId } from './request';

// Curated procedures plus generated plans, as one catalog.

export function procedureRoutes({ procedures }: ServerDeps): Hono {
  const app = new Hono();

  app.get('/api/procedures', async (c) =>
    c.json({ procedures: await procedures.list() } satisfies ProcedureListResponse),
  );

  app.get('/api/procedures/:id', async (c) => {
    const id = safeId(c.req.param('id'), 'procedure id');
    const procedure = await procedures.get(id);
    if (!procedure) throw notFound(`No procedure "${id}"`);
    return c.json(procedure);
  });

  return app;
}

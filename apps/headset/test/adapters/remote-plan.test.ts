import { describe, expect, it } from 'vitest';
import { ApiClient } from '../../src/adapters/net/api-client';
import { RemoteStepChecker, RemoteTemplates } from '../../src/adapters/net/remote-plan';

const procedure = {
  schema: 'clio.procedure/1',
  id: 'ph-indicator',
  version: 1,
  title: 'Acids and bases',
  summary: 'Test an acid and a base with red-cabbage indicator.',
  workspace: { size: [1, 1] },
  objects: [{ id: 'cup_a', label: 'cup A', placement: { method: 'detect' } }],
  steps: [{ id: 'pour', instruction: 'Pour vinegar into cup A.', success: { type: 'confirm' } }],
};

const summary = (id: string, source: 'curated' | 'generated') => ({
  id,
  version: 1,
  title: `Title of ${id}`,
  summary: `Summary of ${id}`,
  stepCount: 3,
  source,
});

/** A server with a few routes; anything else is a 404. */
function server(routes: Record<string, unknown>) {
  const paths: string[] = [];
  const f = (async (url: string) => {
    const path = new URL(url).pathname;
    paths.push(path);
    const body = routes[path];
    return body === undefined
      ? new Response(JSON.stringify({ error: { code: 'not_found', message: 'no' } }), {
          status: 404,
        })
      : new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return { api: new ApiClient('http://server', f), paths };
}

describe('RemoteTemplates', () => {
  it('lists only the curated lessons, as id, title and summary', async () => {
    const { api } = server({
      '/api/procedures': {
        procedures: [
          summary('ph-indicator', 'curated'),
          summary('plan-123', 'generated'),
          summary('shirt-fold', 'curated'),
        ],
      },
    });
    expect(await new RemoteTemplates(api).list()).toEqual([
      { id: 'ph-indicator', title: 'Title of ph-indicator', summary: 'Summary of ph-indicator' },
      { id: 'shirt-fold', title: 'Title of shirt-fold', summary: 'Summary of shirt-fold' },
    ]);
  });

  it('fetches one lesson by id', async () => {
    const { api, paths } = server({ '/api/procedures/ph-indicator': procedure });
    const got = await new RemoteTemplates(api).get('ph-indicator');
    expect(got.id).toBe('ph-indicator');
    expect(got.steps.map((s) => s.id)).toEqual(['pour']);
    expect(paths).toEqual(['/api/procedures/ph-indicator']);
  });

  it('fails for an unknown lesson', async () => {
    const { api } = server({});
    await expect(new RemoteTemplates(api).get('nope')).rejects.toThrow();
  });
});

describe('RemoteStepChecker', () => {
  it('asks the server to judge the step', async () => {
    const answer = {
      verdict: 'unsure',
      observation: 'hands cover the cup',
      model: 'm',
      latencyMs: 5,
    };
    const { api, paths } = server({ '/api/plans/check': answer });
    const checker = new RemoteStepChecker(api);
    expect(
      await checker.check({
        goal: 'Acids and bases',
        step: { id: 'pour', instruction: 'Pour vinegar into cup A.' },
        images: [{ mimeType: 'image/jpeg', data: 'AAAA' }],
      }),
    ).toEqual(answer);
    expect(paths).toEqual(['/api/plans/check']);
  });
});

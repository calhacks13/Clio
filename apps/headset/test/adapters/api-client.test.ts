import type { StepCheckRequest } from '@clio/protocol';
import { describe, expect, it } from 'vitest';
import { ApiClient, ApiRequestError } from '../../src/adapters/net/api-client';

interface Sent {
  url: string;
  method: string | undefined;
  body: unknown;
}

/** A fetch that answers every request with `status` and `body`, and records what was sent. */
function fakeFetch(status: number, body: unknown) {
  const sent: Sent[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    sent.push({
      url,
      method: init?.method,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { f, sent };
}

const request: StepCheckRequest = {
  goal: 'Refill the washer fluid',
  step: { id: 'open-cap', instruction: 'Open the blue cap.', doneWhen: 'the blue cap is off' },
  images: [{ mimeType: 'image/jpeg', data: 'AAAA' }],
};

describe('ApiClient.checkStep', () => {
  it('posts the step and frames to the step check and returns the verdict', async () => {
    const answer = {
      verdict: 'done',
      observation: 'the cap lies on the fender',
      model: 'gemini-test',
      latencyMs: 812,
    };
    const { f, sent } = fakeFetch(200, answer);
    const api = new ApiClient('http://server', f);
    expect(await api.checkStep(request)).toEqual(answer);
    expect(sent).toEqual([{ url: 'http://server/api/plans/check', method: 'POST', body: request }]);
  });

  it('rejects an answer that breaks the contract', async () => {
    const { f } = fakeFetch(200, { verdict: 'maybe', observation: 'x', model: 'm', latencyMs: 1 });
    await expect(new ApiClient('', f).checkStep(request)).rejects.toThrow();
  });

  it('surfaces server errors with their status and code', async () => {
    const { f } = fakeFetch(503, {
      error: { code: 'gemini_not_configured', message: 'Step checks need a Gemini API key' },
    });
    const err = await new ApiClient('', f).checkStep(request).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect(err).toMatchObject({ status: 503, code: 'gemini_not_configured' });
  });
});

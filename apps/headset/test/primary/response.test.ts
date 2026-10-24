import type { Detection, PrimaryRequest, PrimaryResponse } from '@clio/protocol';
import { describe, expect, it } from 'vitest';
import { ApiRequestError } from '../../src/adapters/net/api-client';
import { readAnswer } from '../../src/primary/answer';
import { PRIMARY_PATH, PrimaryClient } from '../../src/primary/client';

const detection: Detection = {
  id: 'primary',
  found: true,
  point: [0.5, 0.55],
  box: [0.4, 0.5, 0.6, 0.6],
  outline: [
    [0.4, 0.5],
    [0.6, 0.5],
    [0.6, 0.6],
    [0.4, 0.6],
  ],
  confidence: 0.82,
};

const response = (over: Partial<PrimaryResponse> = {}): PrimaryResponse => ({
  name: 'micrometer',
  description: 'Green C-frame micrometer with a silver knurled thimble',
  detection,
  model: { picker: 'gemini-flash', finder: 'jev+sam2.1' },
  timings: { pickMs: 900, findMs: 3900 },
  ...over,
});

describe('readAnswer', () => {
  it('outlines a named object the finder found', () => {
    expect(readAnswer(response())).toEqual({ found: true, name: 'micrometer', detection });
  });

  it('has nothing to outline when no object stands out', () => {
    expect(readAnswer(response({ name: null, description: null, detection: null }))).toEqual({
      found: false,
      name: null,
    });
  });

  it('keeps the name but outlines nothing when the finder returned no detection', () => {
    expect(readAnswer(response({ detection: null }))).toEqual({ found: false, name: 'micrometer' });
  });

  it('outlines nothing when the finder says not found or is unsure', () => {
    expect(readAnswer(response({ detection: { ...detection, found: false } })).found).toBe(false);
    expect(readAnswer(response({ detection: { ...detection, confidence: 0.2 } })).found).toBe(
      false,
    );
  });

  it('gives an outline-only detection the box around its outline', () => {
    const answer = readAnswer(response({ detection: { ...detection, box: null, point: null } }));
    expect(answer.found && answer.detection.box).toEqual([0.4, 0.5, 0.6, 0.6]);
  });

  it('needs a box or an outline to draw', () => {
    const pointOnly = { ...detection, box: null, outline: null };
    expect(readAnswer(response({ detection: pointOnly })).found).toBe(false);
  });
});

describe('PrimaryClient', () => {
  const request: PrimaryRequest = {
    image: { mimeType: 'image/jpeg', data: 'AAAA' },
    previous: { name: 'micrometer' },
  };

  it('posts the frame and the last name, and validates the answer', async () => {
    const sent: { url: string; init: RequestInit | undefined }[] = [];
    const client = new PrimaryClient('', async (url, init) => {
      sent.push({ url: String(url), init });
      // The finder may leave the outline out; the contract fills in null.
      const { outline: _, ...withoutOutline } = detection;
      return Response.json(response({ detection: withoutOutline as Detection }));
    });
    const answer = await client.ask(request);
    expect(sent[0]?.url).toBe(PRIMARY_PATH);
    expect(sent[0]?.init?.method).toBe('POST');
    expect(JSON.parse(String(sent[0]?.init?.body))).toEqual(request);
    expect(answer.detection?.outline).toBeNull();
    expect(answer.name).toBe('micrometer');
  });

  it("reports the server's error message", async () => {
    const client = new PrimaryClient('', async () =>
      Response.json(
        { error: { code: 'finder_failed', message: 'jev did not answer' } },
        { status: 502 },
      ),
    );
    const err = await client.ask(request).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect(err).toMatchObject({
      status: 502,
      code: 'finder_failed',
      message: 'jev did not answer',
    });
  });

  it('rejects an answer that breaks the contract', async () => {
    const client = new PrimaryClient('', async () => Response.json({ name: 'cup' }));
    await expect(client.ask(request)).rejects.toThrow();
  });

  it('turns a network failure into an ApiRequestError', async () => {
    const client = new PrimaryClient('', async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(client.ask(request)).rejects.toMatchObject({ status: null, code: 'network' });
  });
});

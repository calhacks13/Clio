import type { FocusRequest, FocusResponse } from '@clio/protocol';
import { describe, expect, it } from 'vitest';
import { ApiClient, ApiRequestError } from '../../src/adapters/net/api-client';
import { RemoteFocusFinder } from '../../src/adapters/net/remote';

// The action focus's line to the server (POST /api/vision/focus): one sharp frame and the step's
// objects out, Robotics-ER 2's boxes, sharper words and the next thing to touch back.

/** A fetch that answers every request with `status` and `body`, and records what was sent. */
function fakeFetch(status: number, body: unknown) {
  const sent: { url: string; method: string | undefined; body: unknown }[] = [];
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

const request: FocusRequest = {
  image: { mimeType: 'image/jpeg', data: '/9j/4AAQ' },
  goal: 'Refill the washer fluid',
  step: { instruction: 'Open the blue cap.', doneWhen: 'the blue cap is off' },
  objects: [
    { id: 'cap', label: 'washer cap', phrase: 'blue washer cap', query: 'Round blue cap' },
    { id: 'jug', label: 'fluid jug', query: 'fluid jug' },
  ],
};

const answer: FocusResponse = {
  detections: [
    {
      id: 'cap',
      found: true,
      box: [0.4, 0.5, 0.5, 0.6],
      point: [0.45, 0.55],
      confidence: 0.86,
      description: 'Round blue plastic cap with a yellow ring, front left of the engine bay',
    },
    { id: 'jug', found: false, box: null, point: null, confidence: 0.1, description: null },
  ],
  action: {
    id: 'cap',
    label: 'washer cap',
    phrase: 'blue washer cap',
    description: 'Round blue plastic cap with a yellow ring',
    found: true,
    box: [0.4, 0.5, 0.5, 0.6],
    point: [0.45, 0.55],
    confidence: 0.86,
  },
  model: 'gemini-robotics-er-2-preview',
  latencyMs: 1640,
};

describe('RemoteFocusFinder', () => {
  it('posts the frame, the step and its objects to the action focus and returns its answer', async () => {
    const { f, sent } = fakeFetch(200, answer);
    const finder = new RemoteFocusFinder(new ApiClient('http://server', f));
    expect(await finder.focus(request)).toEqual(answer);
    expect(sent).toEqual([
      { url: 'http://server/api/vision/focus', method: 'POST', body: request },
    ]);
  });

  it('takes an action item the request never named, with words of its own', async () => {
    const extra = {
      ...answer,
      action: { ...answer.action, id: null, label: 'red reset button', phrase: 'red button' },
    };
    const { f } = fakeFetch(200, extra);
    const focus = await new RemoteFocusFinder(new ApiClient('', f)).focus(request);
    expect(focus.action).toMatchObject({ id: null, label: 'red reset button' });
  });

  it('rejects an answer that breaks the contract', async () => {
    const { f } = fakeFetch(200, { ...answer, detections: [{ id: 'cap', found: 'yes' }] });
    await expect(new RemoteFocusFinder(new ApiClient('', f)).focus(request)).rejects.toThrow();
  });

  it('surfaces a server without a Gemini key, and one past its deadline, with their status', async () => {
    const missing = fakeFetch(503, {
      error: { code: 'gemini_not_configured', message: 'The action focus needs a Gemini key' },
    });
    const late = fakeFetch(504, { error: { code: 'timeout', message: 'Robotics-ER was slow' } });
    const errors = await Promise.all(
      [missing.f, late.f].map((f) =>
        new RemoteFocusFinder(new ApiClient('', f)).focus(request).catch((e: unknown) => e),
      ),
    );
    expect(errors[0]).toBeInstanceOf(ApiRequestError);
    expect(errors).toMatchObject([
      { status: 503, code: 'gemini_not_configured' },
      { status: 504, code: 'timeout' },
    ]);
  });
});

import { describe, expect, it } from 'vitest';
import { type Fetch, NdjsonTail } from '../../src/viewer/api';

/** A server that answers each read with the given body chunks and headers, and logs the URLs. */
function fakeServer(responses: { chunks: string[]; next?: number; status?: number }[]) {
  const urls: string[] = [];
  const fetchFn: Fetch = async (url) => {
    urls.push(url);
    const r = responses.shift();
    if (!r) throw new Error('no more responses');
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of r.chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    const headers = r.next === undefined ? undefined : { 'x-next-from': String(r.next) };
    return new Response(body, { status: r.status ?? 200, headers });
  };
  return { urls, fetchFn };
}

describe('NdjsonTail', () => {
  it('reads from where the last read ended, using the server offset', async () => {
    const { urls, fetchFn } = fakeServer([
      { chunks: ['{"t":1}\n{"t"', ':2}\n'], next: 16 },
      { chunks: [], next: 16 },
      { chunks: ['{"t":3}\n'], next: 24 },
    ]);
    const tail = new NdjsonTail('/api/episodes/ep/frames', fetchFn);
    expect(await tail.read()).toEqual([{ t: 1 }, { t: 2 }]);
    expect(await tail.read()).toEqual([]);
    expect(await tail.read()).toEqual([{ t: 3 }]);
    expect(urls).toEqual([
      '/api/episodes/ep/frames?from=0',
      '/api/episodes/ep/frames?from=16',
      '/api/episodes/ep/frames?from=16',
    ]);
    expect(tail.offset).toBe(24);
  });

  it('counts the bytes it received when the server sends no offset', async () => {
    const { urls, fetchFn } = fakeServer([{ chunks: ['{"text":"é"}\n'] }, { chunks: [] }]);
    const tail = new NdjsonTail('/x', fetchFn);
    expect(await tail.read()).toEqual([{ text: 'é' }]);
    await tail.read();
    expect(urls[1]).toBe('/x?from=14');
  });

  it('without an offset, stops at the last whole line and reads the rest again', async () => {
    const { urls, fetchFn } = fakeServer([{ chunks: ['{"t":1}\n{"t"'] }, { chunks: [':2}\n'] }]);
    const tail = new NdjsonTail('/x', fetchFn);
    expect(await tail.read()).toEqual([{ t: 1 }]);
    expect(tail.offset).toBe(8);
    expect(urls[0]).toBe('/x?from=0');
  });

  it('keeps nothing from a body that fails partway', async () => {
    const urls: string[] = [];
    let fail = true;
    const fetchFn: Fetch = async (url) => {
      urls.push(url);
      const encoder = new TextEncoder();
      const broken = fail;
      fail = false;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('{"t":1}\n{"t"'));
          if (broken) controller.error(new Error('connection reset'));
          else {
            controller.enqueue(encoder.encode(':2}\n'));
            controller.close();
          }
        },
      });
      return new Response(body, { headers: { 'x-next-from': '16' } });
    };
    const tail = new NdjsonTail('/x', fetchFn);
    await expect(tail.read()).rejects.toThrow(/connection reset/);
    expect(tail.offset).toBe(0);
    expect(await tail.read()).toEqual([{ t: 1 }, { t: 2 }]);
    expect(urls).toEqual(['/x?from=0', '/x?from=0']);
    expect(tail.offset).toBe(16);
  });

  it('fails on an error status and keeps its offset', async () => {
    const { urls, fetchFn } = fakeServer([
      { chunks: ['{"t":1}\n'], next: 8 },
      { chunks: ['{}'], status: 500 },
      { chunks: [], next: 8 },
    ]);
    const tail = new NdjsonTail('/x', fetchFn);
    await tail.read();
    await expect(tail.read()).rejects.toThrow(/HTTP 500/);
    await tail.read();
    expect(urls).toEqual(['/x?from=0', '/x?from=8', '/x?from=8']);
  });
});

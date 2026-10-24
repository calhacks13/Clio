import { describe, expect, it } from 'vitest';
import {
  episodeTails,
  type Fetch,
  getEpisode,
  listEpisodes,
  NdjsonTail,
} from '../../src/viewer/api';

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

  it('starts from a given offset', async () => {
    const { urls, fetchFn } = fakeServer([{ chunks: ['{"t":9}\n'], next: 108 }]);
    const tail = new NdjsonTail('/x', fetchFn, { from: 100 });
    expect(tail.offset).toBe(100);
    expect(await tail.read()).toEqual([{ t: 9 }]);
    expect(urls).toEqual(['/x?from=100']);
    expect(tail.offset).toBe(108);
  });

  it('joining inside a line, drops it once and keeps every whole line after it', async () => {
    const { urls, fetchFn } = fakeServer([
      // From the middle of a line, cut again between chunks, with a multi-byte character in it.
      { chunks: ['"é","t":7}', '\n{"t":8}\n{"t"', ':9}\n'], next: 1000 },
      { chunks: ['{"t":10}\n'], next: 1009 },
    ]);
    const tail = new NdjsonTail('/x', fetchFn, { from: 975, skipFirstLine: true });
    expect(await tail.read()).toEqual([{ t: 8 }, { t: 9 }]);
    // Later reads start on a line boundary: nothing more is dropped.
    expect(await tail.read()).toEqual([{ t: 10 }]);
    expect(urls).toEqual(['/x?from=975', '/x?from=1000']);
    expect(tail.corrupt).toBe(0);
  });

  it('keeps waiting to drop the partial line until a line break arrives', async () => {
    const { urls, fetchFn } = fakeServer([
      { chunks: ['abc'] },
      { chunks: [] },
      { chunks: ['abcdef\n{"t":1}\n'] },
      { chunks: ['{"t":2}\n'] },
    ]);
    const tail = new NdjsonTail('/x', fetchFn, { from: 50, skipFirstLine: true });
    expect(await tail.read()).toEqual([]);
    expect(await tail.read()).toEqual([]);
    expect(await tail.read()).toEqual([{ t: 1 }]);
    expect(await tail.read()).toEqual([{ t: 2 }]);
    expect(urls).toEqual(['/x?from=50', '/x?from=50', '/x?from=50', '/x?from=65']);
  });

  it('counts lines that are not JSON', async () => {
    const { fetchFn } = fakeServer([
      { chunks: ['{"t":1}\nnot json\n'], next: 17 },
      { chunks: ['{oops\n'], next: 23 },
    ]);
    const tail = new NdjsonTail('/x', fetchFn);
    expect(await tail.read()).toEqual([{ t: 1 }]);
    await tail.read();
    expect(tail.corrupt).toBe(2);
  });
});

describe('reading through another base path', () => {
  it('puts every read under the base', async () => {
    const urls: string[] = [];
    const fetchFn: Fetch = async (url) => {
      urls.push(url);
      if (url.endsWith('/episodes')) return Response.json({ episodes: [] });
      if (url.includes('?from=')) return new Response('', { headers: { 'x-next-from': '0' } });
      return new Response('{}', { status: 404 });
    };
    expect(await listEpisodes(fetchFn, '/api/clio')).toEqual([]);
    await expect(getEpisode('ep-1', undefined, fetchFn, '/api/clio')).rejects.toThrow(/404/);
    const tails = episodeTails('ep-1', fetchFn, '/api/clio');
    await tails.frames.read();
    await tails.objects.read();
    await listEpisodes(fetchFn);
    expect(urls).toEqual([
      '/api/clio/episodes',
      '/api/clio/episodes/ep-1',
      '/api/clio/episodes/ep-1/frames?from=0',
      '/api/clio/episodes/ep-1/objects?from=0',
      '/api/episodes',
    ]);
    expect(tails.events.url).toBe('/api/clio/episodes/ep-1/events');
    expect(tails.observations.url).toBe('/api/clio/episodes/ep-1/observations');
  });
});

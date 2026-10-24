import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, onTestFinished } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import {
  attachGeminiRelay,
  type GeminiRelayOptions,
  rewriteRelayUrl,
  sanitizeCloseCode,
  truncateReason,
} from '../src/relay/gemini-relay';
import { captureLogger } from './harness';

const LIVE = '/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const GOOGLE = 'wss://generativelanguage.googleapis.com';

describe('rewriteRelayUrl', () => {
  it('maps the relay path to Google and swaps the placeholder key for the real one', () => {
    expect(rewriteRelayUrl(`/gemini${LIVE}?key=relay-placeholder`, 'REAL')).toBe(
      `${GOOGLE}${LIVE}?key=REAL`,
    );
  });

  it('normalizes the double slash the SDK produces for a trailing-slash baseUrl', () => {
    expect(
      rewriteRelayUrl(
        '/gemini//ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=x',
        'REAL',
      ),
    ).toBe(
      `${GOOGLE}/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=REAL`,
    );
  });

  it('drops access_token and keeps other query parameters', () => {
    expect(rewriteRelayUrl(`/gemini${LIVE}?access_token=tok&alt=json&key=x`, 'REAL')).toBe(
      `${GOOGLE}${LIVE}?alt=json&key=REAL`,
    );
  });

  it('uses an injected upstream origin', () => {
    expect(rewriteRelayUrl(`/gemini${LIVE}`, 'REAL', 'ws://127.0.0.1:9')).toBe(
      `ws://127.0.0.1:9${LIVE}?key=REAL`,
    );
  });

  it.each([
    '/gemini/v1beta/models/gemini-3.5-flash-lite:generateContent?key=x',
    '/gemini/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained?access_token=t',
    '/gemini/ws/../../etc/passwd',
    `/geminix${LIVE}`,
    `/other${LIVE}`,
    `${LIVE}`,
    `/gemini${LIVE}/extra`,
    `http://[bad/gemini${LIVE}`,
  ])('refuses %s', (url) => {
    expect(rewriteRelayUrl(url, 'REAL')).toBeNull();
  });
});

describe('sanitizeCloseCode', () => {
  it.each([
    [1000, 1000],
    [1008, 1008],
    [4001, 4001],
    [1005, 1000],
    [1006, 1011],
    [1004, 1011],
    [1015, 1011],
    [999, 1011],
    [5000, 1011],
  ])('%i -> %i', (code, expected) => {
    expect(sanitizeCloseCode(code)).toBe(expected);
  });
});

describe('truncateReason', () => {
  it('keeps short reasons and cuts long ones to 123 bytes without splitting a character', () => {
    expect(truncateReason('bye')).toBe('bye');
    expect(truncateReason('a'.repeat(200))).toBe('a'.repeat(123));
    expect(truncateReason('é'.repeat(70))).toBe('é'.repeat(61));
  });
});

// ---------------------------------------------------------------------------------------------
// Integration: a real HTTP server with the relay attached, and a local fake "Google".

interface FakeUpstream {
  origin: string;
  urls: string[];
  closes: Promise<{ code: number; reason: string }>;
}

async function fakeUpstream({ handshakeDelayMs = 0 } = {}): Promise<FakeUpstream> {
  const wss = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    verifyClient: (_info, done) => setTimeout(() => done(true), handshakeDelayMs),
  });
  await once(wss, 'listening');
  onTestFinished(() => new Promise<void>((resolve) => wss.close(() => resolve())));
  const urls: string[] = [];
  let resolveClose!: (value: { code: number; reason: string }) => void;
  const closes = new Promise<{ code: number; reason: string }>((r) => {
    resolveClose = r;
  });
  wss.on('connection', (ws, req) => {
    urls.push(req.url ?? '');
    ws.on('close', (code, reason) => resolveClose({ code, reason: reason.toString() }));
    ws.on('message', (data, isBinary) => {
      if (!isBinary && data.toString() === 'close-me') ws.close(4001, 'bye from upstream');
      else ws.send(data, { binary: isBinary });
    });
  });
  return { origin: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`, urls, closes };
}

async function relayServer(options: GeminiRelayOptions, extra?: (server: Server) => void) {
  const server = createServer((_req, res) => res.writeHead(404).end());
  const relay = attachGeminiRelay(server, options);
  extra?.(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  onTestFinished(() => {
    relay.close();
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return (server.address() as AddressInfo).port;
}

function connect(port: number, path: string): WebSocket {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  onTestFinished(() => ws.terminate());
  return ws;
}

function closeOf(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) =>
    ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() })),
  );
}

function messages(ws: WebSocket, count: number) {
  return new Promise<Array<{ isBinary: boolean; bytes: number[] }>>((resolve) => {
    const got: Array<{ isBinary: boolean; bytes: number[] }> = [];
    ws.on('message', (data, isBinary) => {
      got.push({ isBinary, bytes: [...(data as Buffer)] });
      if (got.length === count) resolve(got);
    });
  });
}

describe('Gemini Live relay', () => {
  it('injects the real key and relays text and binary frames both ways, in order', async () => {
    // A slow upstream handshake forces the relay to buffer what the client sends first.
    const upstream = await fakeUpstream({ handshakeDelayMs: 50 });
    const logger = captureLogger();
    const port = await relayServer({
      apiKey: 'real-key',
      upstreamOrigin: upstream.origin,
      logger,
      logMessages: true,
    });
    const client = connect(port, `/gemini/${LIVE}?key=placeholder`);
    await once(client, 'open');
    const echoed = messages(client, 2);
    client.send('{"setup":{}}');
    client.send(Buffer.from([0, 1, 2, 255]), { binary: true });

    expect(await echoed).toEqual([
      { isBinary: false, bytes: [...Buffer.from('{"setup":{}}')] },
      { isBinary: true, bytes: [0, 1, 2, 255] },
    ]);
    expect(upstream.urls).toEqual([`${LIVE}?key=real-key`]);
    expect(logger.lines.some((l) => l.includes('setup'))).toBe(true);
    expect(logger.lines.join('\n')).not.toContain('real-key');
  });

  it('passes the upstream close code and reason to the client', async () => {
    const upstream = await fakeUpstream();
    const port = await relayServer({ apiKey: 'real-key', upstreamOrigin: upstream.origin });
    const client = connect(port, `/gemini${LIVE}?key=x`);
    await once(client, 'open');
    const echo = messages(client, 1);
    client.send('ping');
    await echo;
    const closed = closeOf(client);
    client.send('close-me');
    expect(await closed).toEqual({ code: 4001, reason: 'bye from upstream' });
  });

  it('passes the client close code and reason upstream', async () => {
    const upstream = await fakeUpstream();
    const port = await relayServer({ apiKey: 'real-key', upstreamOrigin: upstream.origin });
    const client = connect(port, `/gemini${LIVE}?key=x`);
    await once(client, 'open');
    const echo = messages(client, 1);
    client.send('ping');
    await echo;
    client.close(4002, 'client done');
    expect(await upstream.closes).toEqual({ code: 4002, reason: 'client done' });
  });

  it('closes with 1011 when no Gemini key is configured', async () => {
    const port = await relayServer({ apiKey: null });
    const client = connect(port, `/gemini${LIVE}?key=x`);
    expect(await closeOf(client)).toEqual({ code: 1011, reason: 'Gemini not configured' });
  });

  it('closes with 1011 and a reason when Google cannot be reached', async () => {
    const dead = createServer();
    dead.listen(0, '127.0.0.1');
    await once(dead, 'listening');
    const deadPort = (dead.address() as AddressInfo).port;
    await new Promise<void>((resolve) => dead.close(() => resolve()));

    const port = await relayServer({
      apiKey: 'real-key',
      upstreamOrigin: `ws://127.0.0.1:${deadPort}`,
    });
    const client = connect(port, `/gemini${LIVE}?key=x`);
    const { code, reason } = await closeOf(client);
    expect(code).toBe(1011);
    expect(reason).toMatch(/^Gemini upstream error/);
  });

  it('rejects other paths under /gemini with 404', async () => {
    const port = await relayServer({ apiKey: 'real-key' });
    const client = connect(port, '/gemini/v1beta/models/x:generateContent');
    const [error] = (await once(client, 'error')) as [Error];
    expect(error.message).toMatch(/404/);
  });

  it('leaves upgrades for other paths to other listeners, and rejects them when there are none', async () => {
    const lonely = await relayServer({ apiKey: 'real-key' });
    const rejected = connect(lonely, '/hmr');
    const [error] = (await once(rejected, 'error')) as [Error];
    expect(error.message).toMatch(/404/);

    const other = new WebSocketServer({ noServer: true });
    const shared = await relayServer({ apiKey: 'real-key' }, (server) =>
      server.on('upgrade', (req, socket, head) => {
        if (req.url === '/hmr') other.handleUpgrade(req, socket, head, (ws) => ws.send('hmr'));
      }),
    );
    const hmr = connect(shared, '/hmr');
    const [data] = (await once(hmr, 'message')) as [Buffer];
    expect(data.toString()).toBe('hmr');
  });
});

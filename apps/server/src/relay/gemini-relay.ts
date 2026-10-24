import type { IncomingMessage, Server } from 'node:http';
import { STATUS_CODES } from 'node:http';
import type { Duplex } from 'node:stream';
import { GEMINI_RELAY_PATH } from '@clio/protocol';
import { type RawData, WebSocket, WebSocketServer } from 'ws';
import { describeError, type Logger } from '../log';

// Transparent Gemini Live relay. The headset's SDK uses `baseUrl = <origin>/gemini` with a
// placeholder key, so it opens
//   ws(s)://<origin>/gemini/ws/google.ai.generativelanguage.<v>.GenerativeService.BidiGenerateContent?key=…
// and we forward it to Google with the real key. The key never leaves the laptop, and the headset
// needs no internet of its own (a USB cable to the laptop is enough).

export const GOOGLE_LIVE_ORIGIN = 'wss://generativelanguage.googleapis.com';

const LIVE_PATH =
  /^\/ws\/google\.ai\.generativelanguage\.v\d+[a-z0-9]*\.GenerativeService\.BidiGenerateContent$/;

type ParsedRequest =
  | { kind: 'not_ours' }
  | { kind: 'not_allowed' }
  | { kind: 'live'; path: string; params: URLSearchParams };

function parseRelayRequest(requestUrl: string): ParsedRequest {
  let pathname: string;
  let search: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(requestUrl)) {
    // Absolute-form request target. It runs inside the server's `upgrade` listener, so a
    // malformed one must not throw.
    if (!URL.canParse(requestUrl)) return { kind: 'not_ours' };
    const url = new URL(requestUrl);
    pathname = url.pathname;
    search = url.search;
  } else {
    const q = requestUrl.indexOf('?');
    pathname = q === -1 ? requestUrl : requestUrl.slice(0, q);
    search = q === -1 ? '' : requestUrl.slice(q);
  }
  const path = pathname.replace(/\/{2,}/g, '/');
  if (path !== GEMINI_RELAY_PATH && !path.startsWith(`${GEMINI_RELAY_PATH}/`)) {
    return { kind: 'not_ours' };
  }
  const rest = path.slice(GEMINI_RELAY_PATH.length);
  if (!LIVE_PATH.test(rest)) return { kind: 'not_allowed' };
  return { kind: 'live', path: rest, params: new URLSearchParams(search) };
}

function upstreamUrl(
  path: string,
  params: URLSearchParams,
  apiKey: string,
  origin: string,
): string {
  const query = new URLSearchParams(params);
  query.delete('key');
  query.delete('access_token');
  query.set('key', apiKey);
  return `${origin}${path}?${query.toString()}`;
}

/**
 * Pure: the upstream URL for a relay request, or null when the path is not the allowlisted Live
 * endpoint under GEMINI_RELAY_PATH. Repeated slashes are collapsed; `key` is replaced and
 * `access_token` dropped.
 */
export function rewriteRelayUrl(
  requestUrl: string,
  apiKey: string,
  upstreamOrigin: string = GOOGLE_LIVE_ORIGIN,
): string | null {
  const parsed = parseRelayRequest(requestUrl);
  if (parsed.kind !== 'live') return null;
  return upstreamUrl(parsed.path, parsed.params, apiKey, upstreamOrigin);
}

/** Close codes that may be sent on the wire; reserved ones (1005, 1006, 1015, …) are mapped. */
export function sanitizeCloseCode(code: number): number {
  if (code === 1005) return 1000;
  const sendable =
    (code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) ||
    (code >= 3000 && code <= 4999);
  return sendable ? code : 1011;
}

/** Close reasons are limited to 123 bytes of UTF-8; cut on a character boundary. */
export function truncateReason(reason: string, maxBytes = 123): string {
  const bytes = Buffer.from(reason, 'utf8');
  if (bytes.length <= maxBytes) return reason;
  let end = maxBytes;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}

// ---------------------------------------------------------------------------------------------

export interface GeminiRelayOptions {
  /** null: Live upgrades are accepted and closed with 1011 "Gemini not configured". */
  apiKey: string | null;
  /** Override for tests; defaults to Google. */
  upstreamOrigin?: string;
  logger?: Logger;
  /** One log line per relayed message (direction, type, size). Never content or the key. */
  logMessages?: boolean;
  /** When set, relay upgrades it rejects are refused with 401 (CLIO_ACCESS_KEY, see access.ts). */
  authorize?: (req: IncomingMessage) => boolean;
}

export interface GeminiRelay {
  /** Takes the upgrade if it is under GEMINI_RELAY_PATH; returns false and leaves it otherwise. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  /** Closes every relayed session (server shutdown). */
  close(): void;
}

export function createGeminiRelay(options: GeminiRelayOptions): GeminiRelay {
  const origin = options.upstreamOrigin ?? GOOGLE_LIVE_ORIGIN;
  const logger = options.logger;
  const wss = new WebSocketServer({ noServer: true });
  const sessions = new Set<{ client: WebSocket; upstream: WebSocket }>();

  const relay = (client: WebSocket, url: string, label: string) => {
    const upstream = new WebSocket(url);
    const session = { client, upstream };
    sessions.add(session);
    const pending: Array<[RawData, boolean]> = [];
    const log = options.logMessages
      ? (dir: string, data: RawData, isBinary: boolean) =>
          logger?.info(`gemini relay ${dir} ${messageType(data, isBinary)} (${byteLength(data)} B)`)
      : () => {};

    client.on('message', (data, isBinary) => {
      log('→', data, isBinary);
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
      else if (upstream.readyState === WebSocket.CONNECTING) pending.push([data, isBinary]);
    });
    upstream.on('open', () => {
      logger?.info(`gemini relay: session open (${label})`);
      for (const [data, isBinary] of pending.splice(0)) upstream.send(data, { binary: isBinary });
    });
    upstream.on('message', (data, isBinary) => {
      log('←', data, isBinary);
      if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
    });

    client.on('close', (code, reason) => {
      sessions.delete(session);
      pending.length = 0;
      closeSocket(upstream, code, reason.toString());
    });
    upstream.on('close', (code, reason) => {
      sessions.delete(session);
      logger?.info(`gemini relay: session closed (${label}, upstream ${code})`);
      closeSocket(client, code, reason.toString());
    });
    client.on('error', (error) => {
      logger?.warn(`gemini relay: client error: ${describeError(error)}`);
      closeSocket(upstream, 1011, 'Relay client error');
    });
    upstream.on('error', (error) => {
      // Expected when the client hangs up before Google answered; nothing left to tell anyone.
      if (client.readyState !== WebSocket.OPEN) return;
      logger?.warn(`gemini relay: upstream error: ${describeError(error)}`);
      closeSocket(client, 1011, `Gemini upstream error: ${describeError(error)}`);
    });
  };

  return {
    handleUpgrade(req, socket, head) {
      const parsed = parseRelayRequest(req.url ?? '/');
      if (parsed.kind === 'not_ours') return false;
      // Before the path check, so a client without access learns nothing about the relay.
      if (options.authorize && !options.authorize(req)) {
        logger?.warn('gemini relay: refused an upgrade without the access key');
        reject(socket, 401);
        return true;
      }
      if (parsed.kind === 'not_allowed') {
        reject(socket, 404);
        return true;
      }
      const label = parsed.path.split('.')[3] ?? 'live';
      wss.handleUpgrade(req, socket, head, (client) => {
        if (!options.apiKey) {
          client.close(1011, 'Gemini not configured');
          return;
        }
        relay(client, upstreamUrl(parsed.path, parsed.params, options.apiKey, origin), label);
      });
      return true;
    },
    close() {
      for (const { client, upstream } of sessions) {
        closeSocket(client, 1001, 'Server shutting down');
        upstream.terminate();
      }
      sessions.clear();
      wss.close();
    },
  };
}

/** Hooks the relay into an HTTP server's `upgrade` event. */
export function attachGeminiRelay(server: Server, options: GeminiRelayOptions): GeminiRelay {
  const relay = createGeminiRelay(options);
  server.on('upgrade', (req, socket, head) => {
    try {
      if (relay.handleUpgrade(req, socket, head)) return;
    } catch (error) {
      // A throw here would be an uncaught exception that takes the whole server down.
      options.logger?.error('gemini relay: upgrade failed', error);
      socket.destroy();
      return;
    }
    // Not ours: leave it to another upgrade listener, or refuse it if there is none.
    if (server.listenerCount('upgrade') === 1) reject(socket, 404);
  });
  return relay;
}

function closeSocket(ws: WebSocket, code: number, reason: string): void {
  if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
  else if (ws.readyState === WebSocket.OPEN)
    ws.close(sanitizeCloseCode(code), truncateReason(reason));
}

function reject(socket: Duplex, status: number): void {
  socket.on('error', () => {});
  if (socket.writable) {
    socket.write(
      `HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
  }
  socket.destroy();
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function byteLength(data: RawData): number {
  return toBuffer(data).byteLength;
}

/** The first JSON key of a Live message (`setup`, `serverContent`, …), read from its first bytes. */
function messageType(data: RawData, isBinary: boolean): string {
  const head = toBuffer(data).subarray(0, 64).toString('utf8');
  return /^\s*\{\s*"([A-Za-z_]+)"/.exec(head)?.[1] ?? (isBinary ? 'binary' : 'text');
}

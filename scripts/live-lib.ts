import { randomBytes } from 'node:crypto';

// The pure parts of `pnpm live` (scripts/live.ts): choosing the key and port, reading cloudflared's
// output, and building the links to open on the headset.

export type Env = Record<string, string | undefined>;

export type KeySource = 'environment' | '.env' | 'generated';

const nonBlank = (value: string | undefined) => (value?.trim() ? value.trim() : undefined);

/** CLIO_ACCESS_KEY from the environment (as Node's --env-file does), then .env, else a new one. */
export function chooseAccessKey(
  env: Env,
  dotenv: Env,
  generate: () => string = generateAccessKey,
): { key: string; from: KeySource } {
  const fromEnv = nonBlank(env.CLIO_ACCESS_KEY);
  if (fromEnv) return { key: fromEnv, from: 'environment' };
  const fromFile = nonBlank(dotenv.CLIO_ACCESS_KEY);
  if (fromFile) return { key: fromFile, from: '.env' };
  return { key: generate(), from: 'generated' };
}

/** 96 random bits as 16 URL-safe characters: nothing to encode, and short enough to type in VR. */
export function generateAccessKey(): string {
  return randomBytes(12).toString('base64url');
}

/** --port, then CLIO_SERVER_PORT (environment, then .env), then the server's default. */
export function choosePort(flag: string | undefined, env: Env, dotenv: Env): number {
  const [raw, source] =
    flag !== undefined
      ? [flag, '--port']
      : nonBlank(env.CLIO_SERVER_PORT) !== undefined
        ? [env.CLIO_SERVER_PORT, 'CLIO_SERVER_PORT']
        : [nonBlank(dotenv.CLIO_SERVER_PORT), 'CLIO_SERVER_PORT in .env'];
  if (raw === undefined) return 8787;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${source} must be a port number (1-65535), not "${raw}"`);
  }
  return port;
}

const TUNNEL_URL = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/;

/** The quick tunnel's public URL, from a line of cloudflared's log. */
export function tunnelUrlIn(line: string): string | null {
  return TUNNEL_URL.exec(line)?.[0] ?? null;
}

/** cloudflared logs this once Cloudflare's edge accepts a connection for the tunnel. */
export const isTunnelConnected = (line: string): boolean =>
  line.includes('Registered tunnel connection');

/** cloudflared's startup checks found no way to its edge: outbound port 7844 is blocked. */
export const isNetworkBlocked = (line: string): boolean =>
  line.includes('precheck complete hard_fail=true');

/** What to open on the headset: the first visit trades ?key= for a cookie. */
export function headsetLink(tunnelUrl: string, key: string): string {
  return `${tunnelUrl}/?key=${encodeURIComponent(key)}`;
}

/** Meta's Web Launch: opened on a phone or computer signed in to the headset's Meta account, it
 * opens `link` in Quest Browser on the headset. */
export function webLaunchLink(link: string): string {
  return `https://www.oculus.com/open_url/?${new URLSearchParams({ url: link })}`;
}

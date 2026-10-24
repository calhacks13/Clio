import { type ChildProcess, type SpawnOptions, spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs, parseEnv } from 'node:util';
import {
  chooseAccessKey,
  choosePort,
  type Env,
  headsetLink,
  isNetworkBlocked,
  isTunnelConnected,
  type KeySource,
  tunnelUrlIn,
  webLaunchLink,
} from './live-lib';

// pnpm live [--port <n>]: Clio on a Quest over a public HTTPS URL, served from this laptop, with no
// accounts (docs/deploy.md, option A). It builds the headset app, runs the server on loopback with
// an access key, and opens a Cloudflare quick tunnel to it. Episodes and the Gemini key stay on
// the laptop. Ctrl-C stops the server and the tunnel.
//
// package.json runs this with `node --import tsx`, not the tsx CLI: the CLI relays Ctrl-C itself
// and SIGKILLs a child that doesn't confirm within 30 ms, which cut the cleanup short.

const ROOT = resolve(import.meta.dirname, '..');

class LiveError extends Error {}

/** Running children. Each leaves the set when it exits. */
const children = new Set<ChildProcess>();
let stopping = false;

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { port: { type: 'string' } } });
  const dotenv = readDotenv(join(ROOT, '.env'));
  const port = choosePort(values.port, process.env, dotenv);
  const access = chooseAccessKey(process.env, dotenv);

  if (!hasCloudflared()) {
    throw new LiveError(
      'cloudflared is not installed. On a Mac:\n\n    brew install cloudflared\n',
    );
  }
  if (!(await portIsFree(port))) {
    throw new LiveError(
      `Port ${port} is in use (is pnpm dev running?). Stop it, or pick another: pnpm live --port ${port + 3}`,
    );
  }

  await build();
  const server = startServer(port, access.key);
  await serverReady(port, server);
  console.log('\nOpening a Cloudflare quick tunnel…');
  const url = await startTunnel(port);
  const reached = await reachable(url);
  printLinks(headsetLink(url, access.key), access.from, reached);
}

function readDotenv(path: string): Env {
  return existsSync(path) ? parseEnv(readFileSync(path, 'utf8')) : {};
}

function hasCloudflared(): boolean {
  return !spawnSync('cloudflared', ['--version'], { stdio: 'ignore' }).error;
}

function portIsFree(port: number): Promise<boolean> {
  return new Promise((done) => {
    const probe = createServer();
    probe.once('error', () => done(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => done(true)));
  });
}

function build(): Promise<void> {
  console.log('Building the headset app (pnpm build)…');
  return new Promise((done, failed) => {
    const child = spawn('pnpm', ['build'], { cwd: ROOT, stdio: 'inherit' });
    children.add(child);
    child.on('error', failed);
    child.on('exit', (code) => {
      children.delete(child);
      if (code === 0) done();
      else failed(new LiveError('The build failed (see above).'));
    });
  });
}

/**
 * A long-running child in its own process group, so Ctrl-C reaches only this script, which then
 * stops the children in order. If one exits by itself, everything stops.
 */
function start(
  name: string,
  command: string,
  args: string[],
  options: SpawnOptions,
  lastWords: () => string[] = () => [],
): ChildProcess {
  const child = spawn(command, args, { ...options, detached: true });
  children.add(child);
  const gone = (why: string) => {
    if (!children.delete(child) || stopping) return;
    console.error(`\n${name} stopped unexpectedly (${why}).`);
    for (const line of lastWords()) console.error(`  ${line}`);
    void shutdown(1);
  };
  child.on('error', (error) => gone(error.message));
  child.on('exit', (code, signal) => gone(signal ?? `exit code ${code}`));
  return child;
}

function startServer(port: number, key: string): ChildProcess {
  return start(
    'The server',
    process.execPath,
    [`--env-file-if-exists=${join(ROOT, '.env')}`, '--import', 'tsx', 'src/index.ts'],
    {
      cwd: join(ROOT, 'apps', 'server'),
      // Loopback only: cloudflared, on this laptop, is the one way in. These override .env.
      env: {
        ...process.env,
        CLIO_HOST: '127.0.0.1',
        CLIO_SERVER_PORT: String(port),
        CLIO_ACCESS_KEY: key,
      },
      stdio: ['ignore', 'inherit', 'inherit'],
    },
  );
}

async function serverReady(port: number, server: ChildProcess): Promise<void> {
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  while (!(await answers(`${base}/api/health`, 200))) {
    if (!children.has(server)) throw new LiveError('The server stopped before it was ready.');
    if (Date.now() > deadline) throw new LiveError(`The server did not answer on ${base} in 30 s.`);
    await sleep(200);
  }
  // Never publish an open API: a request without the key must be turned away.
  if (!children.has(server) || !(await answers(`${base}/api/procedures`, 401))) {
    throw new LiveError(
      `${base} is not the gated server this script started. Is port ${port} free?`,
    );
  }
}

const BLOCKED =
  'This network blocks Cloudflare Tunnel (outbound port 7844). Try another network, such as a ' +
  'phone hotspot, or a stable cloud URL (docs/deploy.md).';

/** The tunnel's URL, once cloudflared has printed it and the edge has accepted a connection. */
function startTunnel(port: number): Promise<string> {
  const recent: string[] = [];
  const tunnel = start(
    'The tunnel (cloudflared)',
    'cloudflared',
    // A short grace period: open WebSockets (the coach) would hold up Ctrl-C for 30 s otherwise.
    ['tunnel', '--no-autoupdate', '--grace-period', '1s', '--url', `http://127.0.0.1:${port}`],
    {
      // HTTP/2 over TCP by default: venue and guest Wi-Fi often drop QUIC (UDP), and cloudflared
      // only falls back after a minute of retries. TUNNEL_TRANSPORT_PROTOCOL=quic overrides it.
      env: {
        ...process.env,
        TUNNEL_TRANSPORT_PROTOCOL: process.env.TUNNEL_TRANSPORT_PROTOCOL ?? 'http2',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
    () => recent,
  );
  return new Promise((done, failed) => {
    let url: string | null = null;
    let connected = false;
    let blocked = false;
    const timer = setTimeout(
      () =>
        failed(
          new LiveError(
            blocked ? BLOCKED : `No tunnel after 60 s. cloudflared said:\n${recent.join('\n')}`,
          ),
        ),
      60_000,
    );
    const onLine = (line: string) => {
      recent.push(line);
      if (recent.length > 20) recent.shift();
      if (/\bERR\b/.test(line)) console.error(`[cloudflared] ${line}`);
      if (!blocked && isNetworkBlocked(line)) {
        blocked = true;
        console.error(`\ncloudflared: ${BLOCKED} Still trying for a minute…\n`);
      }
      url ??= tunnelUrlIn(line);
      connected ||= isTunnelConnected(line);
      if (url && connected) {
        clearTimeout(timer);
        done(url);
      }
    };
    for (const stream of [tunnel.stdout, tunnel.stderr]) {
      if (stream) createInterface({ input: stream }).on('line', onLine);
    }
  });
}

/** A new quick tunnel can take a few seconds to answer. */
async function reachable(url: string): Promise<boolean> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await answers(`${url}/api/health`, 200)) return true;
    await sleep(1000);
  }
  return false;
}

async function answers(url: string, status: number): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    await res.body?.cancel();
    return res.status === status;
  } catch {
    return false;
  }
}

function printLinks(link: string, keyFrom: KeySource, reached: boolean): void {
  const bold = (text: string) => (process.stdout.isTTY ? `\x1b[1m${text}\x1b[0m` : text);
  const rule = '─'.repeat(78);
  const keyNote = {
    environment: 'Access key: CLIO_ACCESS_KEY from the environment.',
    '.env': 'Access key: CLIO_ACCESS_KEY from .env.',
    generated: 'Access key: new for this run. Set CLIO_ACCESS_KEY in .env to keep one.',
  }[keyFrom];
  console.log(
    [
      '',
      rule,
      reached
        ? '  Clio is live, over HTTPS.'
        : '  Clio is live, but the tunnel did not answer yet: give it a minute.',
      '',
      '  On the Quest, open this in Quest Browser:',
      '',
      `    ${bold(link)}`,
      '',
      "  Or send it to the headset: open this on a phone or computer signed in to the headset's",
      '  Meta account (Meta Web Launch):',
      '',
      `    ${webLaunchLink(link)}`,
      '',
      `  ${keyNote} The link carries it: share it only with your team.`,
      '  The URL changes on every run. Episodes are saved on this laptop.',
      '  Ctrl-C stops the server and the tunnel.',
      rule,
      '',
    ].join('\n'),
  );
}

let stopRequestedAt = 0;

/** Stops the children (SIGTERM, then SIGKILL after 5 s) and exits. Later calls do nothing. */
async function shutdown(code: number): Promise<void> {
  if (stopping) return;
  stopping = true;
  stopRequestedAt = Date.now();
  const exited = [...children].map((child) => new Promise((done) => child.once('exit', done)));
  for (const child of children) child.kill('SIGTERM');
  await Promise.race([Promise.all(exited), sleep(5000)]);
  forceExit(code);
}

function forceExit(code: number): never {
  for (const child of children) child.kill('SIGKILL');
  process.exit(code);
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => {
    if (!stopping) {
      console.log('\nStopping the server and the tunnel…');
      void shutdown(0);
    } else if (signal !== 'SIGHUP' && Date.now() - stopRequestedAt > 1000) {
      // A second Ctrl-C: stop waiting. pnpm passes the first one on as well, so a copy of it
      // arrives within milliseconds; that one must not count.
      forceExit(0);
    }
  });
}
// The terminal may be gone (closed window): a failed write must not stop the cleanup.
for (const stream of [process.stdout, process.stderr]) stream.on('error', () => {});
// Last resort, if this script dies some other way: never leave a public tunnel running.
process.on('exit', () => {
  for (const child of children) child.kill('SIGKILL');
});

main().catch((error: unknown) => {
  if (stopping) return;
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  void shutdown(1);
});

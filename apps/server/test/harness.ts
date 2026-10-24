import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onTestFinished } from 'vitest';
import { createApp } from '../src/app';
import type { AppDeps } from '../src/deps';
import type { Logger } from '../src/log';
import { ClipStore } from '../src/storage/clip-store';
import { EpisodeStore } from '../src/storage/episode-store';
import { ProcedureStore } from '../src/storage/procedure-store';

// Builds the real app on real stores rooted in a fresh temp dir. Only Gemini-backed services are
// fakes, and tests pass those in explicitly.

export async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'clio-server-'));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

export interface CapturedLogger extends Logger {
  lines: string[];
}

export function captureLogger(): CapturedLogger {
  const lines: string[] = [];
  return {
    lines,
    info: (m) => lines.push(`info ${m}`),
    warn: (m) => lines.push(`warn ${m}`),
    error: (m) => lines.push(`error ${m}`),
  };
}

/** A clock that starts at `iso` and moves forward `stepMs` on every call. */
export function steppingClock(iso: string, stepMs = 0): () => Date {
  let t = Date.parse(iso);
  return () => {
    const now = new Date(t);
    t += stepMs;
    return now;
  };
}

export function sequence(...values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length] ?? 0;
}

export interface HarnessOptions
  extends Partial<Omit<AppDeps, 'episodes' | 'procedures' | 'clips'>> {
  rand?: () => number;
}

export interface Harness {
  dataDir: string;
  proceduresDir: string;
  logger: CapturedLogger;
  episodes: EpisodeStore;
  procedures: ProcedureStore;
  clips: ClipStore;
  request(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<Response>;
  readData(...segments: string[]): Promise<string>;
}

export async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const root = await tempDir();
  const dataDir = join(root, 'data');
  const proceduresDir = join(root, 'procedures');
  await mkdir(proceduresDir, { recursive: true });
  const logger = captureLogger();
  const { rand, ...deps } = options;
  const now = deps.now ?? (() => new Date());
  const episodes = new EpisodeStore(join(dataDir, 'episodes'), { now, rand, logger });
  const procedures = new ProcedureStore({
    curatedDir: proceduresDir,
    plansDir: join(dataDir, 'plans'),
    logger,
  });
  const clips = new ClipStore(join(dataDir, 'clips'));
  const app = createApp({
    version: '9.9.9-test',
    liveModel: 'live-test',
    logger,
    ...deps,
    now,
    episodes,
    procedures,
    clips,
  });
  return {
    dataDir,
    proceduresDir,
    logger,
    episodes,
    procedures,
    clips,
    request(method, path, body, headers = {}) {
      const init: RequestInit = { method, headers };
      if (body instanceof Uint8Array || typeof body === 'string') {
        init.body = body;
      } else if (body !== undefined) {
        init.body = JSON.stringify(body);
        init.headers = { 'content-type': 'application/json', ...headers };
      }
      return Promise.resolve(app.request(path, init));
    },
    readData: (...segments) => readFile(join(dataDir, ...segments), 'utf8'),
  };
}

export function ndjsonLines(text: string): unknown[] {
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line));
}

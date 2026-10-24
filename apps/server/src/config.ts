import { statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { prettifyError, z } from 'zod';

/** The monorepo root. pnpm runs scripts with cwd `apps/server`, so never resolve against cwd. */
export const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');

/** Where `pnpm build` puts the headset app, relative to the repo root. */
export const HEADSET_BUILD_DIR = join('apps', 'headset', 'dist');

export const DEFAULT_LIVE_MODEL = 'gemini-3.8-live';
export const DEFAULT_PLANNER_MODEL = 'gemini-3.5-flash-lite';
export const DEFAULT_VISION_MODEL = 'gemini-3.5-flash-lite';

export interface Config {
  port: number;
  host: string;
  /** Absolute. Episodes, clips and generated plans live here. */
  dataDir: string;
  /** Absolute. Curated procedures (`procedures/*.json`). */
  proceduresDir: string;
  /** Absolute. The built headset app, served at `/` (docs/deploy.md). null: not served. */
  staticDir: string | null;
  /** Shared secret for public URLs: /api and the relay require it. null: no gate. */
  accessKey: string | null;
  /** null when unset or blank: the coach, planner and vision endpoints answer 503. */
  geminiApiKey: string | null;
  liveModel: string;
  plannerModel: string;
  visionModel: string;
  /** An external object finder (e.g. jev). When set, it answers /api/vision/locate, not Gemini. */
  visionUrl: string | null;
  /** Bearer token for visionUrl, if it needs one. */
  visionToken: string | null;
  /** Log one line per relayed Live message (type and size only, never content or the key). */
  relayLog: boolean;
}

// `.env.example` ships `KEY=` lines, so a blank value means "use the default".
const blank = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const text = (fallback: string) => z.preprocess(blank, z.string().trim().default(fallback));
const optionalText = z.preprocess(blank, z.string().trim().optional());
const optionalHttpUrl = z.preprocess(
  blank,
  z
    .string()
    .trim()
    .pipe(z.url({ protocol: /^https?$/, error: 'Expected an http:// or https:// URL' }))
    .optional(),
);

const EnvSchema = z.object({
  CLIO_SERVER_PORT: z.preprocess(blank, z.coerce.number().int().min(1).max(65535).default(8787)),
  CLIO_HOST: text('127.0.0.1'),
  CLIO_DATA_DIR: optionalText,
  CLIO_PROCEDURES_DIR: optionalText,
  CLIO_STATIC_DIR: optionalText,
  CLIO_ACCESS_KEY: optionalText,
  GEMINI_API_KEY: optionalText,
  GEMINI_LIVE_MODEL: text(DEFAULT_LIVE_MODEL),
  GEMINI_PLANNER_MODEL: text(DEFAULT_PLANNER_MODEL),
  GEMINI_VISION_MODEL: text(DEFAULT_VISION_MODEL),
  CLIO_VISION_URL: optionalHttpUrl,
  CLIO_VISION_TOKEN: optionalText,
  CLIO_RELAY_LOG: optionalText,
});

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  repoRoot: string = REPO_ROOT,
): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid server environment:\n${prettifyError(parsed.error)}`);
  }
  const e = parsed.data;
  const dir = (value: string | undefined, fallback: string) =>
    value === undefined ? resolve(repoRoot, fallback) : resolveFrom(repoRoot, value);
  return {
    port: e.CLIO_SERVER_PORT,
    host: e.CLIO_HOST,
    dataDir: dir(e.CLIO_DATA_DIR, 'data'),
    proceduresDir: dir(e.CLIO_PROCEDURES_DIR, 'procedures'),
    staticDir: staticDir(e.CLIO_STATIC_DIR, repoRoot),
    accessKey: e.CLIO_ACCESS_KEY ?? null,
    geminiApiKey: e.GEMINI_API_KEY ?? null,
    liveModel: e.GEMINI_LIVE_MODEL,
    plannerModel: e.GEMINI_PLANNER_MODEL,
    visionModel: e.GEMINI_VISION_MODEL,
    visionUrl: e.CLIO_VISION_URL ?? null,
    visionToken: e.CLIO_VISION_TOKEN ?? null,
    relayLog: e.CLIO_RELAY_LOG === '1' || e.CLIO_RELAY_LOG === 'true',
  };
}

function resolveFrom(root: string, value: string): string {
  return isAbsolute(value) ? value : resolve(root, value);
}

/** CLIO_STATIC_DIR, which must exist; otherwise the headset build, once there is one. */
function staticDir(value: string | undefined, repoRoot: string): string | null {
  if (value === undefined) {
    const built = resolve(repoRoot, HEADSET_BUILD_DIR);
    return isDirectory(built) ? built : null;
  }
  const dir = resolveFrom(repoRoot, value);
  if (!isDirectory(dir)) {
    throw new Error(`Invalid server environment:\n✖ CLIO_STATIC_DIR is not a directory: ${dir}`);
  }
  return dir;
}

const isDirectory = (path: string) =>
  statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;

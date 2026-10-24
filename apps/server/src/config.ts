import { isAbsolute, resolve } from 'node:path';
import { prettifyError, z } from 'zod';

/** The monorepo root. pnpm runs scripts with cwd `apps/server`, so never resolve against cwd. */
export const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');

export const DEFAULT_LIVE_MODEL = 'gemini-3.8-live';
export const DEFAULT_PLANNER_MODEL = 'gemini-3.5-flash-lite';
export const DEFAULT_VISION_MODEL = 'gemini-3.5-flash-lite';
/** The jev + SAM 2.1 service that outlines the main object for /api/vision/primary. */
export const DEFAULT_PRIMARY_FINDER_URL = 'http://127.0.0.1:8790/locate';
/** The visualizer viewer (`pnpm visualizer:dev`) open in a browser on this laptop. */
export const DEFAULT_CORS_ORIGINS: readonly string[] = [
  'http://127.0.0.1:3001',
  'http://localhost:3001',
];

export interface Config {
  port: number;
  host: string;
  /** Absolute. Episodes, clips and generated plans live here. */
  dataDir: string;
  /** Absolute. Curated procedures (`procedures/*.json`). */
  proceduresDir: string;
  /** null when unset or blank: the coach, planner and vision endpoints answer 503. */
  geminiApiKey: string | null;
  liveModel: string;
  plannerModel: string;
  visionModel: string;
  /** An external object finder (e.g. jev). When set, it answers /api/vision/locate, not Gemini. */
  visionUrl: string | null;
  /** Bearer token for visionUrl, if it needs one. */
  visionToken: string | null;
  /** The object finder for /api/vision/primary. Gemini's locator stands in when it is down. */
  primaryFinderUrl: string;
  /** Log one line per relayed Live message (type and size only, never content or the key). */
  relayLog: boolean;
  /** Browser origins that may call /api cross-origin. Other websites' requests are refused. */
  corsOrigins: string[];
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
// A browser's Origin header is exactly scheme://host[:port], so any other entry could never match.
const httpOrigin = z.string().refine(isHttpOrigin, {
  error: 'Expected an origin such as http://127.0.0.1:3001 (http or https, no path)',
});
const originList = (fallback: readonly string[]) =>
  z.preprocess(
    blank,
    z
      .string()
      .default(fallback.join(','))
      .transform((v) =>
        v
          .split(',')
          .map((origin) => origin.trim())
          .filter((origin) => origin !== ''),
      )
      .pipe(z.array(httpOrigin).min(1, { error: 'List at least one origin, or leave it blank' })),
  );

const EnvSchema = z.object({
  CLIO_SERVER_PORT: z.preprocess(blank, z.coerce.number().int().min(1).max(65535).default(8787)),
  CLIO_HOST: text('127.0.0.1'),
  CLIO_DATA_DIR: optionalText,
  CLIO_PROCEDURES_DIR: optionalText,
  GEMINI_API_KEY: optionalText,
  GEMINI_LIVE_MODEL: text(DEFAULT_LIVE_MODEL),
  GEMINI_PLANNER_MODEL: text(DEFAULT_PLANNER_MODEL),
  GEMINI_VISION_MODEL: text(DEFAULT_VISION_MODEL),
  CLIO_VISION_URL: optionalHttpUrl,
  CLIO_VISION_TOKEN: optionalText,
  CLIO_PRIMARY_FINDER_URL: optionalHttpUrl,
  CLIO_RELAY_LOG: optionalText,
  CLIO_CORS_ORIGINS: originList(DEFAULT_CORS_ORIGINS),
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
    geminiApiKey: e.GEMINI_API_KEY ?? null,
    liveModel: e.GEMINI_LIVE_MODEL,
    plannerModel: e.GEMINI_PLANNER_MODEL,
    visionModel: e.GEMINI_VISION_MODEL,
    visionUrl: e.CLIO_VISION_URL ?? null,
    visionToken: e.CLIO_VISION_TOKEN ?? null,
    primaryFinderUrl: e.CLIO_PRIMARY_FINDER_URL ?? DEFAULT_PRIMARY_FINDER_URL,
    relayLog: e.CLIO_RELAY_LOG === '1' || e.CLIO_RELAY_LOG === 'true',
    corsOrigins: e.CLIO_CORS_ORIGINS,
  };
}

function resolveFrom(root: string, value: string): string {
  return isAbsolute(value) ? value : resolve(root, value);
}

function isHttpOrigin(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === value;
}

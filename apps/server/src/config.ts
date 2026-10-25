import { isAbsolute, resolve } from 'node:path';
import { type ModelBackend, ModelBackendSchema } from '@clio/protocol';
import { prettifyError, z } from 'zod';

/** The monorepo root. pnpm runs scripts with cwd `apps/server`, so never resolve against cwd. */
export const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');

export const DEFAULT_LIVE_MODEL = 'gemini-3.8-live';
/** Gemini Robotics-ER 2: embodied reasoning (pointing, success detection, task plans). */
export const ROBOTICS_ER_MODEL = 'gemini-robotics-er-2-preview';
export const DEFAULT_PLANNER_MODEL = ROBOTICS_ER_MODEL;
export const DEFAULT_VISION_MODEL = ROBOTICS_ER_MODEL;
/** The smart model the voice coach asks for a closer look (look_closer, POST /api/scene/ask). */
export const DEFAULT_SCENE_MODEL = ROBOTICS_ER_MODEL;
/** The planner bench's judge: a stronger model than the planner it grades. */
export const DEFAULT_JUDGE_MODEL = 'gemini-pro-latest';
/** The finder that outlines the main object for /api/vision/primary: tracker/ (jev + YOLOE-26). */
export const DEFAULT_PRIMARY_FINDER_URL = 'http://127.0.0.1:8790/locate';
/** The bundled example arm, so compiles retarget before a real robot is chosen. Repo-relative. */
export const DEFAULT_RETARGET_PROFILE =
  'pipeline/src/clio_pipeline/retarget/profiles/clio-arm-6dof.json';
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
  /** Answers the voice coach's closer looks. */
  sceneModel: string;
  /** Grades planner bench runs against their expectations (docs/planner-bench.md). */
  judgeModel: string;
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
  /** auto: compile each finished episode with the pipeline when uv is installed. off: never. */
  compile: 'auto' | 'off';
  /** Absolute. The pipeline project that provides `clio compile` (`uv run --project`). */
  pipelineDir: string;
  /** Absolute robot profile files, each compiled into retarget-<profile>.json. Empty: none. */
  retargetProfiles: string[];
  /**
   * auto: after each compile, build the episode's scene (`clio scene`: a model of every object).
   * off: never. Builds follow compiles, so they are off whenever compiling is.
   */
  scene: 'auto' | 'off';
  /** How scene builds make object models: triposr (TripoSR on this machine) unless set. */
  sceneModels: ModelBackend;
  /** How long one scene build may run; null for the builder's default. */
  sceneTimeoutMs: number | null;
}

// `.env.example` ships `KEY=` lines, so a blank value means "use the default".
const blank = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const text = (fallback: string) => z.preprocess(blank, z.string().trim().default(fallback));
const optionalText = z.preprocess(blank, z.string().trim().optional());
const autoOrOff = () =>
  z.preprocess(
    blank,
    z
      .string()
      .trim()
      .pipe(z.enum(['auto', 'off']))
      .default('auto'),
  );
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

const DAY_MS = 24 * 60 * 60_000;

const commaList = (v: string) =>
  v
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
// `none` turns retargeting off; unset means the bundled example arm.
const profileList = z.preprocess(
  blank,
  z
    .string()
    .transform(commaList)
    .pipe(z.array(z.string()).min(1, { error: 'List at least one profile file, or none' }))
    .optional(),
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
  GEMINI_SCENE_MODEL: text(DEFAULT_SCENE_MODEL),
  GEMINI_JUDGE_MODEL: text(DEFAULT_JUDGE_MODEL),
  CLIO_VISION_URL: optionalHttpUrl,
  CLIO_VISION_TOKEN: optionalText,
  CLIO_PRIMARY_FINDER_URL: optionalHttpUrl,
  CLIO_RELAY_LOG: optionalText,
  CLIO_CORS_ORIGINS: originList(DEFAULT_CORS_ORIGINS),
  CLIO_COMPILE: autoOrOff(),
  CLIO_PIPELINE_DIR: optionalText,
  CLIO_RETARGET_PROFILES: profileList,
  CLIO_SCENE: autoOrOff(),
  CLIO_SCENE_MODELS: z.preprocess(
    blank,
    z.string().trim().pipe(ModelBackendSchema).default('triposr'),
  ),
  // Past a day, Node's timers overflow and would stop every build at once.
  CLIO_SCENE_TIMEOUT_MS: z.preprocess(
    blank,
    z.coerce
      .number()
      .int()
      .positive()
      .max(DAY_MS, { error: 'At most a day (86400000)' })
      .optional(),
  ),
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
  const profiles = e.CLIO_RETARGET_PROFILES ?? [DEFAULT_RETARGET_PROFILE];
  return {
    port: e.CLIO_SERVER_PORT,
    host: e.CLIO_HOST,
    dataDir: dir(e.CLIO_DATA_DIR, 'data'),
    proceduresDir: dir(e.CLIO_PROCEDURES_DIR, 'procedures'),
    geminiApiKey: e.GEMINI_API_KEY ?? null,
    liveModel: e.GEMINI_LIVE_MODEL,
    plannerModel: e.GEMINI_PLANNER_MODEL,
    visionModel: e.GEMINI_VISION_MODEL,
    sceneModel: e.GEMINI_SCENE_MODEL,
    judgeModel: e.GEMINI_JUDGE_MODEL,
    visionUrl: e.CLIO_VISION_URL ?? null,
    visionToken: e.CLIO_VISION_TOKEN ?? null,
    primaryFinderUrl: e.CLIO_PRIMARY_FINDER_URL ?? DEFAULT_PRIMARY_FINDER_URL,
    relayLog: e.CLIO_RELAY_LOG === '1' || e.CLIO_RELAY_LOG === 'true',
    corsOrigins: e.CLIO_CORS_ORIGINS,
    compile: e.CLIO_COMPILE,
    pipelineDir: dir(e.CLIO_PIPELINE_DIR, 'pipeline'),
    retargetProfiles:
      profiles.length === 1 && profiles[0] === 'none'
        ? []
        : profiles.map((profile) => resolveFrom(repoRoot, profile)),
    scene: e.CLIO_SCENE,
    sceneModels: e.CLIO_SCENE_MODELS,
    sceneTimeoutMs: e.CLIO_SCENE_TIMEOUT_MS ?? null,
  };
}

/** For the startup log: what a scene build after each compile will do. */
export function describeSceneBuilds(
  config: Config,
  ready: { triposr: boolean; scene: boolean },
): string {
  if (!ready.scene) {
    return config.scene === 'off' ? 'off (CLIO_SCENE=off)' : 'off, since compiling is off';
  }
  switch (config.sceneModels) {
    case 'primitive':
      return 'on (object models: primitive, offline)';
    case 'triposr':
      return ready.triposr
        ? 'on (object models: TripoSR, on this machine)'
        : 'on (object models: triposr, but TripoSR is not set up, so primitives: run pipeline/tools/triposr/setup.sh)';
    case 'command':
      return 'on (object models: command, which runs CLIO_MODEL_COMMAND)';
  }
}

function resolveFrom(root: string, value: string): string {
  return isAbsolute(value) ? value : resolve(root, value);
}

function isHttpOrigin(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === value;
}

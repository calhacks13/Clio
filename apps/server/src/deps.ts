import { consoleLogger, type Logger } from './log';
import type { EpisodeCompiler } from './services/episode-compiler';
import type { Planner } from './services/planner';
import type { PrimaryObjectFinder } from './services/primary-object';
import type { TokenMinter } from './services/token-minter';
import type { VisionLocator } from './services/vision';
import type { ClipStore } from './storage/clip-store';
import type { DerivedStore } from './storage/derived-store';
import type { EpisodeStore } from './storage/episode-store';
import type { ProcedureStore } from './storage/procedure-store';

// Everything the HTTP app needs, injected so tests can build it on temp dirs with fakes for the
// network-bound services.

export interface BodyLimits {
  /** Small JSON bodies (episode create, finish, clip requests, token requests). */
  jsonBytes: number;
  /** Episode batches: about a second of 2-hand frames is ~300 kB, so this is generous. */
  batchBytes: number;
  /** Bodies with base64 camera images (plans, vision). */
  imageBytes: number;
  /** Media uploads, streamed to disk. */
  mediaBytes: number;
}

const MiB = 1024 * 1024;

export const DEFAULT_LIMITS: BodyLimits = {
  jsonBytes: MiB,
  batchBytes: 25 * MiB,
  imageBytes: 25 * MiB,
  mediaBytes: 2048 * MiB,
};

export interface AppDeps {
  version: string;
  liveModel: string;
  episodes: EpisodeStore;
  /** Compiled episodes (data/derived/): written by the pipeline, only read here. */
  derived: DerivedStore;
  procedures: ProcedureStore;
  clips: ClipStore;
  /** Gemini-backed services: null (or absent) when GEMINI_API_KEY is unset, so routes answer 503. */
  tokenMinter?: TokenMinter | null;
  planner?: Planner | null;
  locator?: VisionLocator | null;
  /** The primary-object demo: Gemini names the main object, the object finder outlines it. */
  primary?: PrimaryObjectFinder | null;
  /** Compiles finished episodes in the background: null (or absent) when compiling is off. */
  compiler?: EpisodeCompiler | null;
  now?: () => Date;
  logger?: Logger;
  limits?: Partial<BodyLimits>;
}

type OptionalServices = 'tokenMinter' | 'planner' | 'locator' | 'primary' | 'compiler';

export interface ServerDeps extends Required<Omit<AppDeps, 'limits' | OptionalServices>> {
  tokenMinter: TokenMinter | null;
  planner: Planner | null;
  locator: VisionLocator | null;
  primary: PrimaryObjectFinder | null;
  compiler: EpisodeCompiler | null;
  limits: BodyLimits;
}

export function resolveDeps(deps: AppDeps): ServerDeps {
  return {
    ...deps,
    tokenMinter: deps.tokenMinter ?? null,
    planner: deps.planner ?? null,
    locator: deps.locator ?? null,
    primary: deps.primary ?? null,
    compiler: deps.compiler ?? null,
    now: deps.now ?? (() => new Date()),
    logger: deps.logger ?? consoleLogger,
    limits: { ...DEFAULT_LIMITS, ...deps.limits },
  };
}

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ModelBackend } from '@clio/protocol';
import { isSafeId } from '../ids';
import type { Logger } from '../log';
import { isFile, isMissing } from '../storage/files';
import type { EpisodeCompiler } from './episode-compiler';
import { EpisodeJobQueue, type EpisodeJobRequest, type EpisodeJobState } from './process-queue';

// Builds the scene of each compiled episode in the background with the pipeline's `clio scene`,
// which reads data/episodes/<id>/ and data/derived/<id>/ and writes data/scenes/<id>/: a model of
// every object, scaled and placed by what was measured (docs/room-scene.md). It follows each
// compile on a queue of its own, since a build runs TripoSR on every object.

/** Port: background scene builds. null when they are off (CLIO_SCENE=off, or compiling is off). */
export interface SceneBuilder {
  /**
   * Asks for a build of one episode and returns at once, with a compile's rules: asking again
   * while it waits does nothing, except that a forced request makes the waiting build forced.
   */
  enqueue(id: string, request?: EpisodeJobRequest): void;
  state(id: string): EpisodeJobState;
  /** Why the last build of this episode failed; null before any run and after a success. */
  lastError(id: string): string | null;
}

export interface ProcessSceneBuilderOptions {
  /** The pipeline CLI, e.g. ['uv', 'run', '--frozen', '--project', '<repo>/pipeline', 'clio']. */
  command: readonly string[];
  /** Absolute: data/episodes. */
  episodesDir: string;
  /** Absolute: data/derived, where the compiles are. */
  derivedDir: string;
  /** Absolute: data/scenes. The builder writes each episode to <scenesDir>/<id>/. */
  scenesDir: string;
  /** How object models are made (`--models`). */
  models: ModelBackend;
  timeoutMs?: number;
  /** How long a timed-out build gets to exit after SIGTERM before it is killed. */
  killGraceMs?: number;
  /**
   * The sweep leaves out the episodes whose compile is waiting or running: that compile asks for
   * their build when it ends (afterCompile), so none is built from a compile about to be replaced.
   */
  compiler?: Pick<EpisodeCompiler, 'state'> | null;
  logger?: Logger;
}

/** TripoSR loads once and takes seconds an object; the first `uv run` also syncs. */
export const DEFAULT_SCENE_TIMEOUT_MS = 10 * 60_000;

/** `clio scene` as a child process, one episode per run, on its own queue (EpisodeJobQueue). */
export class ProcessSceneBuilder extends EpisodeJobQueue implements SceneBuilder {
  constructor(options: ProcessSceneBuilderOptions) {
    const { episodesDir, derivedDir, scenesDir, compiler } = options;
    super({
      label: 'Scene build',
      command: options.command,
      args: (id, force) => [
        'scene',
        join(episodesDir, id),
        '--derived',
        derivedDir,
        '--out',
        scenesDir,
        '--models',
        options.models,
        ...(force ? [] : ['--if-stale']),
      ],
      sweep: {
        list: async () =>
          (await compiledEpisodes(episodesDir, derivedDir)).filter(
            (id) => (compiler?.state(id) ?? 'idle') === 'idle',
          ),
        what: 'compiled episodes',
      },
      // The CLI prints nothing to tell; a build that found its scene up to date kept scene.json.
      upToDate: ({ id, startedAt }) => olderThan(join(scenesDir, id, 'scene.json'), startedAt),
      timeoutMs: options.timeoutMs ?? DEFAULT_SCENE_TIMEOUT_MS,
      killGraceMs: options.killGraceMs,
      logger: options.logger,
    });
  }

  /**
   * The compiler's onCompiled: an `--if-stale` build after each compile that is ok on disk. One
   * the sweep compiled waits in the background, so a lesson finished since is built first.
   */
  afterCompile(id: string, run: { background: boolean }): void {
    this.enqueue(id, { background: run.background });
  }
}

/**
 * The ids of the episodes with a compile (data/derived/<id>/manifest.json) whose raw episode is
 * still there, sorted, so oldest first. None when nothing was compiled yet.
 */
async function compiledEpisodes(episodesDir: string, derivedDir: string): Promise<string[]> {
  let names: string[];
  try {
    const entries = await readdir(derivedDir, { withFileTypes: true });
    names = entries.filter((e) => e.isDirectory() && isSafeId(e.name)).map((e) => e.name);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const compiled = await Promise.all(
    names.map(
      async (id) =>
        (await isFile(join(derivedDir, id, 'manifest.json'))) &&
        isFile(join(episodesDir, id, 'meta.json')),
    ),
  );
  return names.filter((_, i) => compiled[i]).sort();
}

/** Whether the file was last written before `since` (epoch ms); false when it is missing. */
async function olderThan(path: string, since: number): Promise<boolean> {
  try {
    return (await stat(path)).mtimeMs < since;
  } catch {
    return false;
  }
}

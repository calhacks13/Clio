import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SceneDocSchema } from '@clio/protocol';
import { describe, expect, it, onTestFinished } from 'vitest';
import { ProcessEpisodeCompiler } from '../src/services/episode-compiler';
import type { EpisodeJobState } from '../src/services/process-queue';
import {
  DEFAULT_SCENE_TIMEOUT_MS,
  ProcessSceneBuilder,
  type ProcessSceneBuilderOptions,
} from '../src/services/scene-builder';
import { EpisodeStore } from '../src/storage/episode-store';
import { exists } from '../src/storage/files';
import { fakeClio, fakeRuns, openGate, steer } from './compile-fixtures';
import { episodeCreate, finishBody } from './fixtures';
import { captureLogger, tempDir } from './harness';

// The real ProcessSceneBuilder (and ProcessEpisodeCompiler before it), spawning fake-clio-cli.mjs
// instead of `uv run clio`. Each gets its own control dir and log, so a test can hold one back.

interface SetupOptions extends Partial<ProcessSceneBuilderOptions> {
  /** Hold every scene build at its start until the test opens the gate. */
  gated?: boolean;
  /** Hold every compile at its start until the test opens the compile gate. */
  compileGated?: boolean;
}

async function setup(options: SetupOptions = {}) {
  const { gated = false, compileGated = false, ...rest } = options;
  const root = await tempDir();
  // A space in the path: arguments reach the command whole, with no shell to split them.
  const dataDir = join(root, 'data dir');
  const episodesDir = join(dataDir, 'episodes');
  const derivedDir = join(dataDir, 'derived');
  const scenesDir = join(dataDir, 'scenes');
  const control = join(root, 'scene-control');
  const compileControl = join(root, 'compile-control');
  await mkdir(control);
  await mkdir(compileControl);
  if (!gated) await openGate(control);
  if (!compileGated) await openGate(compileControl);
  const logPath = join(root, 'scene-runs.ndjson');
  const compileLog = join(root, 'compile-runs.ndjson');
  const logger = captureLogger();
  const store = new EpisodeStore(episodesDir);
  let builder: ProcessSceneBuilder | null = null;
  // Wired as the server wires them: each compile that ends ok asks for a build.
  const compiler = new ProcessEpisodeCompiler({
    command: fakeClio('--log', compileLog, '--control', compileControl),
    episodesDir,
    derivedDir,
    onCompiled: (id, run) => builder?.afterCompile(id, run),
    logger,
  });
  builder = new ProcessSceneBuilder({
    command: fakeClio('--log', logPath, '--control', control),
    episodesDir,
    derivedDir,
    scenesDir,
    models: 'primitive',
    compiler,
    logger,
    ...rest,
  });
  const built = builder;
  onTestFinished(() => {
    compiler.close();
    built.close();
  });
  const t = {
    episodesDir,
    derivedDir,
    scenesDir,
    control,
    compileControl,
    logger,
    store,
    compiler,
    builder: built,
    runs: async () => fakeRuns(logPath),
    compiles: async () => fakeRuns(compileLog),
    /** `scan`: recorded with ?scan=1, so it has a keyframe in media/ (the default). */
    finished: async ({ scan = true } = {}) => {
      const { episodeId } = await store.create(episodeCreate());
      if (scan) await keyframe(episodesDir, episodeId);
      await store.finish(episodeId, finishBody());
      return episodeId;
    },
    /** A finished episode with a compile on disk, as one compiled before the server started. */
    compiled: async ({ scan = true } = {}) => {
      const id = await t.finished({ scan });
      const byHand = new ProcessEpisodeCompiler({ command: fakeClio(), episodesDir, derivedDir });
      byHand.enqueue(id);
      await byHand.idle();
      return id;
    },
    scene: async (id: string) =>
      SceneDocSchema.parse(JSON.parse(await readFile(join(scenesDir, id, 'scene.json'), 'utf8'))),
    /** Both queues are done, including builds a compile asked for at its end. */
    settled: async () => {
      await compiler.idle();
      await built.idle();
    },
  };
  return t;
}

type Setup = Awaited<ReturnType<typeof setup>>;

/** A keyframe in the episode's media/, as the headset uploads it with ?scan=1. */
async function keyframe(episodesDir: string, id: string): Promise<void> {
  await mkdir(join(episodesDir, id, 'media'), { recursive: true });
  await writeFile(join(episodesDir, id, 'media', 'keyframe-0001.jpg'), 'jpeg');
}

/** Each scene build's episode, and `force` when it ran without `--if-stale`. */
const kindsOf = async (t: Setup) =>
  (await t.runs())
    .filter((r) => r.event === 'start')
    .map((r) => (r.ifStale ? r.key : `${r.key} force`));

describe('ProcessSceneBuilder', () => {
  it('builds a scene with exactly the pipeline command line', async () => {
    const t = await setup({ models: 'command' });
    const id = await t.compiled();
    t.builder.enqueue(id);
    expect(t.builder.state(id)).toBe('running');
    await t.builder.idle();

    expect(t.builder.state(id)).toBe('idle');
    expect(t.builder.lastError(id)).toBeNull();
    const runs = await t.runs();
    expect(runs.map((r) => `${r.event} ${r.command}`)).toEqual(['start scene', 'end scene']);
    expect(runs[0]?.argv.slice(runs[0].argv.indexOf('scene'))).toEqual([
      'scene',
      join(t.episodesDir, id),
      '--derived',
      t.derivedDir,
      '--out',
      t.scenesDir,
      '--models',
      'command',
      '--if-stale',
    ]);
    const manifest = JSON.parse(await readFile(join(t.derivedDir, id, 'manifest.json'), 'utf8'));
    expect(await t.scene(id)).toMatchObject({
      episodeId: id,
      compiledAt: manifest.compiledAt,
      options: { models: 'command' },
    });
    expect(t.logger.lines.some((l) => l.startsWith(`info Scene build of ${id} finished in`))).toBe(
      true,
    );
  });

  it('builds an up-to-date scene again only when forced, and logs only builds that wrote', async () => {
    const t = await setup();
    const id = await t.compiled();
    t.builder.enqueue(id);
    await t.builder.idle();
    const first = await t.scene(id);
    t.logger.lines.length = 0;

    t.builder.enqueue(id);
    await t.builder.idle();
    expect(await t.scene(id)).toEqual(first);
    // The CLI kept scene.json: an up-to-date check is not worth a line.
    expect(t.logger.lines).toEqual([]);

    t.builder.enqueue(id, { force: true });
    await t.builder.idle();
    expect((await t.scene(id)).builtAt).not.toBe(first.builtAt);
    expect(await kindsOf(t)).toEqual([id, id, `${id} force`]);
    expect(t.logger.lines).toEqual([
      expect.stringMatching(new RegExp(`^info Scene build of ${id} finished in`)),
    ]);
  });

  it('keeps the end of stderr as the error, and clears it after a success', async () => {
    const t = await setup();
    const id = await t.compiled();
    const traceback =
      'Traceback (most recent call last):\n  File "scene.py", line 40, in build\n' +
      'RuntimeError: command: CLIO_MODEL_COMMAND is not set\n';
    await steer(t.control, id, 'fail', traceback);
    t.builder.enqueue(id);
    await t.builder.idle();
    expect(t.builder.lastError(id)).toBe(traceback.trim());
    expect(t.logger.lines).toContainEqual(
      expect.stringMatching(
        new RegExp(`^warn Scene build of ${id} failed after .*: RuntimeError: command: `),
      ),
    );

    await rm(join(t.control, `${id}.fail`));
    t.builder.enqueue(id);
    await t.builder.idle();
    expect(t.builder.lastError(id)).toBeNull();
  });

  it('fails the build of an episode without a compile, with the CLI saying why', async () => {
    const t = await setup();
    const id = await t.finished();
    t.builder.enqueue(id);
    await t.builder.idle();
    expect(t.builder.lastError(id)).toMatch(/no compile/);
    expect(await exists(join(t.scenesDir, id))).toBe(false);
  });

  it('stops a build that runs past the timeout, ten minutes unless set', async () => {
    expect(DEFAULT_SCENE_TIMEOUT_MS).toBe(10 * 60_000);
    const t = await setup({ timeoutMs: 300 });
    const [hung, next] = [await t.compiled(), await t.compiled()];
    await steer(t.control, hung, 'hang');
    t.builder.enqueue(hung);
    t.builder.enqueue(next);
    await t.builder.idle();

    expect(t.builder.lastError(hung)).toBe('Timed out after 0.3 s');
    expect(t.builder.lastError(next)).toBeNull();
    const run = (await t.runs()).find((r) => r.key === hung);
    expect(() => process.kill(run?.pid ?? 0, 0)).toThrow();
  });

  it('sweeps every compiled episode with a raw episode, oldest first', async () => {
    const t = await setup({ compiler: null });
    const [a = '', b = ''] = [await t.compiled(), await t.compiled()].sort();
    const notCompiled = await t.finished();
    // A compile whose raw episode was deleted, and one that never finished writing its manifest.
    await mkdir(join(t.derivedDir, 'ep-20200101-000000-gone'), { recursive: true });
    await writeFile(join(t.derivedDir, 'ep-20200101-000000-gone', 'manifest.json'), '{}');
    await mkdir(join(t.derivedDir, notCompiled), { recursive: true });
    await t.builder.sweep();
    await t.builder.idle();

    expect(await kindsOf(t)).toEqual([a, b]);
    expect(t.logger.lines[0]).toBe(
      'info Scene build sweep: checking 2 compiled episodes with a room scan or keyframes',
    );
  });

  it('leaves out of the sweep an episode recorded without a room scan or keyframes', async () => {
    const t = await setup({ compiler: null });
    const scanned = await t.compiled();
    await t.compiled({ scan: false });
    await t.builder.sweep();
    await t.builder.idle();
    expect(await kindsOf(t)).toEqual([scanned]);
  });

  it('leaves out of the sweep an episode whose compile is pending, and builds it after', async () => {
    const t = await setup({ compileGated: true });
    const [ready, recompiling] = [await t.compiled(), await t.compiled()];
    t.compiler.enqueue(recompiling, { force: true });
    await t.builder.sweep();
    expect(t.builder.state(ready)).toBe('running');
    expect(t.builder.state(recompiling)).toBe('idle');

    await openGate(t.compileControl);
    await t.settled();
    expect(await kindsOf(t)).toEqual([ready, recompiling]);
    // Built from the new compile, not the one it replaced.
    const manifest = JSON.parse(
      await readFile(join(t.derivedDir, recompiling, 'manifest.json'), 'utf8'),
    );
    expect((await t.scene(recompiling)).compiledAt).toBe(manifest.compiledAt);
  });

  it('skips the sweep while nothing is compiled, and logs one that cannot list', async () => {
    const t = await setup();
    await t.builder.sweep();
    await t.builder.idle();
    expect(await t.runs()).toEqual([]);
    expect(t.logger.lines).toEqual([]);

    await mkdir(join(t.derivedDir, '..'), { recursive: true });
    await writeFile(t.derivedDir, 'a file, not a dir');
    await expect(t.builder.sweep()).resolves.toBeUndefined();
    expect(t.logger.lines).toEqual([
      expect.stringMatching(/^warn Scene build sweep could not list the episodes: .*ENOTDIR/),
    ]);
  });
});

describe('scene builds after compiles', () => {
  it('builds the scene after each compile that ends ok, up to date or not', async () => {
    const t = await setup();
    const id = await t.finished();
    t.compiler.enqueue(id);
    await t.settled();
    const first = await t.scene(id);

    // A repeated finish: the compile is up to date, and so is the scene.
    t.compiler.enqueue(id);
    await t.settled();
    expect(await t.scene(id)).toEqual(first);

    // A forced compile: a new compile, so the --if-stale build makes a new scene.
    t.compiler.enqueue(id, { force: true });
    await t.settled();
    expect((await t.scene(id)).compiledAt).not.toBe(first.compiledAt);
    expect(await kindsOf(t)).toEqual([id, id, id]);
    expect((await t.runs()).every((r) => r.command === 'scene')).toBe(true);
  });

  it('builds nothing after the compile of an episode without a room scan or keyframes', async () => {
    const t = await setup();
    const id = await t.finished({ scan: false });
    t.compiler.enqueue(id);
    await t.settled();
    expect(await t.compiles()).not.toEqual([]);
    expect(await t.runs()).toEqual([]);
    expect(t.builder.state(id)).toBe('idle');

    // Asked for by hand, it is built all the same.
    t.builder.enqueue(id, { force: true });
    await t.settled();
    expect(await kindsOf(t)).toEqual([`${id} force`]);
  });

  it('builds nothing after a compile that fails', async () => {
    const t = await setup();
    const id = await t.finished();
    await steer(t.compileControl, id, 'fail', 'clio: cannot compile\n');
    t.compiler.enqueue(id);
    await t.settled();
    expect(t.compiler.lastError(id)).toBe('clio: cannot compile');
    expect(await t.runs()).toEqual([]);
    expect(t.builder.state(id)).toBe('idle');
  });

  it("puts the builds of the compile sweep's episodes behind requested ones", async () => {
    const t = await setup({ gated: true });
    const [a = '', b = ''] = [await t.finished(), await t.finished()].sort();
    await t.compiler.sweep();
    await t.compiler.idle();
    // a's build started first and holds the queue; b's waits in the background.
    expect([a, b].map((id) => t.builder.state(id))).toEqual<EpisodeJobState[]>([
      'running',
      'queued',
    ]);
    // A lesson finished after the restart is built before the rest of the library.
    const fresh = await t.finished();
    t.compiler.enqueue(fresh);
    await t.compiler.idle();

    await openGate(t.control);
    await t.settled();
    expect(await kindsOf(t)).toEqual([a, fresh, b]);
  });

  it('builds once more when a swept compile changes an episode whose build is running', async () => {
    const t = await setup({ gated: true });
    const id = await t.compiled();
    t.builder.enqueue(id, { force: true });
    await expect.poll(async () => (await t.runs()).length).toBe(1);
    // Recorded on while the server was down: the startup sweep recompiles it.
    await appendFile(join(t.episodesDir, id, 'objects.ndjson'), '{"t":9,"objects":[]}\n');
    await t.compiler.sweep();
    await t.compiler.idle();
    expect(t.builder.state(id)).toBe('running');

    await openGate(t.control);
    await t.settled();
    expect(await kindsOf(t)).toEqual([`${id} force`, id]);
    const manifest = JSON.parse(await readFile(join(t.derivedDir, id, 'manifest.json'), 'utf8'));
    expect((await t.scene(id)).compiledAt).toBe(manifest.compiledAt);
  });

  it('drops the queue and stops the running build when closed', async () => {
    const t = await setup();
    const [hung, waiting] = [await t.compiled(), await t.compiled()];
    await steer(t.control, hung, 'hang');
    t.builder.enqueue(hung);
    t.builder.enqueue(waiting);
    await expect.poll(async () => (await t.runs()).map((r) => r.key)).toEqual([hung]);

    t.builder.close();
    await t.builder.idle();
    t.builder.enqueue(waiting);
    expect([hung, waiting].map((id) => t.builder.state(id))).toEqual(['idle', 'idle']);
    const run = (await t.runs()).find((r) => r.key === hung);
    expect(() => process.kill(run?.pid ?? 0, 0)).toThrow();
  });
});

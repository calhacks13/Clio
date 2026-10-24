import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CompileManifestSchema } from '@clio/protocol';
import { describe, expect, it, onTestFinished } from 'vitest';
import {
  type ProcessCompilerOptions,
  ProcessEpisodeCompiler,
} from '../src/services/episode-compiler';
import { EpisodeStore } from '../src/storage/episode-store';
import { exists } from '../src/storage/files';
import { fakeClio, fakeRuns, openGate, steer } from './compile-fixtures';
import { episodeCreate, finishBody } from './fixtures';
import { captureLogger, tempDir } from './harness';

// The real ProcessEpisodeCompiler, spawning fake-clio-cli.mjs instead of `uv run clio`.

interface SetupOptions extends Partial<ProcessCompilerOptions> {
  /** Extra options for the fake. */
  fake?: string[];
  /** Hold every run at the start until the test opens the gate. */
  gated?: boolean;
}

async function setup(options: SetupOptions = {}) {
  const { fake = [], gated = false, ...rest } = options;
  const root = await tempDir();
  // A space in the path: arguments reach the command whole, with no shell to split them.
  const dataDir = join(root, 'data dir');
  const episodesDir = join(dataDir, 'episodes');
  const derivedDir = join(dataDir, 'derived');
  const control = join(root, 'control');
  await mkdir(control);
  if (!gated) await openGate(control);
  const logPath = join(root, 'runs.ndjson');
  const logger = captureLogger();
  const store = new EpisodeStore(episodesDir);
  const compiler = new ProcessEpisodeCompiler({
    command: fakeClio('--log', logPath, '--control', control, ...fake),
    episodesDir,
    derivedDir,
    logger,
    ...rest,
  });
  onTestFinished(() => compiler.close());
  return {
    episodesDir,
    derivedDir,
    control,
    logPath,
    logger,
    store,
    compiler,
    runs: () => fakeRuns(logPath),
    create: async () => (await store.create(episodeCreate())).episodeId,
    /** A finished episode, as one that finished while the server was down. */
    finished: async () => {
      const { episodeId } = await store.create(episodeCreate());
      await store.finish(episodeId, finishBody());
      return episodeId;
    },
    manifest: async (id: string) =>
      CompileManifestSchema.parse(
        JSON.parse(await readFile(join(derivedDir, id, 'manifest.json'), 'utf8')),
      ),
  };
}

const startsOf = async (t: Awaited<ReturnType<typeof setup>>) =>
  (await t.runs()).filter((r) => r.event === 'start').map((r) => r.key);

/** Each run's episode, and `force` when it ran without `--if-stale`. */
const kindsOf = async (t: Awaited<ReturnType<typeof setup>>) =>
  (await t.runs())
    .filter((r) => r.event === 'start')
    .map((r) => (r.ifStale ? r.key : `${r.key} force`));

describe('ProcessEpisodeCompiler', () => {
  it('compiles an episode with the configured command, settings and profiles', async () => {
    const t = await setup({ fps: 15, retargetProfiles: ['/robots/arm a.json', '/robots/b.json'] });
    const id = await t.create();
    t.compiler.enqueue(id);
    expect(t.compiler.state(id)).toBe('running');
    await t.compiler.idle();

    expect(t.compiler.state(id)).toBe('idle');
    expect(t.compiler.lastError(id)).toBeNull();
    const runs = await t.runs();
    expect(runs.map((r) => r.event)).toEqual(['start', 'end']);
    expect(runs[0]?.argv.slice(runs[0].argv.indexOf('compile'))).toEqual([
      'compile',
      join(t.episodesDir, id),
      '--out',
      t.derivedDir,
      '--fps',
      '15',
      '--retarget',
      '/robots/arm a.json',
      '--retarget',
      '/robots/b.json',
      '--if-stale',
      '--json',
    ]);
    expect(await t.manifest(id)).toMatchObject({ episodeId: id, fps: 15 });
    expect(t.logger.lines.some((l) => l.startsWith(`info Compile of ${id} finished in`))).toBe(
      true,
    );
  });

  it('runs one compile at a time, in the order asked for', async () => {
    const t = await setup({ gated: true });
    const [a, b, c] = [await t.create(), await t.create(), await t.create()];
    t.compiler.enqueue(a);
    t.compiler.enqueue(b);
    t.compiler.enqueue(c);
    expect([a, b, c].map((id) => t.compiler.state(id))).toEqual(['running', 'queued', 'queued']);

    await openGate(t.control);
    await t.compiler.idle();
    const runs = await t.runs();
    expect(runs.map((r) => `${r.event} ${r.key}`)).toEqual([
      `start ${a}`,
      `end ${a}`,
      `start ${b}`,
      `end ${b}`,
      `start ${c}`,
      `end ${c}`,
    ]);
  });

  it('ignores a request for an episode that is already waiting', async () => {
    const t = await setup({ gated: true });
    const [a, b] = [await t.create(), await t.create()];
    t.compiler.enqueue(a);
    t.compiler.enqueue(b);
    t.compiler.enqueue(b);
    t.compiler.enqueue(b);
    expect(t.compiler.state(b)).toBe('queued');

    await openGate(t.control);
    await t.compiler.idle();
    expect(await startsOf(t)).toEqual([a, b]);
  });

  it('compiles a running episode once more after it finishes, however often it is asked again', async () => {
    const t = await setup({ gated: true });
    const a = await t.create();
    t.compiler.enqueue(a);
    await expect.poll(() => startsOf(t)).toEqual([a]);
    t.compiler.enqueue(a);
    t.compiler.enqueue(a);
    expect(t.compiler.state(a)).toBe('running');

    await openGate(t.control);
    await t.compiler.idle();
    expect(await startsOf(t)).toEqual([a, a]);
  });

  it('compiles an up-to-date episode again only when forced', async () => {
    const t = await setup();
    const id = await t.create();
    t.compiler.enqueue(id);
    await t.compiler.idle();
    const first = await t.manifest(id);
    t.logger.lines.length = 0;

    t.compiler.enqueue(id);
    await t.compiler.idle();
    expect(await t.manifest(id)).toEqual(first);
    // An up-to-date check is not worth a line.
    expect(t.logger.lines).toEqual([]);

    t.compiler.enqueue(id, { force: true });
    await t.compiler.idle();
    expect((await t.manifest(id)).compiledAt).not.toBe(first.compiledAt);
    expect(await kindsOf(t)).toEqual([id, id, `${id} force`]);
    const forced = (await t.runs()).at(-1)?.argv ?? [];
    expect(forced).not.toContain('--if-stale');
    expect(t.logger.lines.some((l) => l.startsWith(`info Compile of ${id} finished in`))).toBe(
      true,
    );
  });

  it('makes a waiting compile forced when a forced request joins it, and keeps it forced', async () => {
    const t = await setup({ gated: true });
    const [a, b, c] = [await t.create(), await t.create(), await t.create()];
    t.compiler.enqueue(a);
    t.compiler.enqueue(b);
    t.compiler.enqueue(b, { force: true });
    t.compiler.enqueue(c, { force: true });
    t.compiler.enqueue(c);
    // The rule for the running one stays: one rerun, forced if any request for it was.
    t.compiler.enqueue(a, { force: true });
    expect([a, b, c].map((id) => t.compiler.state(id))).toEqual(['running', 'queued', 'queued']);

    await openGate(t.control);
    await t.compiler.idle();
    expect(await kindsOf(t)).toEqual([a, `${b} force`, `${c} force`, `${a} force`]);
  });

  it('keeps the end of stderr as the error, and clears it after a success', async () => {
    const t = await setup();
    const id = await t.create();
    const traceback =
      'Traceback (most recent call last):\n  File "cli.py", line 9, in main\n' +
      'ValueError: frames.ndjson line 3 is not JSON\n';
    await steer(t.control, id, 'fail', traceback);
    t.compiler.enqueue(id);
    await t.compiler.idle();
    expect(t.compiler.lastError(id)).toBe(traceback.trim());
    expect(
      t.logger.lines.some(
        (l) =>
          l.startsWith(`warn Compile of ${id} failed after`) &&
          l.endsWith(': ValueError: frames.ndjson line 3 is not JSON'),
      ),
    ).toBe(true);

    await rm(join(t.control, `${id}.fail`));
    t.compiler.enqueue(id);
    await t.compiler.idle();
    expect(t.compiler.lastError(id)).toBeNull();
  });

  it('keeps only the last 4 KiB of a long error, starting at a whole line', async () => {
    const t = await setup();
    const id = await t.create();
    const lines = Array.from({ length: 1000 }, (_, i) => `line ${String(i).padStart(4, '0')}`);
    await steer(t.control, id, 'fail', `${lines.join('\n')}\n`);
    t.compiler.enqueue(id);
    await t.compiler.idle();

    const error = t.compiler.lastError(id) ?? '';
    expect(error.length).toBeLessThanOrEqual(4096);
    expect(error.length).toBeGreaterThan(4000);
    expect(error.split('\n').every((line) => /^line \d{4}$/.test(line))).toBe(true);
    expect(error.endsWith('line 0999')).toBe(true);
  });

  it('stops a compile that runs past the timeout and moves on to the next', async () => {
    const t = await setup({ timeoutMs: 300 });
    const [a, b] = [await t.create(), await t.create()];
    await steer(t.control, a, 'hang');
    t.compiler.enqueue(a);
    t.compiler.enqueue(b);
    await t.compiler.idle();

    expect(t.compiler.lastError(a)).toBe('Timed out after 0.3 s');
    expect(t.compiler.lastError(b)).toBeNull();
    expect(await t.manifest(b)).toMatchObject({ episodeId: b });
    const hung = (await t.runs()).find((r) => r.key === a);
    expect(() => process.kill(hung?.pid ?? 0, 0)).toThrow();
  });

  it('kills a timed-out compile that ignores SIGTERM once the grace period is over', async () => {
    const t = await setup({ timeoutMs: 200, killGraceMs: 200, fake: ['--ignore-term'] });
    const id = await t.create();
    await steer(t.control, id, 'hang');
    t.compiler.enqueue(id);
    await t.compiler.idle();

    expect(t.compiler.lastError(id)).toBe('Timed out after 0.2 s');
    const hung = (await t.runs()).find((r) => r.key === id);
    expect(() => process.kill(hung?.pid ?? 0, 0)).toThrow();
  });

  it('reports a command that cannot start, and keeps serving the queue', async () => {
    const root = await tempDir();
    const compiler = new ProcessEpisodeCompiler({
      command: [join(root, 'no-such-clio'), 'clio'],
      episodesDir: join(root, 'episodes'),
      derivedDir: join(root, 'derived'),
    });
    compiler.enqueue('ep-a');
    compiler.enqueue('ep-b');
    await compiler.idle();
    for (const id of ['ep-a', 'ep-b']) {
      expect(compiler.lastError(id)).toMatch(/^Could not start .*no-such-clio: .*ENOENT/);
    }
  });

  it('sweeps each finished episode as its own --if-stale run with the same settings', async () => {
    const t = await setup({ retargetProfiles: ['/robots/a.json'] });
    const [finished, recording] = [await t.finished(), await t.create()];
    // Not episodes: a hidden dir (a compile's or a copy's leftovers) and a stray file.
    const hidden = join(t.episodesDir, `.${finished}.copy`);
    await mkdir(hidden);
    for (const name of ['meta.json', 'finish.json']) await writeFile(join(hidden, name), '{}');
    await writeFile(join(t.episodesDir, 'notes.txt'), 'not an episode');
    await t.compiler.sweep();
    await t.compiler.idle();

    const runs = await t.runs();
    expect(runs.map((r) => `${r.event} ${r.key}`)).toEqual([
      `start ${finished}`,
      `end ${finished}`,
    ]);
    expect(runs[0]?.argv.slice(runs[0].argv.indexOf('compile'))).toEqual([
      'compile',
      join(t.episodesDir, finished),
      '--out',
      t.derivedDir,
      '--fps',
      '30',
      '--retarget',
      '/robots/a.json',
      '--if-stale',
      '--json',
    ]);
    expect(await t.manifest(finished)).toMatchObject({ episodeId: finished });
    expect(await exists(join(t.derivedDir, recording))).toBe(false);
    expect(t.logger.lines[0]).toBe('info Compile sweep: checking 1 finished episodes');
  });

  it('keeps the error of each swept episode that fails, and compiles the rest', async () => {
    const t = await setup();
    const [bad, good] = [await t.finished(), await t.finished()];
    await steer(t.control, bad, 'fail', 'clio: cannot compile: frames.ndjson:1: invalid JSON\n');
    await t.compiler.sweep();
    await t.compiler.idle();

    expect(t.compiler.lastError(bad)).toBe('clio: cannot compile: frames.ndjson:1: invalid JSON');
    expect(t.compiler.lastError(good)).toBeNull();
    expect(await exists(join(t.derivedDir, bad))).toBe(false);
    expect(await t.manifest(good)).toMatchObject({ episodeId: good });
    expect(t.logger.lines.filter((l) => l.startsWith('warn'))).toEqual([
      expect.stringMatching(new RegExp(`^warn Compile of ${bad} failed after .*invalid JSON$`)),
    ]);
  });

  it('gives each swept episode its own timeout', async () => {
    const t = await setup({ timeoutMs: 300 });
    const [hung, next] = [await t.finished(), await t.finished()];
    await steer(t.control, hung, 'hang');
    await t.compiler.sweep();
    await t.compiler.idle();

    expect(t.compiler.lastError(hung)).toBe('Timed out after 0.3 s');
    expect(t.compiler.lastError(next)).toBeNull();
    expect(await t.manifest(next)).toMatchObject({ episodeId: next });
  });

  it('runs requested compiles ahead of the sweep', async () => {
    const t = await setup({ gated: true });
    // Sorted: the sweep goes by id, and ids made in the same second end in random letters.
    const [a = '', b = '', c = ''] = [
      await t.finished(),
      await t.finished(),
      await t.finished(),
    ].sort();
    await t.compiler.sweep();
    expect([a, b, c].map((id) => t.compiler.state(id))).toEqual(['running', 'queued', 'queued']);
    // A lesson finished just after a restart does not wait for the whole library.
    const fresh = await t.finished();
    t.compiler.enqueue(fresh);
    // Asking for one the sweep queued moves it up too, forced if asked so.
    t.compiler.enqueue(c, { force: true });

    await openGate(t.control);
    await t.compiler.idle();
    expect(await kindsOf(t)).toEqual([a, fresh, `${c} force`, b]);
  });

  it('skips the sweep while there are no episodes yet', async () => {
    const t = await setup();
    await t.compiler.sweep();
    await mkdir(t.episodesDir, { recursive: true });
    await t.compiler.sweep();
    await t.compiler.idle();
    expect(await t.runs()).toEqual([]);
    expect(t.logger.lines).toEqual([]);
  });

  it('logs a sweep that cannot list the episodes, and does not reject', async () => {
    const t = await setup();
    await mkdir(join(t.episodesDir, '..'), { recursive: true });
    await writeFile(t.episodesDir, 'a file, not a dir');
    await expect(t.compiler.sweep()).resolves.toBeUndefined();
    expect(t.logger.lines).toEqual([
      expect.stringMatching(/^warn Compile sweep could not list the episodes: .*ENOTDIR/),
    ]);
  });

  it('lists once for sweeps asked for at once, and never queues an episode twice', async () => {
    const t = await setup({ gated: true });
    const [a = '', b = ''] = [await t.finished(), await t.finished()].sort();
    const first = t.compiler.sweep();
    expect(t.compiler.sweep()).toBe(first);
    await first;
    // a is running and b is waiting: a later sweep adds neither again.
    await t.compiler.sweep();
    expect([a, b].map((id) => t.compiler.state(id))).toEqual(['running', 'queued']);

    await openGate(t.control);
    await t.compiler.idle();
    expect(await startsOf(t)).toEqual([a, b]);
  });

  it('stops the running compile and drops the queue when closed', async () => {
    const t = await setup();
    const [a, b, c] = [await t.finished(), await t.finished(), await t.create()];
    await steer(t.control, a, 'hang');
    t.compiler.enqueue(a);
    t.compiler.enqueue(c);
    await t.compiler.sweep();
    expect(t.compiler.state(b)).toBe('queued');
    await expect.poll(() => startsOf(t)).toEqual([a]);

    t.compiler.close();
    await t.compiler.idle();
    t.compiler.enqueue(b);
    await t.compiler.sweep();
    expect([a, b, c].map((id) => t.compiler.state(id))).toEqual(['idle', 'idle', 'idle']);
    expect(await startsOf(t)).toEqual([a]);
    const hung = (await t.runs()).find((r) => r.key === a);
    expect(() => process.kill(hung?.pid ?? 0, 0)).toThrow();
  });

  it('refuses an unsafe episode id before it reaches a path', async () => {
    const t = await setup();
    expect(() => t.compiler.enqueue('../meta')).toThrow(/Unsafe episode id/);
    expect(await t.runs()).toEqual([]);
  });
});

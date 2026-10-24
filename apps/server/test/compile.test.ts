import { appendFile, mkdir, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import {
  ApiErrorSchema,
  ApiPaths,
  type CompileManifest,
  EpisodeCompileResponseSchema,
  EpisodeDetailResponseSchema,
} from '@clio/protocol';
import { describe, expect, it, onTestFinished } from 'vitest';
import {
  type ProcessCompilerOptions,
  ProcessEpisodeCompiler,
} from '../src/services/episode-compiler';
import { COMPILE_INPUTS, isStale } from '../src/storage/derived-store';
import { fakeClio, fakeRuns, openGate, steer } from './compile-fixtures';
import { entered, episodeCreate, finishBody, frame, objectTrack, observation } from './fixtures';
import { type Harness, harness, tempDir } from './harness';

// Compiling after finish, the compile route, the compiled-file route and the compile state in the
// episode detail. The app runs the real ProcessEpisodeCompiler on the harness's dirs, spawning
// fake-clio-cli.mjs in place of `uv run clio`.

interface Compiling {
  h: Harness;
  compiler: ProcessEpisodeCompiler;
  control: string;
  starts(): Promise<string[]>;
  /** Each run's episode, and `force` when it ran without `--if-stale`. */
  kinds(): Promise<string[]>;
}

async function compiling(
  options: Partial<ProcessCompilerOptions> & { gated?: boolean } = {},
): Promise<Compiling> {
  const { gated = false, ...rest } = options;
  const control = await tempDir();
  if (!gated) await openGate(control);
  const logPath = join(control, 'runs.ndjson');
  let compiler: ProcessEpisodeCompiler | undefined;
  const h = await harness({
    compiler: (dirs) => {
      compiler = new ProcessEpisodeCompiler({
        command: fakeClio('--log', logPath, '--control', control),
        ...dirs,
        ...rest,
      });
      return compiler;
    },
  });
  if (!compiler) throw new Error('The harness did not build the compiler');
  const built = compiler;
  onTestFinished(() => built.close());
  const startRuns = async () => (await fakeRuns(logPath)).filter((r) => r.event === 'start');
  const starts = async () => (await startRuns()).map((r) => r.key);
  const kinds = async () => (await startRuns()).map((r) => (r.ifStale ? r.key : `${r.key} force`));
  return { h, compiler: built, control, starts, kinds };
}

async function create(h: Harness): Promise<string> {
  const res = await h.request('POST', ApiPaths.episodes, episodeCreate());
  expect(res.status).toBe(201);
  return ((await res.json()) as { episodeId: string }).episodeId;
}

async function record(h: Harness, id: string): Promise<void> {
  const res = await h.request('POST', ApiPaths.episodeBatches(id), {
    seq: 0,
    frames: [frame(0), frame(11)],
    events: [entered(0, 'lay-flat')],
    objects: [objectTrack(5)],
    observations: [observation(5)],
  });
  expect(res.status).toBe(200);
}

async function finish(h: Harness, id: string): Promise<Response> {
  const res = await h.request('POST', ApiPaths.episodeFinish(id), finishBody());
  expect(res.status).toBe(200);
  return res;
}

async function derivedOf(h: Harness, id: string) {
  const res = await h.request('GET', ApiPaths.episode(id));
  expect(res.status).toBe(200);
  const derived = EpisodeDetailResponseSchema.parse(await res.json()).derived;
  if (!derived) throw new Error('The detail has no derived status');
  return derived;
}

async function errorOf(res: Response) {
  return ApiErrorSchema.parse(await res.json()).error;
}

/** Every file under an episode dir, by relative path, as raw bytes. */
async function snapshot(dir: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    files.set(relative(dir, path), await readFile(path));
  }
  return files;
}

function manifestWith(inputs: [string, number][]): CompileManifest {
  return {
    schema: 'clio.derived/1',
    episodeId: 'ep-a',
    compiledAt: '2026-10-24T03:20:00.000Z',
    compiler: { name: 'clio-pipeline', version: '0.2.0' },
    fps: 30,
    inputs: inputs.map(([name, bytes]) => ({ name, bytes, sha256: 'a'.repeat(64) })),
    retarget: [],
    stages: [],
    artifacts: [],
    quality: {
      usable: false,
      reasons: ['not finished'],
      finished: false,
      outcome: null,
      batches: null,
      durationMs: 0,
      frames: 0,
      frameRateHz: null,
      maxFrameGapMs: null,
      hands: { left: 0, right: 0 },
      objects: [],
      validationIssues: 0,
    },
  };
}

describe('compiling after finish', () => {
  it('acks the finish at once and compiles in the background', async () => {
    const { h, compiler, control } = await compiling({ gated: true });
    const id = await create(h);
    await record(h, id);

    // The compile is held at its start, yet the finish has already been answered.
    expect(await (await finish(h, id)).json()).toEqual({ ok: true });
    expect(compiler.state(id)).toBe('running');
    expect(await derivedOf(h, id)).toEqual({ state: 'running', manifest: null, error: null });

    await openGate(control);
    await compiler.idle();
    const derived = await derivedOf(h, id);
    expect(derived).toMatchObject({ state: 'ok', error: null });
    expect(derived.manifest).toMatchObject({ episodeId: id, fps: 30 });
    expect(derived.manifest?.inputs.map((i) => i.name)).toEqual([...COMPILE_INPUTS]);
  });

  it('compiles once for a finish repeated while the compile waits', async () => {
    const { h, compiler, control, starts } = await compiling({ gated: true });
    const [busy, id] = [await create(h), await create(h)];
    await finish(h, busy);
    await finish(h, id);
    await finish(h, id);
    expect(compiler.state(busy)).toBe('running');
    expect(compiler.state(id)).toBe('queued');
    expect((await derivedOf(h, id)).state).toBe('queued');

    await openGate(control);
    await compiler.idle();
    expect(await starts()).toEqual([busy, id]);
  });

  it('does not compile for media, before or after the finish (media is not a compile input)', async () => {
    const { h, compiler, starts } = await compiling();
    const id = await create(h);
    const upload = (name: string) =>
      h.request('PUT', ApiPaths.episodeMedia(id, name), new Uint8Array([1, 2, 3]));

    expect((await upload('early.webm')).status).toBe(200);
    expect(compiler.state(id)).toBe('idle');
    await finish(h, id);
    await compiler.idle();
    expect((await upload('egocentric.webm')).status).toBe(200);
    expect(compiler.state(id)).toBe('idle');
    await compiler.idle();
    expect(await starts()).toEqual([id]);
    expect((await derivedOf(h, id)).state).toBe('ok');
  });

  it('checks for an up-to-date compile on finish, so a repeated finish recompiles only a change', async () => {
    const { h, compiler, kinds } = await compiling();
    const id = await create(h);
    await finish(h, id);
    await compiler.idle();
    const first = (await derivedOf(h, id)).manifest;
    await finish(h, id);
    await compiler.idle();
    expect(await kinds()).toEqual([id, id]);
    expect((await derivedOf(h, id)).manifest).toEqual(first);
  });

  it('reports a failed compile with the end of its stderr', async () => {
    const { h, compiler, control } = await compiling();
    const id = await create(h);
    await steer(control, id, 'fail', 'Traceback (most recent call last):\nKeyError: head\n');
    await finish(h, id);
    await compiler.idle();
    expect(await derivedOf(h, id)).toEqual({
      state: 'failed',
      manifest: null,
      error: 'Traceback (most recent call last):\nKeyError: head',
    });
  });
});

describe('POST /api/episodes/:id/compile', () => {
  it('queues a compile and answers 202 with where it stands', async () => {
    const { h, compiler, control } = await compiling({ gated: true });
    const [a, b] = [await create(h), await create(h)];
    const compile = async (id: string) => {
      const res = await h.request('POST', ApiPaths.episodeCompile(id));
      expect(res.status).toBe(202);
      return EpisodeCompileResponseSchema.parse(await res.json());
    };
    expect(await compile(a)).toEqual({ ok: true, state: 'running' });
    expect(await compile(b)).toEqual({ ok: true, state: 'queued' });
    expect(await compile(a)).toEqual({ ok: true, state: 'running' });
    await openGate(control);
    await compiler.idle();
    expect((await derivedOf(h, a)).state).toBe('ok');
  });

  it('compiles again even when the compile is up to date', async () => {
    const { h, compiler, kinds } = await compiling();
    const id = await create(h);
    await finish(h, id);
    await compiler.idle();
    const before = (await derivedOf(h, id)).manifest;
    expect((await h.request('POST', ApiPaths.episodeCompile(id))).status).toBe(202);
    await compiler.idle();
    expect(await kinds()).toEqual([id, `${id} force`]);
    const after = await derivedOf(h, id);
    expect(after.state).toBe('ok');
    expect(after.manifest?.compiledAt).not.toBe(before?.compiledAt);
  });

  it('makes a finish compile that is still waiting a forced one', async () => {
    const { h, compiler, control, kinds } = await compiling({ gated: true });
    const [busy, id] = [await create(h), await create(h)];
    await finish(h, busy);
    await finish(h, id);
    expect((await h.request('POST', ApiPaths.episodeCompile(id))).status).toBe(202);
    expect(compiler.state(id)).toBe('queued');
    await openGate(control);
    await compiler.idle();
    expect(await kinds()).toEqual([busy, `${id} force`]);
  });

  it('answers 404 for an unknown episode and 400 for an unsafe id', async () => {
    const { h } = await compiling();
    const missing = await h.request('POST', ApiPaths.episodeCompile('ep-nope'));
    expect(missing.status).toBe(404);
    expect((await errorOf(missing)).code).toBe('not_found');
    const unsafe = await h.request('POST', '/api/episodes/..%2Fdata/compile');
    expect(unsafe.status).toBe(400);
    expect((await errorOf(unsafe)).code).toBe('invalid_id');
  });

  it('answers 503 when the server cannot compile', async () => {
    const h = await harness();
    const id = await create(h);
    const res = await h.request('POST', ApiPaths.episodeCompile(id));
    expect(res.status).toBe(503);
    const error = await errorOf(res);
    expect(error.code).toBe('compile_not_configured');
    expect(error.message).toMatch(/CLIO_COMPILE/);
    // Finishing still works without a compiler.
    await finish(h, id);
  });
});

describe('GET /api/episodes/:id/derived/:name', () => {
  it('serves a compiled file as uncached JSON', async () => {
    const { h, compiler } = await compiling();
    const id = await create(h);
    await finish(h, id);
    await compiler.idle();
    for (const name of ['manifest.json', 'tracks.json']) {
      const res = await h.request('GET', ApiPaths.episodeDerived(id, name));
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/json');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.text()).toBe(await readFile(join(h.derivedDir, id, name), 'utf8'));
    }
  });

  it('serves whatever the compiler wrote, with no compiler running', async () => {
    const h = await harness();
    const id = await create(h);
    await mkdir(join(h.derivedDir, id), { recursive: true });
    await writeFile(join(h.derivedDir, id, 'retarget-clio-arm-6dof.json'), '{"kind":"retarget"}');
    const res = await h.request('GET', ApiPaths.episodeDerived(id, 'retarget-clio-arm-6dof.json'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ kind: 'retarget' });
  });

  it('refuses a name that is not a compiled file name before touching the disk', async () => {
    const h = await harness();
    const id = await create(h);
    for (const name of [
      '..%2Fmanifest.json',
      `..%2F..%2Fepisodes%2F${id}%2Fmeta.json`,
      '..%2F..%2F..%2Fetc%2Fpasswd.json',
      'Tracks.json',
      'TRACKS.JSON',
      'frames.ndjson',
      'tracks',
      '.manifest.json',
      '-tracks.json',
      'tracks.json%00.txt',
      `${'a'.repeat(100)}.json`,
    ]) {
      const res = await h.request('GET', `/api/episodes/${id}/derived/${name}`);
      expect(res.status, name).toBe(400);
      expect((await errorOf(res)).code).toBe('invalid_name');
    }
    const unsafe = await h.request('GET', '/api/episodes/..%2Fepisodes/derived/manifest.json');
    expect(unsafe.status).toBe(400);
    expect((await errorOf(unsafe)).code).toBe('invalid_id');
  });

  it('answers 404 for a file that is not there', async () => {
    const h = await harness();
    const id = await create(h);
    expect((await h.request('GET', ApiPaths.episodeDerived(id, 'tracks.json'))).status).toBe(404);
    expect((await h.request('GET', ApiPaths.episodeDerived('ep-nope', 'tracks.json'))).status).toBe(
      404,
    );
    await mkdir(join(h.derivedDir, id, 'environment.json'), { recursive: true });
    const dir = await h.request('GET', ApiPaths.episodeDerived(id, 'environment.json'));
    expect(dir.status).toBe(404);
    expect((await errorOf(dir)).code).toBe('not_found');
  });
});

describe('the derived status in GET /api/episodes/:id', () => {
  it('goes from none to ok, then to stale once a raw file grows', async () => {
    const { h, compiler } = await compiling();
    const id = await create(h);
    await record(h, id);
    expect(await derivedOf(h, id)).toEqual({ state: 'none', manifest: null, error: null });

    await finish(h, id);
    await compiler.idle();
    const ok = await derivedOf(h, id);
    expect(ok.state).toBe('ok');

    await appendFile(
      join(h.episodesDir, id, 'objects.ndjson'),
      `${JSON.stringify(objectTrack(9))}\n`,
    );
    expect(await derivedOf(h, id)).toEqual({ ...ok, state: 'stale' });
  });

  it('reports none, ok and stale without a compiler too', async () => {
    const h = await harness();
    const id = await create(h);
    expect(await derivedOf(h, id)).toEqual({ state: 'none', manifest: null, error: null });

    // Compiled by hand (`clio compile`) while the server runs without a compiler.
    const byHand = new ProcessEpisodeCompiler({
      command: fakeClio(),
      episodesDir: h.episodesDir,
      derivedDir: h.derivedDir,
    });
    byHand.enqueue(id);
    await byHand.idle();
    expect((await derivedOf(h, id)).state).toBe('ok');

    await finish(h, id);
    expect((await derivedOf(h, id)).state).toBe('stale');
  });

  it('reports an unreadable or invalid manifest as stale, warning once per manifest', async () => {
    const h = await harness();
    const id = await create(h);
    const path = join(h.derivedDir, id, 'manifest.json');
    const stale = { state: 'stale', manifest: null, error: null };
    const warnings = () => h.logger.lines.filter((l) => l.startsWith('warn'));
    await mkdir(join(h.derivedDir, id), { recursive: true });
    await writeFile(path, '{"schema":');
    expect(await derivedOf(h, id)).toEqual(stale);
    expect(await derivedOf(h, id)).toEqual(stale);
    expect(warnings()).toEqual([
      expect.stringMatching(
        new RegExp(
          `^warn Episode ${id}: derived manifest\\.json unreadable \\(.*\\); reported as stale$`,
        ),
      ),
    ]);

    // From an older pipeline: valid JSON, but not a manifest this server reads.
    await writeFile(path, JSON.stringify({ schema: 'clio.derived/0' }));
    for (let i = 0; i < 3; i++) expect(await derivedOf(h, id)).toEqual(stale);
    const schemaWarning = `warn Episode ${id}: derived manifest.json does not match the schema; reported as stale`;
    expect(warnings().slice(1)).toEqual([schemaWarning]);
    // A new version of the file, though as invalid, is worth one more warning.
    await utimes(path, new Date(), new Date(Date.now() + 5000));
    expect(await derivedOf(h, id)).toEqual(stale);
    expect(warnings().slice(1)).toEqual([schemaWarning, schemaWarning]);

    // Not a file at all.
    await rm(path);
    await mkdir(path);
    expect(await derivedOf(h, id)).toEqual(stale);
    expect(warnings()).toHaveLength(4);
  });

  it('reports an invalid manifest as stale until a compile replaces it', async () => {
    const { h, compiler } = await compiling();
    const id = await create(h);
    await finish(h, id);
    await compiler.idle();
    const path = join(h.derivedDir, id, 'manifest.json');
    const manifest = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    // As an older pipeline wrote it, before `retarget` existed.
    delete manifest.retarget;
    await writeFile(path, JSON.stringify(manifest));
    expect(await derivedOf(h, id)).toEqual({ state: 'stale', manifest: null, error: null });
    // The compiled files it lists are still served meanwhile.
    expect((await h.request('GET', ApiPaths.episodeDerived(id, 'tracks.json'))).status).toBe(200);

    expect((await h.request('POST', ApiPaths.episodeCompile(id))).status).toBe(202);
    await compiler.idle();
    const after = await derivedOf(h, id);
    expect(after.state).toBe('ok');
    expect(after.manifest).toMatchObject({ episodeId: id, retarget: [] });
  });

  it('shows the failure of an episode the startup sweep could not compile', async () => {
    const { h, compiler, control } = await compiling();
    // Both finished while the server was down: no route asked for their compiles.
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const { episodeId } = await h.episodes.create(episodeCreate());
      await h.episodes.finish(episodeId, finishBody());
      ids.push(episodeId);
    }
    const [bad = '', good = ''] = ids;
    await steer(control, bad, 'fail', 'clio: cannot compile: frames.ndjson:1: invalid JSON\n');
    await compiler.sweep();
    await compiler.idle();

    expect(await derivedOf(h, bad)).toEqual({
      state: 'failed',
      manifest: null,
      error: 'clio: cannot compile: frames.ndjson:1: invalid JSON',
    });
    expect((await derivedOf(h, good)).state).toBe('ok');
  });
});

describe('isStale', () => {
  const current = new Map<string, number>([
    ['meta.json', 900],
    ['frames.ndjson', 4000],
    ['events.ndjson', 0],
    ['objects.ndjson', 0],
    ['observations.ndjson', 0],
    ['batches.json', 30],
  ]);
  const listed = [...current] as [string, number][];

  it('is fresh while every input exists as listed with its listed size', () => {
    expect(isStale(manifestWith(listed), current)).toBe(false);
  });

  it('is stale when an input grew, appeared or vanished', () => {
    expect(isStale(manifestWith(listed), new Map([...current, ['frames.ndjson', 4100]]))).toBe(
      true,
    );
    expect(isStale(manifestWith(listed), new Map([...current, ['finish.json', 120]]))).toBe(true);
    const withoutObservations = new Map(current);
    withoutObservations.delete('observations.ndjson');
    expect(isStale(manifestWith(listed), withoutObservations)).toBe(true);
  });

  it('ignores what is not a compile input', () => {
    const manifest = manifestWith([...listed, ['media/egocentric.webm', 52_000]]);
    expect(isStale(manifest, new Map([...current, ['notes.txt', 10]]))).toBe(false);
  });
});

describe('compiling and reading compiled files', () => {
  it('never changes a byte of the raw episode', async () => {
    const { h, compiler, control } = await compiling({ gated: true });
    const id = await create(h);
    await record(h, id);
    await h.request('PUT', ApiPaths.episodeMedia(id, 'egocentric.webm'), new Uint8Array([7, 8]));
    await finish(h, id);
    const dir = join(h.episodesDir, id);
    const before = await snapshot(dir);
    expect([...before.keys()].sort()).toEqual([
      'batches.json',
      'events.ndjson',
      'finish.json',
      'frames.ndjson',
      'media/egocentric.webm',
      'meta.json',
      'objects.ndjson',
      'observations.ndjson',
    ]);

    await openGate(control);
    await compiler.idle();
    await h.request('POST', ApiPaths.episodeCompile(id));
    await compiler.idle();
    for (const name of ['manifest.json', 'tracks.json']) {
      expect((await h.request('GET', ApiPaths.episodeDerived(id, name))).status).toBe(200);
    }
    expect((await derivedOf(h, id)).state).toBe('ok');
    for (const path of [ApiPaths.episodeObservations(id), ApiPaths.episodeFrames(id)]) {
      expect((await h.request('GET', path)).status).toBe(200);
    }
    expect(await snapshot(dir)).toEqual(before);
  });

  it('leaves the raw episode alone when a compile fails', async () => {
    const { h, compiler, control } = await compiling();
    const id = await create(h);
    await record(h, id);
    await steer(control, id, 'fail', 'boom');
    await finish(h, id);
    const before = await snapshot(join(h.episodesDir, id));
    await compiler.idle();
    expect((await derivedOf(h, id)).state).toBe('failed');
    expect(await snapshot(join(h.episodesDir, id))).toEqual(before);
  });
});

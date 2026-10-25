import { mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ApiErrorSchema,
  ApiPaths,
  EpisodeCompileResponseSchema,
  EpisodeDetailResponseSchema,
} from '@clio/protocol';
import { describe, expect, it, onTestFinished } from 'vitest';
import { ProcessEpisodeCompiler } from '../src/services/episode-compiler';
import { ProcessSceneBuilder } from '../src/services/scene-builder';
import { fakeClio, fakeRuns, manifestWith, openGate, sceneDoc, steer } from './compile-fixtures';
import { episodeCreate, finishBody } from './fixtures';
import { type Harness, harness, tempDir } from './harness';

// The rebuilt scene (`clio scene`, data/scenes/<id>/): building it after the finish compile, the
// build route, its file route and its status in the episode detail. The app runs the real
// ProcessEpisodeCompiler and ProcessSceneBuilder, wired as the server wires them, spawning
// fake-clio-cli.mjs in place of `uv run clio`.

const COMPILED_AT = '2026-10-24T03:20:00.000Z';

async function create(h: Harness): Promise<string> {
  const res = await h.request('POST', ApiPaths.episodes, episodeCreate());
  expect(res.status).toBe(201);
  return ((await res.json()) as { episodeId: string }).episodeId;
}

async function detailOf(h: Harness, id: string) {
  const res = await h.request('GET', ApiPaths.episode(id));
  expect(res.status).toBe(200);
  const { derived, scene } = EpisodeDetailResponseSchema.parse(await res.json());
  if (!derived || !scene) throw new Error('The detail has no derived or scene status');
  return { derived, scene };
}

const sceneOf = async (h: Harness, id: string) => (await detailOf(h, id)).scene;

async function finish(h: Harness, id: string): Promise<void> {
  const res = await h.request('POST', ApiPaths.episodeFinish(id), finishBody());
  expect(res.status).toBe(200);
}

/** POST /api/episodes/:id/scene; ApiPaths has no entry for it. */
const buildPath = (id: string) => `${ApiPaths.episode(id)}/scene`;

async function rebuild(h: Harness, id: string) {
  const res = await h.request('POST', buildPath(id));
  expect(res.status).toBe(202);
  return EpisodeCompileResponseSchema.parse(await res.json());
}

/** The app with a compiler and a scene builder; `gated` holds every build at its start. */
async function building({ gated = false } = {}) {
  const control = await tempDir();
  const compileControl = await tempDir();
  if (!gated) await openGate(control);
  await openGate(compileControl);
  const logPath = join(control, 'runs.ndjson');
  let compiler: ProcessEpisodeCompiler | undefined;
  let builder: ProcessSceneBuilder | undefined;
  const h = await harness({
    compiler: (dirs) => {
      compiler = new ProcessEpisodeCompiler({
        command: fakeClio('--control', compileControl),
        ...dirs,
        onCompiled: (id, run) => builder?.afterCompile(id, run),
      });
      return compiler;
    },
    sceneBuilder: (dirs) => {
      builder = new ProcessSceneBuilder({
        command: fakeClio('--log', logPath, '--control', control),
        ...dirs,
        models: 'primitive',
      });
      return builder;
    },
  });
  if (!compiler || !builder) throw new Error('The harness did not build the compiler and builder');
  const [c, b] = [compiler, builder];
  onTestFinished(() => {
    c.close();
    b.close();
  });
  return {
    h,
    compiler: c,
    builder: b,
    control,
    settled: async () => {
      await c.idle();
      await b.idle();
    },
    /** Each build's episode, and `force` when it ran without `--if-stale`. */
    kinds: async () =>
      (await fakeRuns(logPath))
        .filter((r) => r.event === 'start')
        .map((r) => (r.ifStale ? r.key : `${r.key} force`)),
  };
}

async function errorOf(res: Response) {
  return ApiErrorSchema.parse(await res.json()).error;
}

/** Writes a file the way the pipeline leaves it: data/<dir>/<id>/<name>. */
async function put(dir: string, id: string, name: string, data: string | Uint8Array) {
  await mkdir(join(dir, id), { recursive: true });
  await writeFile(join(dir, id, name), data);
}

const compiled = (h: Harness, id: string, compiledAt = COMPILED_AT) =>
  put(
    h.derivedDir,
    id,
    'manifest.json',
    JSON.stringify(manifestWith([], { episodeId: id, compiledAt })),
  );

const built = (h: Harness, id: string, compiledAt = COMPILED_AT) =>
  put(h.scenesDir, id, 'scene.json', JSON.stringify(sceneDoc(id, compiledAt)));

describe('building the scene after the finish compile', () => {
  it('compiles, then builds the scene in the background, and reports each step', async () => {
    const { h, builder, control, settled } = await building({ gated: true });
    const id = await create(h);
    await finish(h, id);
    await expect.poll(() => builder.state(id)).toBe('running');
    const during = await detailOf(h, id);
    expect(during.derived.state).toBe('ok');
    expect(during.scene).toEqual({ state: 'running', scene: null, error: null });

    await openGate(control);
    await settled();
    const after = await detailOf(h, id);
    expect(after.scene.state).toBe('ok');
    expect(after.scene.error).toBeNull();
    expect(after.scene.scene).toMatchObject({
      episodeId: id,
      compiledAt: after.derived.manifest?.compiledAt,
      options: { models: 'primitive' },
    });
    const model = await h.request('GET', ApiPaths.episodeScene(id, 'model-cup_a.glb'));
    expect(model.status).toBe(200);
    expect(model.headers.get('content-type')).toBe('model/gltf-binary');
  });

  it('reports a failed build with the end of its stderr, beside the last scene if any', async () => {
    const { h, control, settled } = await building();
    const id = await create(h);
    await steer(control, id, 'fail', 'Traceback (most recent call last):\nKeyError: cup_a\n');
    await finish(h, id);
    await settled();
    const error = 'Traceback (most recent call last):\nKeyError: cup_a';
    expect(await sceneOf(h, id)).toEqual({ state: 'failed', scene: null, error });

    await rm(join(control, `${id}.fail`));
    await rebuild(h, id);
    await settled();
    const ok = await sceneOf(h, id);
    expect(ok).toMatchObject({ state: 'ok', error: null });

    // A failed rebuild leaves the scene there, still of the current compile.
    await steer(control, id, 'fail', 'boom\n');
    await rebuild(h, id);
    await settled();
    expect(await sceneOf(h, id)).toEqual({ ...ok, error: 'boom' });

    // A new compile whose build fails leaves a stale scene.
    expect((await h.request('POST', ApiPaths.episodeCompile(id))).status).toBe(202);
    await settled();
    expect(await sceneOf(h, id)).toEqual({ ...ok, state: 'stale', error: 'boom' });
  });
});

describe('POST /api/episodes/:id/scene', () => {
  it('queues a forced build and answers 202 with where it stands', async () => {
    const { h, builder, control, settled, kinds } = await building({ gated: true });
    const [a, b] = [await create(h), await create(h)];
    for (const id of [a, b]) await compiled(h, id);
    expect(await rebuild(h, a)).toEqual({ ok: true, state: 'running' });
    expect(await rebuild(h, b)).toEqual({ ok: true, state: 'queued' });
    expect(await rebuild(h, a)).toEqual({ ok: true, state: 'running' });
    expect((await sceneOf(h, b)).state).toBe('queued');

    await openGate(control);
    await settled();
    expect(await kinds()).toEqual([`${a} force`, `${b} force`, `${a} force`]);
    expect(builder.state(a)).toBe('idle');
    for (const id of [a, b]) expect((await sceneOf(h, id)).state).toBe('ok');
  });

  it('builds again even when the scene is up to date', async () => {
    const { h, settled, kinds } = await building();
    const id = await create(h);
    await finish(h, id);
    await settled();
    const before = (await sceneOf(h, id)).scene;
    await rebuild(h, id);
    await settled();
    expect(await kinds()).toEqual([id, `${id} force`]);
    const after = await sceneOf(h, id);
    expect(after.state).toBe('ok');
    expect(after.scene?.builtAt).not.toBe(before?.builtAt);
  });

  it('answers 404 for an unknown episode and 400 for an unsafe id', async () => {
    const { h } = await building();
    const missing = await h.request('POST', buildPath('ep-nope'));
    expect(missing.status).toBe(404);
    expect((await errorOf(missing)).code).toBe('not_found');
    const unsafe = await h.request('POST', '/api/episodes/..%2Fdata/scene');
    expect(unsafe.status).toBe(400);
    expect((await errorOf(unsafe)).code).toBe('invalid_id');
  });

  it('answers 503 when scene builds are off', async () => {
    const h = await harness();
    const id = await create(h);
    const res = await h.request('POST', buildPath(id));
    expect(res.status).toBe(503);
    const error = await errorOf(res);
    expect(error.code).toBe('scene_not_configured');
    expect(error.message).toMatch(/CLIO_SCENE=auto/);
    // The status still reads what is on disk.
    await compiled(h, id);
    await built(h, id);
    expect((await sceneOf(h, id)).state).toBe('ok');
  });
});

describe('GET /api/episodes/:id/scene/:name', () => {
  it('serves each scene file uncached, with its content type and length', async () => {
    const h = await harness();
    const id = await create(h);
    const files: [string, string, Uint8Array][] = [
      ['scene.json', 'application/json', new TextEncoder().encode('{"schema":"clio.scene/1"}')],
      ['model-cup_a.glb', 'model/gltf-binary', new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2, 0])],
      ['crop-cup_a-1.jpg', 'image/jpeg', new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10])],
    ];
    for (const [name, type, bytes] of files) {
      await put(h.scenesDir, id, name, bytes);
      const res = await h.request('GET', ApiPaths.episodeScene(id, name));
      expect(res.status, name).toBe(200);
      expect(res.headers.get('content-type')).toBe(type);
      expect(res.headers.get('content-length')).toBe(String(bytes.length));
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
    }
  });

  it('refuses a name that is not a scene file name before touching the disk', async () => {
    const h = await harness();
    const id = await create(h);
    for (const name of [
      '..%2Fscene.json',
      `..%2F..%2Fderived%2F${id}%2Fmanifest.json`,
      `..%2F..%2Fepisodes%2F${id}%2Fmeta.json`,
      'Scene.json',
      'MODEL.GLB',
      'splat.ply',
      'model-cup_a.gltf',
      'crop-cup_a-1.jpeg',
      '.scene.json',
      '-scene.json',
      'scene',
      'scene.json%00.jpg',
      `${'a'.repeat(100)}.glb`,
    ]) {
      const res = await h.request('GET', `/api/episodes/${id}/scene/${name}`);
      expect(res.status, name).toBe(400);
      const error = await errorOf(res);
      expect(error.code).toBe('invalid_name');
      expect(error.message).toMatch(/ending in \.json, \.glb or \.jpg$/);
    }
    const unsafe = await h.request('GET', '/api/episodes/..%2Fscenes/scene/scene.json');
    expect(unsafe.status).toBe(400);
    expect((await errorOf(unsafe)).code).toBe('invalid_id');
  });

  it('answers 404 for a file that is not there', async () => {
    const h = await harness();
    const id = await create(h);
    expect((await h.request('GET', ApiPaths.episodeScene(id, 'scene.json'))).status).toBe(404);
    expect((await h.request('GET', ApiPaths.episodeScene('ep-nope', 'scene.json'))).status).toBe(
      404,
    );
    // A compiled file is not a scene file, even with a scene name.
    await put(h.derivedDir, id, 'model-cup_a.glb', new Uint8Array([1]));
    expect((await h.request('GET', ApiPaths.episodeScene(id, 'model-cup_a.glb'))).status).toBe(404);
    await mkdir(join(h.scenesDir, id, 'model-cup_a.glb'), { recursive: true });
    const dir = await h.request('GET', ApiPaths.episodeScene(id, 'model-cup_a.glb'));
    expect(dir.status).toBe(404);
    expect((await errorOf(dir)).code).toBe('not_found');
  });
});

describe('the scene status in GET /api/episodes/:id', () => {
  it('is none before a scene is built, with or without a compile', async () => {
    const h = await harness();
    const id = await create(h);
    const none = { state: 'none', scene: null, error: null };
    expect(await sceneOf(h, id)).toEqual(none);
    await compiled(h, id);
    expect(await sceneOf(h, id)).toEqual(none);
  });

  it('is ok while the scene was built from the compile on disk', async () => {
    const h = await harness();
    const id = await create(h);
    await compiled(h, id);
    await built(h, id);
    expect(await sceneOf(h, id)).toEqual({
      state: 'ok',
      scene: sceneDoc(id, COMPILED_AT),
      error: null,
    });
    // The same instant written more precisely is the same compile.
    await built(h, id, '2026-10-24T03:20:00.000000Z');
    expect((await sceneOf(h, id)).state).toBe('ok');
  });

  it('is stale once the compile is newer, gone or unreadable', async () => {
    const h = await harness();
    const id = await create(h);
    await built(h, id);
    await compiled(h, id, '2026-10-24T04:00:00.000Z');
    const stale = await sceneOf(h, id);
    expect(stale).toEqual({ state: 'stale', scene: sceneDoc(id, COMPILED_AT), error: null });

    await put(h.derivedDir, id, 'manifest.json', '{"schema":');
    expect(await sceneOf(h, id)).toEqual(stale);
    await rm(join(h.derivedDir, id), { recursive: true });
    expect(await sceneOf(h, id)).toEqual(stale);
  });

  it('reports an unreadable or invalid scene.json as stale, warning once per version', async () => {
    const h = await harness();
    const id = await create(h);
    await compiled(h, id);
    const path = join(h.scenesDir, id, 'scene.json');
    const stale = { state: 'stale', scene: null, error: null };
    const warnings = () => h.logger.lines.filter((l) => l.startsWith(`warn Episode ${id}: scene`));
    await put(h.scenesDir, id, 'scene.json', '{"schema":');
    expect(await sceneOf(h, id)).toEqual(stale);
    expect(await sceneOf(h, id)).toEqual(stale);
    expect(warnings()).toEqual([
      expect.stringMatching(/scene\.json unreadable \(.*\); reported as stale$/),
    ]);

    // From an older pipeline, with the splat this server no longer reads.
    const old = {
      ...sceneDoc(id, COMPILED_AT),
      options: { models: 'primitive', splatSteps: 7000 },
    };
    await writeFile(path, JSON.stringify({ ...old, schema: 'clio.scene/0' }));
    for (let i = 0; i < 3; i++) expect(await sceneOf(h, id)).toEqual(stale);
    const schemaWarning = `warn Episode ${id}: scene.json does not match the schema; reported as stale`;
    expect(warnings().slice(1)).toEqual([schemaWarning]);
    await utimes(path, new Date(), new Date(Date.now() + 5000));
    expect(await sceneOf(h, id)).toEqual(stale);
    expect(warnings().slice(1)).toEqual([schemaWarning, schemaWarning]);

    // Once a build replaces it, it reads again.
    await built(h, id);
    expect((await sceneOf(h, id)).state).toBe('ok');
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(sceneDoc(id, COMPILED_AT));
  });
});

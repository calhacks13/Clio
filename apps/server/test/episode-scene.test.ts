import { mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ApiErrorSchema, ApiPaths, EpisodeDetailResponseSchema } from '@clio/protocol';
import { describe, expect, it } from 'vitest';
import { manifestWith, sceneDoc } from './compile-fixtures';
import { episodeCreate } from './fixtures';
import { type Harness, harness } from './harness';

// The rebuilt scene (`clio scene`, data/scenes/<id>/): its file route and its status in the
// episode detail.

const COMPILED_AT = '2026-10-24T03:20:00.000Z';

async function create(h: Harness): Promise<string> {
  const res = await h.request('POST', ApiPaths.episodes, episodeCreate());
  expect(res.status).toBe(201);
  return ((await res.json()) as { episodeId: string }).episodeId;
}

async function sceneOf(h: Harness, id: string) {
  const res = await h.request('GET', ApiPaths.episode(id));
  expect(res.status).toBe(200);
  const scene = EpisodeDetailResponseSchema.parse(await res.json()).scene;
  if (!scene) throw new Error('The detail has no scene status');
  return scene;
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

describe('GET /api/episodes/:id/scene/:name', () => {
  it('serves each scene file uncached, with its content type and length', async () => {
    const h = await harness();
    const id = await create(h);
    const files: [string, string, Uint8Array][] = [
      ['scene.json', 'application/json', new TextEncoder().encode('{"schema":"clio.scene/1"}')],
      ['cad-cup_a.json', 'application/json', new TextEncoder().encode('{"parts":[]}')],
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

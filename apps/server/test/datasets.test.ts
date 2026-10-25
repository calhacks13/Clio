import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatasetExportStatusSchema } from '@clio/protocol';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { exportError, ProcessDatasetExporter } from '../src/services/dataset-exporter';
import { episodeCreate, finishBody, frame } from './fixtures';
import { type Harness, harness, tempDir } from './harness';

const BASE = '/api/datasets/exports';
// Fake only the expensive Python boundary. The actual queue, validation, stores and HTTP run.
const PIPELINE = `
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
const args = process.argv.slice(1);
const archive = args[args.indexOf('--archive') + 1];
await mkdir(dirname(archive), { recursive: true });
if (args.includes('local/fail')) { console.error('clio: Invalid recording'); process.exit(1); }
await writeFile(archive, Buffer.from([80,75,3,4,0,255]));
await writeFile(archive + '.args', JSON.stringify(args));
`;

async function setup() {
  const root = await tempDir();
  const service = new ProcessDatasetExporter({
    command: [process.execPath, '--input-type=module', '-e', PIPELINE],
    episodesDir: join(root, 'episodes'),
    exportDir: join(root, 'exports'),
  });
  onTestFinished(() => service.close());
  const h = await harness({ datasetExporter: service });
  return { h, service, root };
}

async function record(h: Harness, seq = 0) {
  const meta = await h.episodes.create(episodeCreate());
  await h.episodes.appendBatch(meta.episodeId, {
    seq,
    frames: [frame(0), frame(100)],
    events: [],
    objects: [],
    observations: [],
  });
  return meta.episodeId;
}

describe('local dataset exports', () => {
  it('reports the actual validation problem instead of the trailing issue count', () => {
    expect(
      exportError(
        'clio: /recordings/ep-1 is not a valid Clio episode:\n' +
          '  frames.ndjson:4: $.head: expected at least 7 items, got 2\n  ... and 13 more',
      ),
    ).toBe(
      'Recording validation failed: frames.ndjson:4: $.head: expected at least 7 items, got 2',
    );
    expect(exportError('Traceback\nValueError: invalid recording')).toBe(
      'ValueError: invalid recording',
    );
  });
  it('exports only the selected episodes in order, then streams an attachment', async () => {
    const { h, service, root } = await setup();
    const first = await record(h);
    const second = await record(h);
    await record(h); // Unselected, unfinished: must not enter the command.
    for (const id of [first, second]) await h.episodes.finish(id, finishBody({ batches: 1 }));
    const res = await h.request('POST', BASE, {
      name: 'my-lessons',
      episodeIds: [second, first],
      fps: 15,
    });
    expect(res.status).toBe(202);
    const job = DatasetExportStatusSchema.parse(await res.json());
    expect(job).toMatchObject({ episodeCount: 2, fps: 15, state: 'running', name: 'my-lessons' });
    expect((await h.request('GET', `${BASE}/${job.id}/download`)).status).toBe(409);
    await service.idle();
    const ready = await h.request('GET', `${BASE}/${job.id}`);
    expect(await ready.json()).toMatchObject({ state: 'ready', error: null });
    const args = JSON.parse(
      await readFile(join(root, 'exports', job.id, 'dataset.zip.args'), 'utf8'),
    );
    expect(args.slice(0, 3)).toEqual([
      'export-lerobot',
      join(root, 'episodes', second),
      join(root, 'episodes', first),
    ]);
    expect(args).toContain('local/my-lessons');
    expect(args[args.indexOf('--fps') + 1]).toBe('15');
    const download = await h.request('GET', `${BASE}/${job.id}/download`);
    expect(download.headers.get('content-disposition')).toBe(
      'attachment; filename="my-lessons.zip"',
    );
    expect(download.headers.get('cache-control')).toBe('no-store');
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(
      new Uint8Array([80, 75, 3, 4, 0, 255]),
    );
  });

  it('rejects the whole selection if any recording is unfinished, empty, missing or incomplete', async () => {
    const { h, service } = await setup();
    const unfinished = await record(h);
    const missing = await record(h, 1);
    await h.episodes.finish(missing, finishBody({ batches: 2 }));
    const empty = await h.episodes.create(episodeCreate());
    await h.episodes.finish(empty.episodeId, finishBody({ batches: 0 }));
    for (const [id, status] of [
      [unfinished, 409],
      [missing, 409],
      [empty.episodeId, 409],
      ['ep-absent', 404],
    ] as const) {
      expect((await h.request('POST', BASE, { name: 'test', episodeIds: [id] })).status).toBe(
        status,
      );
    }
    await service.idle();
  });

  it('validates names, ids, duplicates, selection limits and frame rate', async () => {
    const { h } = await setup();
    const base = { name: 'test', episodeIds: ['ep-1'], fps: 30 };
    for (const change of [
      { name: '../escape' },
      { name: 'a".zip' },
      { episodeIds: [] },
      { episodeIds: ['../data'] },
      { episodeIds: ['ep-1', 'ep-1'] },
      { episodeIds: Array.from({ length: 101 }, (_, n) => `ep-${n}`) },
      { fps: 0 },
      { fps: 30.5 },
      { fps: 121 },
    ])
      expect((await h.request('POST', BASE, { ...base, ...change })).status).toBe(400);
  });

  it('reports a failed pipeline and never offers a partial archive', async () => {
    const { h, service } = await setup();
    const id = await record(h);
    await h.episodes.finish(id, finishBody({ batches: 1 }));
    const res = await h.request('POST', BASE, { name: 'fail', episodeIds: [id] });
    const job = DatasetExportStatusSchema.parse(await res.json());
    await service.idle();
    expect(await (await h.request('GET', `${BASE}/${job.id}`)).json()).toMatchObject({
      state: 'failed',
      error: 'clio: Invalid recording',
    });
    expect((await h.request('GET', `${BASE}/${job.id}/download`)).status).toBe(409);
  });

  it('expires archives and gives a recovery message after expiry or restart', async () => {
    const { h, service } = await setup();
    const job = service.create({ name: 'test', episodeIds: ['ep-1'], fps: 30 });
    await service.idle();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3_600_001);
    try {
      expect((await h.request('GET', `${BASE}/${job.id}`)).status).toBe(404);
      await service.prune();
      expect(service.archive(job.id)).toBeNull();
    } finally {
      spy.mockRestore();
    }
    expect((await h.request('GET', `${BASE}/export-unknown`)).status).toBe(404);
  });

  it('explains when export is unavailable', async () => {
    const h = await harness();
    expect((await h.request('POST', BASE, {})).status).toBe(503);
  });
});

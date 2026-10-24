import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  entityAt,
  handAt,
  heldAt,
  loadCapturePackage,
  packageFiles,
} from '../../../src/viewer/capture';

// The Quest Capture v1 synthetic example (fixtures/capture-v1): a headset, two hands, a static table
// and a block lifted over 6 samples at 60 Hz, whose fourth pose (t = 50 ms) is a tracking loss.

const FIXTURE = join(import.meta.dirname, '..', 'fixtures', 'capture-v1');

async function filesUnder(dir: string, prefix = ''): Promise<[string, string][]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return Promise.all(
    entries
      .filter((e) => e.isFile())
      .map(async (e): Promise<[string, string]> => {
        const path = join(e.parentPath, e.name);
        return [`${prefix}${relative(dir, path)}`, await readFile(path, 'utf8')];
      }),
  );
}

const load = async () => loadCapturePackage(new Map(await filesUnder(FIXTURE)));

describe('loadCapturePackage', () => {
  it('reads the manifest and the scene', async () => {
    const capture = await load();
    expect(capture.task).toMatch(/lift a block/);
    expect(capture.durationUs).toBe(100_000);
    expect(capture.endUs).toBe(100_000);
    expect([...capture.entities.keys()]).toEqual([
      'headset',
      'left_hand',
      'right_hand',
      'table',
      'block',
    ]);
    expect(capture.entities.get('table')).toMatchObject({
      motion: 'static',
      geometry: { type: 'box', size: [0.7, 1, 0.025], color: '#cccccc' },
    });
  });

  it('loads every stream as time series', async () => {
    const capture = await load();
    const block = capture.poses.get('block');
    expect(block?.samples.map((s) => s.t_us)).toEqual([0, 16667, 33333, 50000, 66667, 83333]);
    expect(capture.headset()?.samples).toHaveLength(6);
    expect(capture.hands.left.samples).toHaveLength(6);
    expect(capture.hands.right.samples).toHaveLength(6);

    // The lost sample: drawn where it was last seen, flagged lost.
    expect(block && entityAt(block, 55_000)).toMatchObject({
      position: [0.4, 0, 0.795],
      lost: true,
    });
    expect(block && entityAt(block, 70_000)).toMatchObject({
      position: [0.4, 0, expect.closeTo(0.815)],
      lost: false,
      tracked: true,
    });

    const right = handAt(capture, 'right', 20_000);
    expect(right?.flags[0]).toBe(15);
    expect([...(right?.positions.slice(0, 3) ?? [])].map((v) => +v.toFixed(3))).toEqual([
      0.3, -0.15, 0.81,
    ]);
    expect(right?.radii[25]).toBeCloseTo(0.005);

    expect(capture.events.samples.map((e) => [e.t_us, e.event, e.entity_ids])).toEqual([
      [16667, 'grasp', ['right_hand', 'block']],
    ]);
    expect(heldAt(capture, 20_000)).toEqual(new Map([['block', 'right_hand']]));
  });

  it('names what is missing or wrong', async () => {
    const files = new Map(await filesUnder(FIXTURE));
    const without = (path: string) => new Map([...files].filter(([p]) => p !== path));
    expect(() => loadCapturePackage(without('recording.json'))).toThrow(/no recording.json/);
    expect(() => loadCapturePackage(without('streams/hands.jsonl'))).toThrow(
      /no streams\/hands.jsonl/,
    );
    const v2 = new Map(files);
    const manifest = JSON.parse(files.get('recording.json') ?? '{}');
    v2.set('recording.json', JSON.stringify({ ...manifest, schema_version: 2 }));
    expect(() => loadCapturePackage(v2)).toThrow(/not Quest Capture v1/);
  });
});

describe('packageFiles', () => {
  it('re-roots a picked folder at the folder holding recording.json', async () => {
    const picked = await filesUnder(FIXTURE, 'my-recording/');
    picked.push(['notes.txt', 'outside the package']);
    const files = packageFiles(picked);
    expect(files.has('recording.json')).toBe(true);
    expect(files.has('streams/objects.jsonl')).toBe(true);
    expect(files.has('notes.txt')).toBe(false);
    expect(loadCapturePackage(files).poses.get('block')?.samples).toHaveLength(6);
    expect(() => packageFiles([['a.txt', '']])).toThrow(/no recording.json/);
  });
});

import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { type BufferGeometry, type LineSegments, Mesh, type MeshBasicMaterial } from 'three';
import { describe, expect, it } from 'vitest';
import {
  type CaptureModel,
  ClioCaptureBuilder,
  loadCapturePackage,
  ObjectTracksView,
} from '../../../src/viewer/capture';

const FIXTURE = join(import.meta.dirname, '..', 'fixtures', 'capture-v1');

async function fixture(): Promise<CaptureModel> {
  const entries = await readdir(FIXTURE, { recursive: true, withFileTypes: true });
  const files = await Promise.all(
    entries
      .filter((e) => e.isFile())
      .map(async (e): Promise<[string, string]> => {
        const path = join(e.parentPath, e.name);
        return [relative(FIXTURE, path), await readFile(path, 'utf8')];
      }),
  );
  return loadCapturePackage(new Map(files));
}

const bodyOpacity = (view: ObjectTracksView, id: string) =>
  ((view.objectFor(id)?.children[0] as Mesh | undefined)?.material as MeshBasicMaterial | undefined)
    ?.opacity;
const heldRing = (view: ObjectTracksView, id: string) =>
  (view.objectFor(id)?.children ?? []).find(
    (c) => c instanceof Mesh && c.geometry.type === 'TorusGeometry',
  );

describe('ObjectTracksView', () => {
  it('places each object at its pose at t, fading it while lost', async () => {
    const view = new ObjectTracksView(await fixture());
    const block = view.objectFor('block');
    view.update(0);
    expect(block?.visible).toBe(true);
    expect(block?.position.toArray()).toEqual([0.4, 0, 0.775]);
    expect(bodyOpacity(view, 'block')).toBe(1);

    view.update(55_000);
    expect(block?.position.toArray()).toEqual([0.4, 0, 0.795]);
    expect(bodyOpacity(view, 'block')).toBeLessThan(1);

    view.update(90_000);
    expect(block?.position.z).toBeCloseTo(0.825);
    expect(bodyOpacity(view, 'block')).toBe(1);
  });

  it('draws a trail of the recent path, broken where tracking was lost', async () => {
    const view = new ObjectTracksView(await fixture());
    view.update(83_333);
    const trail = view.object.children.find(
      (c) => (c as LineSegments).isLineSegments && c.name === '',
    ) as LineSegments;
    // Samples 0-2 (two segments) and 4-5 (one segment): three segments, six vertices.
    expect((trail.geometry as BufferGeometry).drawRange.count).toBe(6);
  });

  it('rings an object while a hand holds it', async () => {
    const view = new ObjectTracksView(await fixture());
    view.update(10_000);
    expect(heldRing(view, 'block')?.visible).toBe(false);
    view.update(20_000);
    expect(heldRing(view, 'block')?.visible).toBe(true);
  });

  it('gives each object a timeline lane', async () => {
    const view = new ObjectTracksView(await fixture());
    expect(view.lanes()).toEqual([
      {
        entityId: 'block',
        label: 'Tracked block',
        validSpans: [
          [0, 50_000],
          [66_667, 100_000],
        ],
        marks: [{ tUs: 16_667, kind: 'grasp' }],
        color: '#dc5533',
      },
    ]);
  });

  it('draws environment boxes only when asked', async () => {
    const model = await fixture();
    expect(new ObjectTracksView(model).objectFor('table')).toBeNull();
    const table = new ObjectTracksView(model, { environment: true }).objectFor('table');
    expect(table?.visible).toBe(true);
    expect(table?.position.toArray()).toEqual([0.4, 0, 0.7375]);
  });

  it('adds objects that appear while a live episode streams in', () => {
    const builder = new ClioCaptureBuilder({
      schema: 'clio.episode/1',
      episodeId: 'ep-20261024-031502-abcz',
      createdAt: '2026-10-24T03:15:02.123Z',
      mode: 'free',
      procedure: null,
      operator: { role: 'collector' },
      clock: { timeline: 'performance.now', startEpochMs: 0 },
      space: {
        frame: 'workspace',
        units: 'm',
        upAxis: '+y',
        worldFromWorkspace: [0, 0, 0, 0, 0, 0, 1],
        calibration: 'none',
        anchored: false,
      },
      hands: { joints: [], jointFields: [] },
      objects: [],
      coach: { kind: 'none' },
      device: { userAgent: 'vitest', emulated: false, xrFeatures: [] },
      app: { version: '0.1.0' },
    });
    const view = new ObjectTracksView(builder.capture);
    expect(view.lanes()).toEqual([]);
    builder.addObjects([
      {
        t: 5,
        objects: [
          {
            id: 'cup',
            position: [0.1, 0, -0.2],
            orientation: null,
            confidence: 1,
            source: 'pinch',
          },
        ],
      },
    ]);
    view.update(10_000);
    expect(view.objectFor('cup')?.position.toArray()).toEqual([0.2, -0.1, 0]);
    expect(view.lanes().map((l) => [l.entityId, l.validSpans])).toEqual([
      ['cup', [[5_000, 5_000]]],
    ]);
    view.dispose();
    expect(view.object.children).toHaveLength(0);
  });
});

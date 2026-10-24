import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { type EpisodeMeta, HAND_LAYOUT } from '@clio/protocol';
import { type BufferGeometry, type LineSegments, Mesh, type MeshBasicMaterial } from 'three';
import { describe, expect, it } from 'vitest';
import {
  Capture,
  type CaptureModel,
  ClioCaptureBuilder,
  loadCapturePackage,
  ObjectTracksView,
  POSITION_VALID,
  type PoseSample,
  type Quat,
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

const META: EpisodeMeta = {
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
  hands: HAND_LAYOUT,
  objects: [],
  coach: { kind: 'none' },
  device: { userAgent: 'vitest', emulated: false, xrFeatures: [] },
  app: { version: '0.1.0' },
};

/** A capture with one tracked object, `cup`, at these times and rotations. */
function cupWith(...samples: [number, Quat | null][]): CaptureModel {
  const capture = new Capture('test');
  capture.addEntity({
    id: 'cup',
    name: 'Cup',
    role: 'object',
    motion: 'tracked',
    geometry: { type: 'none' },
    pose: null,
  });
  for (const [t, rotation] of samples) {
    const sample: PoseSample = {
      kind: 'pose',
      t_us: t,
      sequence: t,
      source_id: 'test',
      estimate_type: 'vision_estimate',
      entity_id: 'cup',
      location: {
        translation: [t / 1000, 0, 0],
        rotation,
        location_flags: POSITION_VALID | (rotation ? 1 : 0),
      },
      confidence: null,
    };
    capture.addPose(sample);
  }
  return capture;
}

const QUARTER: Quat = [0, 0, Math.SQRT1_2, Math.SQRT1_2];

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

  it('never keeps an orientation from another time when the one at t is unknown', () => {
    const view = new ObjectTracksView(cupWith([0, null], [100, QUARTER]));
    const cup = view.objectFor('cup');
    view.update(100);
    expect(cup?.quaternion.toArray()).toEqual(QUARTER);
    expect(cup?.userData.orientationKnown).toBe(true);
    // Seeking back to before the orientation was measured.
    view.update(50);
    expect(cup?.quaternion.toArray()).toEqual([0, 0, 0, 1]);
    expect(cup?.userData.orientationKnown).toBe(false);
    expect(cup?.position.x).toBe(0);
    view.update(100);
    expect(cup?.quaternion.toArray()).toEqual(QUARTER);

    // And forward again into a newer estimate without one.
    const later = new ObjectTracksView(cupWith([0, QUARTER], [100, null]));
    later.update(0);
    later.update(150);
    expect(later.objectFor('cup')?.quaternion.toArray()).toEqual([0, 0, 0, 1]);
    expect(later.objectFor('cup')?.userData.orientationKnown).toBe(false);
  });

  it('draws static Clio points from their samples, rings carries, and skips hidden objects', () => {
    const builder = new ClioCaptureBuilder({
      ...META,
      objects: [
        { id: 'dot', label: 'dot', position: [0.1, 0, -0.2], radius: 0.02, method: 'layout' },
        { id: 'zone', label: 'zone', position: [0.2, 0, -0.2], radius: 0.05, method: 'layout' },
        { id: 'cup', label: 'cup', position: [0.3, 0, -0.2], radius: 0.04, method: 'layout' },
      ],
      plan: {
        schema: 'clio.procedure/1',
        id: 'test',
        version: 1,
        origin: { kind: 'curated' },
        title: 'Test',
        summary: 'A test plan.',
        workspace: { size: [0.6, 0.4] },
        objects: [
          {
            id: 'dot',
            label: 'dot',
            kind: 'point',
            radius: 0.02,
            hidden: false,
            placement: { method: 'layout', position: [0.1, 0, -0.2] },
          },
          {
            id: 'zone',
            label: 'zone',
            kind: 'region',
            radius: 0.05,
            hidden: true,
            placement: { method: 'layout', position: [0.2, 0, -0.2] },
          },
        ],
        steps: [
          {
            id: 'go',
            instruction: 'Go.',
            targets: [],
            hand: 'either',
            show: [],
            success: { type: 'confirm', by: 'either', prompt: 'Done' },
            mistakes: [],
          },
        ],
        coach: {},
      },
    });
    const carried = { id: 'cup', orientation: null, confidence: 1, source: 'pinch' as const };
    builder.addObjects(
      [100, 111, 122].map((t) => ({ t, objects: [{ ...carried, position: [0.3, 0.05, -0.2] }] })),
    );
    const view = new ObjectTracksView(builder.capture);
    view.update(105_000);
    expect(view.objectFor('dot')?.visible).toBe(true);
    expect(view.objectFor('dot')?.position.toArray()).toEqual([0.2, -0.1, 0]);
    expect(view.objectFor('zone')).toBeNull();
    expect(heldRing(view, 'cup')?.visible).toBe(true);
    view.update(50_000);
    expect(heldRing(view, 'cup')?.visible).toBe(false);
    expect(view.lanes().map((l) => [l.entityId, l.validSpans])).toEqual([
      ['dot', [[0, 122_000]]],
      ['cup', [[0, 122_000]]],
    ]);
  });

  it('adds objects that appear while a live episode streams in', () => {
    const builder = new ClioCaptureBuilder(META);
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

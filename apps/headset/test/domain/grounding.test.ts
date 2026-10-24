import { type Detection, parseProcedure } from '@clio/protocol';
import { describe, expect, it } from 'vitest';
import { Emitter } from '../../src/core/emitter';
import type { AppEvents } from '../../src/domain/events';
import type { CameraModel } from '../../src/domain/world/camera-model';
import {
  type CameraFrame,
  type CameraFrameSource,
  ObjectGrounder,
  type VisionLocator,
} from '../../src/domain/world/grounding';
import { ObjectRegistry } from '../../src/domain/world/object-registry';
import { PoseHistory } from '../../src/domain/world/pose-history';
import { Workspace } from '../../src/domain/world/workspace';

const procedure = parseProcedure({
  schema: 'clio.procedure/1',
  id: 'p',
  version: 1,
  title: 'P',
  summary: 'S',
  workspace: { size: [1, 1] },
  objects: [
    { id: 'cup', label: 'cup', placement: { method: 'detect' }, tracking: { query: 'paper cup' } },
    { id: 'jug', label: 'jug', placement: { method: 'detect' } },
  ],
  steps: [{ id: 's', instruction: 'Wait.', success: { type: 'elapsed', ms: 10 } }],
});

const model: CameraModel = {
  intrinsics: { width: 1280, height: 720, fx: 800, fy: 800, cx: 640, cy: 360 },
  headFromCamera: { p: [0, 0, 0], q: [0, 0, 0, 1] },
};

function setup(detections: Detection[], camera: Partial<CameraFrameSource> = {}) {
  const bus = new Emitter<AppEvents>();
  const registry = new ObjectRegistry(bus);
  registry.load(procedure.objects, 0);
  const history = new PoseHistory(16);
  history.push(90, { p: [0, 0.3, 0], q: [0, 0, 0, 1] });
  history.push(110, { p: [0, 0.3, 0], q: [0, 0, 0, 1] });
  const frame: CameraFrame = { t: 100, width: 1280, height: 720, jpegBase64: 'AAAA' };
  const queries: string[] = [];
  const source: CameraFrameSource = {
    model: () => model,
    capture: async () => frame,
    ...camera,
  };
  const locator: VisionLocator = {
    locate: async (_f, objects) => {
      queries.push(...objects.map((o) => `${o.id}=${o.query}`));
      return detections;
    },
  };
  const missing: string[][] = [];
  bus.on('object.missing', (e) => missing.push(e.objectIds));
  const grounder = new ObjectGrounder({
    camera: source,
    locator,
    registry,
    poses: history,
    workspace: () => new Workspace({ p: [0, 0, 0], q: [0, 0, 0, 1] }),
  });
  return { grounder, registry, queries, missing };
}

const cupSeen: Detection = {
  id: 'cup',
  found: true,
  point: [0.5, 560 / 720],
  box: [0.45, 0.7, 0.55, 600 / 720],
  confidence: 0.9,
};

describe('ObjectGrounder', () => {
  it('asks the locator with each object query, falling back to its label', async () => {
    const { grounder, queries } = setup([]);
    await grounder.ground(['cup', 'jug']);
    expect(queries).toEqual(['cup=paper cup', 'jug=jug']);
  });

  it('places found objects in the workspace from the head pose at capture time', async () => {
    const { grounder, registry } = setup([cupSeen]);
    const result = await grounder.ground(['cup']);
    expect(result).toEqual({ ok: true, located: ['cup'], missing: [] });
    const cup = registry.get('cup');
    expect(cup?.source).toBe('detector');
    expect(cup?.position[1]).toBeCloseTo(0.05);
    expect(cup?.position[2]).toBeCloseTo(-1);
  });

  it('reports what the camera could not find, leaving the announcing to the lesson', async () => {
    const { grounder, missing } = setup([
      cupSeen,
      { id: 'jug', found: false, point: null, box: null, confidence: 0 },
    ]);
    const result = await grounder.ground(['cup', 'jug']);
    expect(result).toEqual({ ok: true, located: ['cup'], missing: ['jug'] });
    expect(missing).toEqual([]);
  });

  it('says so when there is no camera, instead of guessing', async () => {
    const { grounder } = setup([cupSeen], { capture: async () => null });
    expect(await grounder.ground(['cup'])).toEqual({ ok: false, reason: 'no-camera-frame' });
  });
});

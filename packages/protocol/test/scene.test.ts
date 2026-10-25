import { describe, expect, it } from 'vitest';
import {
  DERIVED_FILE_NAME,
  EnvironmentDocSchema,
  SCENE_FILE_NAME,
  SCENE_SCHEMA_ID,
  SceneDocSchema,
} from '../src/index';

const model = {
  id: 'cup_a',
  label: 'cup A',
  backend: 'triposr',
  generator: 'TripoSR (grid 128)',
  model: 'model-cup_a.glb',
  crops: [
    {
      file: 'crop-cup_a-1.jpg',
      keyframe: 'keyframe-0003.jpg',
      box: [0.4, 0.3, 0.55, 0.52],
      from: 'observation',
    },
  ],
  size: [0.08, 0.1, 0.08],
  sizeSource: 'shape',
  placement: { offset: [0, -0.05, 0], rotation: [0, 0.38, 0, 0.92], rotationSource: 'shape' },
  note: null,
};

const scene = {
  schema: SCENE_SCHEMA_ID,
  episodeId: 'ep-20261025-101500-abcd',
  builtAt: '2026-10-25T10:20:00.000Z',
  builder: { name: 'clio_pipeline', version: '0.7.0' },
  frame: 'workspace',
  compiledAt: '2026-10-25T10:15:30.000Z',
  inputs: [{ name: 'derived/manifest.json', bytes: 120, sha256: 'a'.repeat(64) }],
  options: { models: 'triposr' },
  stages: [{ name: 'models', status: 'ok' }],
  keyframes: 48,
  objects: [model],
};

describe('rebuilt scene', () => {
  it('parses a scene with a generated model', () => {
    const doc = SceneDocSchema.parse(scene);
    expect(doc.objects[0]?.placement.rotationSource).toBe('shape');
  });

  it('allows an object without a model', () => {
    const bare = { ...scene, objects: [{ ...model, model: null }] };
    expect(SceneDocSchema.safeParse(bare).success).toBe(true);
  });

  it('serves only plain file names of the kinds a scene writes', () => {
    for (const name of ['scene.json', 'model-cup_a.glb', 'crop-cup_a-1.jpg']) {
      expect(SCENE_FILE_NAME.test(name)).toBe(true);
    }
    for (const name of ['../scene.json', 'splat.ply', 'x.exe', '.hidden.json']) {
      expect(SCENE_FILE_NAME.test(name)).toBe(false);
    }
    expect(DERIVED_FILE_NAME.test('room.glb')).toBe(true);
    expect(DERIVED_FILE_NAME.test('room.ply')).toBe(false);
  });
});

describe('compiled room scan', () => {
  it('rides on environment.json, and older documents without it still parse', () => {
    const env = {
      schema: 'clio.derived/1',
      episodeId: 'ep-1',
      frame: 'workspace',
      kind: 'environment',
      table: { pose: [0, 0, 0, 0, 0, 0, 1], size: null, source: 'calibration' },
      floor: null,
      planes: [],
    };
    expect(EnvironmentDocSchema.safeParse(env).success).toBe(true);
    const room = {
      file: 'room.glb',
      source: 'quest-scene',
      media: 'room-scan-2.glb',
      snapshotT: 1500,
      snapshots: 2,
      meshes: [
        {
          id: 'mesh-1',
          kind: 'other',
          label: 'global mesh',
          global: true,
          vertices: 3,
          triangles: 1,
          bounds: { min: [-2, -0.8, -3], max: [3, 1.7, 2] },
        },
      ],
    };
    expect(EnvironmentDocSchema.parse({ ...env, room }).room?.meshes[0]?.global).toBe(true);
  });
});

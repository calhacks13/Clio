import { describe, expect, it } from 'vitest';
import {
  CompiledObjectTrackSchema,
  DerivedArtifactSchema,
  DerivedKindSchema,
  ShapesDocSchema,
} from '../src/index';

// Compiled 3D for objects (docs/data-pipeline.md): an estimated metric extent on each object's
// track, and shapes.json, the depth samples fused per object relative to its tracked position.

const base = {
  schema: 'clio.derived/1',
  episodeId: 'ep-20261024-031502-test',
  frame: 'workspace',
  fps: 30,
  t: [0, 33.3, 66.7],
};

const cup = {
  id: 'cup',
  label: 'Cup',
  kind: 'container',
  radius: 0.04,
  hidden: false,
  partOf: null,
  position: [[0.3, 0, -0.2], [0.3, 0, -0.2], null],
  orientation: [null, null, null],
  tracked: [true, false, false],
  interpolated: [false, false, false],
  held: [false, false, false],
  heldBy: [null, null, null],
  confidence: [0.9, null, null],
  source: ['detector', 'detector', null],
  heldSpans: [],
};

describe('estimated extents', () => {
  it('carries the median width and height the camera saw, with how many boxes it came from', () => {
    const extent = { width: 0.08, height: 0.12, samples: 14 };
    expect(CompiledObjectTrackSchema.parse({ ...cup, extent }).extent).toEqual(extent);
  });

  it('is null when nothing could be estimated, and absent from older compiles', () => {
    expect(CompiledObjectTrackSchema.parse({ ...cup, extent: null }).extent).toBeNull();
    expect(CompiledObjectTrackSchema.parse(cup).extent).toBeUndefined();
  });

  it('rejects a size that is not positive', () => {
    const extent = { width: 0, height: 0.12, samples: 14 };
    expect(CompiledObjectTrackSchema.safeParse({ ...cup, extent }).success).toBe(false);
  });
});

describe('compiled shapes', () => {
  const shapes = {
    ...base,
    kind: 'shapes',
    policy: { voxelM: 0.01, minHits: 2, reachM: 0.3 },
    objects: [
      {
        id: 'cup',
        points: [
          [0.01, 0.02, -0.01],
          [0, 0.03, 0.01],
        ],
        box: {
          center: [0, 0.02, 0],
          rotation: [0, 0.3826834, 0, 0.9238795],
          size: [0.08, 0.1, 0.07],
        },
        samples: 48,
        frames: 2,
        firstT: 1190,
        lastT: 1690,
      },
      { id: 'lid', points: [], box: null, samples: 0, frames: 0, firstT: null, lastT: null },
    ],
  };

  it('is a derived kind the manifest can list', () => {
    expect(DerivedKindSchema.parse('shapes')).toBe('shapes');
    expect(DerivedArtifactSchema.parse({ name: 'shapes.json', kind: 'shapes', bytes: 10 })).toEqual(
      {
        name: 'shapes.json',
        kind: 'shapes',
        bytes: 10,
      },
    );
  });

  it("keeps each object's fused points and yaw box as offsets from its tracked position", () => {
    expect(ShapesDocSchema.parse(shapes)).toEqual(shapes);
  });

  it('rejects NaN instead of null', () => {
    const nan = {
      ...shapes,
      objects: [{ ...shapes.objects[0], points: [[Number.NaN, 0, 0]] }],
    };
    expect(ShapesDocSchema.safeParse(nan).success).toBe(false);
  });
});

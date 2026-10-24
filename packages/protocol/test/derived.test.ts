import { describe, expect, it } from 'vitest';
import {
  CompileManifestSchema,
  DERIVED_FILE_NAME,
  EnvironmentDocSchema,
  EpisodeDetailResponseSchema,
  RetargetDocSchema,
  TracksDocSchema,
} from '../src/index';

const sha = 'a'.repeat(64);
const base = {
  schema: 'clio.derived/1',
  episodeId: 'ep-20261024-040000-abcd',
  frame: 'workspace',
  fps: 30,
  t: [0, 33.33, 66.67],
};

const quality = {
  usable: false,
  reasons: ['not finished'],
  finished: false,
  outcome: null,
  batches: { sent: null, received: 3, missing: [] },
  durationMs: 66.67,
  frames: 3,
  frameRateHz: 30,
  maxFrameGapMs: 33.4,
  hands: { left: 0, right: 1 },
  objects: [{ id: 'cup', validFraction: 1, trackedFraction: 0.33 }],
  validationIssues: 0,
};

describe('compile manifest', () => {
  const manifest = {
    schema: 'clio.derived/1',
    episodeId: base.episodeId,
    compiledAt: '2026-10-24T05:00:00.000Z',
    compiler: { name: 'clio_pipeline', version: '0.2.0' },
    fps: 30,
    inputs: [{ name: 'frames.ndjson', bytes: 1024, sha256: sha }],
    retarget: [{ id: 'clio-arm-6dof', version: 1, profileSha256: sha, urdfSha256: sha }],
    stages: [
      { name: 'tracks', status: 'ok' },
      { name: 'retarget', status: 'skipped', detail: 'no profile' },
    ],
    artifacts: [{ name: 'tracks.json', kind: 'tracks', bytes: 2048 }],
    quality,
  };

  it('lists the raw inputs with hashes, the stages and the quality verdict', () => {
    expect(CompileManifestSchema.parse(manifest)).toEqual(manifest);
  });

  it('rejects an artifact name the server would not serve', () => {
    const bad = { ...manifest, artifacts: [{ name: '../meta.json', kind: 'tracks', bytes: 1 }] };
    expect(CompileManifestSchema.safeParse(bad).success).toBe(false);
  });

  it('shows up in episode detail only when the server can compile', () => {
    const detail = {
      meta: {
        schema: 'clio.episode/1',
        episodeId: base.episodeId,
        createdAt: '2026-10-24T04:00:00.000Z',
        mode: 'free',
        procedure: null,
        operator: { role: 'collector' },
        clock: { timeline: 'performance.now', startEpochMs: 1 },
        space: {
          frame: 'workspace',
          units: 'm',
          upAxis: '+y',
          worldFromWorkspace: [0, 0.75, -0.5, 0, 0, 0, 1],
          calibration: 'default_in_front',
          anchored: false,
        },
        hands: { joints: [], jointFields: [] },
        objects: [],
        coach: { kind: 'none' },
        device: { userAgent: 't', emulated: true, xrFeatures: [] },
        app: { version: '0' },
      },
      summary: {
        episodeId: base.episodeId,
        createdAt: '2026-10-24T04:00:00.000Z',
        mode: 'free',
        procedureId: null,
        finished: true,
        outcome: 'completed',
        durationMs: 66.67,
        frameCount: 3,
        eventCount: 0,
      },
      finish: null,
    };
    expect(EpisodeDetailResponseSchema.parse(detail).derived).toBeUndefined();
    const compiled = { ...detail, derived: { state: 'ok', manifest, error: null } };
    expect(EpisodeDetailResponseSchema.parse(compiled).derived?.state).toBe('ok');
    // A compile state this reader cannot parse must not make the recording unreadable.
    const newer = { ...detail, derived: { state: 'archived', manifest: null, error: null } };
    const parsed = EpisodeDetailResponseSchema.parse(newer);
    expect(parsed.derived).toBeUndefined();
    expect(parsed.meta.episodeId).toBe(base.episodeId);
  });
});

describe('derived file names', () => {
  it('allows lowercase json names only', () => {
    expect(DERIVED_FILE_NAME.test('tracks.json')).toBe(true);
    expect(DERIVED_FILE_NAME.test('retarget-clio-arm-6dof.json')).toBe(true);
    for (const bad of ['../x.json', 'tracks.ndjson', '.hidden.json', 'Tracks.json', 'a/b.json']) {
      expect(DERIVED_FILE_NAME.test(bad), bad).toBe(false);
    }
  });
});

describe('compiled tracks', () => {
  const tracks = {
    ...base,
    kind: 'tracks',
    policy: { maxInterpolateGapMs: 250, staleMs: 100, maxFrameGapMs: 100 },
    head: [[0, 1.6, 0.4, 0, 0, 0, 1], [0, 1.6, 0.4, 0, 0, 0, 1], null],
    hands: [
      {
        hand: 'right',
        wrist: [null, [0.2, 0.15, 0.1, 0, 0, 0, 1], [0.21, 0.15, 0.1, 0, 0, 0, 1]],
        pinch: [null, 0.05, 0.012],
      },
    ],
    objects: [
      {
        id: 'cup',
        label: 'Cup',
        kind: 'container',
        radius: 0.04,
        hidden: false,
        position: [[0.3, 0, -0.2], [0.3, 0, -0.2], null],
        orientation: [null, null, null],
        tracked: [true, false, false],
        interpolated: [false, false, false],
        held: [false, true, false],
        heldBy: [null, 'right', null],
        confidence: [0.9, null, null],
        source: ['detector', 'pinch', null],
        heldSpans: [{ hand: 'right', startT: 30, endT: 60, origin: 'recorded', grip: 'pinch' }],
      },
    ],
  };

  it('puts the head, the wrists and every object on one grid, with null for gaps', () => {
    expect(TracksDocSchema.parse(tracks)).toEqual(tracks);
  });

  it('rejects NaN instead of null', () => {
    const nan = { ...tracks, head: [[0, Number.NaN, 0, 0, 0, 0, 1], null, null] };
    expect(TracksDocSchema.safeParse(nan).success).toBe(false);
  });
});

describe('compiled environment', () => {
  it('describes the table, the floor and the detected planes in the workspace frame', () => {
    const doc = {
      schema: 'clio.derived/1',
      episodeId: base.episodeId,
      frame: 'workspace',
      kind: 'environment',
      table: { pose: [0, 0, 0, 0, 0, 0, 1], size: [0.9, 0.6], source: 'plan' },
      floor: { pose: [0, -0.75, 0.5, 0, 0, 0, 1], tableHeightM: 0.75 },
      planes: [],
    };
    expect(EnvironmentDocSchema.parse(doc)).toEqual(doc);
  });

  it('keeps the floor but no table height when the workspace was only guessed', () => {
    const doc = {
      schema: 'clio.derived/1',
      episodeId: base.episodeId,
      frame: 'workspace',
      kind: 'environment',
      table: { pose: [0, 0, 0, 0, 0, 0, 1], size: null, source: 'calibration' },
      floor: { pose: [0, -1.15, 0.45, 0, 0, 0, 1], tableHeightM: null },
      planes: [
        {
          id: 'plane-1',
          kind: 'floor',
          label: 'floor',
          orientation: 'horizontal',
          pose: [0, -0.75, 0.5, 0, 0, 0, 1],
          polygon: [
            [-2, -2],
            [2, -2],
            [2, 2],
          ],
          firstSeenT: 0,
          lastSeenT: 5000,
        },
      ],
    };
    expect(EnvironmentDocSchema.parse(doc)).toEqual(doc);
  });
});

describe('compiled retargeting', () => {
  it('keeps joint values, residuals and reachability per frame, labelled with its profile', () => {
    const doc = {
      ...base,
      kind: 'retarget',
      profile: {
        id: 'clio-arm-6dof',
        version: 1,
        robot: 'Clio example arm',
        robotType: 'clio_arm_6dof_example',
        urdfSha256: sha,
        example: true,
        orientationMode: 'approach_axis',
        tolPosM: 0.005,
        tolRotRad: 0.09,
      },
      arms: [
        {
          hand: 'right',
          joints: ['j1', 'j2'],
          baseInWorkspace: [0.3, 0, 0.3, 0, 0, 0, 1],
          q: [null, [0.1, -0.2], [0.11, -0.21]],
          gripper: [null, 0.2, 0.9],
          target: [null, [0.2, 0.15, 0.1, 0, 0, 0, 1], [0.21, 0.15, 0.1, 0, 0, 0, 1]],
          achieved: [null, [0.2, 0.15, 0.1, 0, 0, 0, 1], [0.21, 0.15, 0.1, 0, 0, 0, 1]],
          residualPosM: [null, 0.0004, 0.0006],
          residualRotRad: [null, 0.01, 0.01],
          reachable: [false, true, true],
          links: [
            null,
            [
              [0.3, 0, 0.3],
              [0.25, 0.1, 0.2],
            ],
            [
              [0.3, 0, 0.3],
              [0.25, 0.1, 0.21],
            ],
          ],
        },
      ],
      summary: { reachableFraction: 1, targetFraction: 0.67, meanResidualPosM: 0.0005 },
    };
    expect(RetargetDocSchema.parse(doc)).toEqual(doc);
  });
});

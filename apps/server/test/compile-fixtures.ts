import { readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { CompileManifest, SceneDoc } from '@clio/protocol';
import { isMissing } from '../src/storage/files';

// Drives fake-clio-cli.mjs, the stand-in for the pipeline's `clio compile` and `clio scene` (see
// the script), and builds the documents the pipeline writes.

/** A valid manifest.json listing `inputs` as [name, bytes]. */
export function manifestWith(
  inputs: [string, number][],
  fields: Partial<CompileManifest> = {},
): CompileManifest {
  return {
    schema: 'clio.derived/1',
    episodeId: 'ep-a',
    compiledAt: '2026-10-24T03:20:00.000Z',
    compiler: { name: 'clio-pipeline', version: '0.2.0' },
    fps: 30,
    inputs: inputs.map(([name, bytes]) => ({ name, bytes, sha256: 'a'.repeat(64) })),
    retarget: [],
    stages: [],
    artifacts: [],
    quality: {
      usable: false,
      reasons: ['not finished'],
      finished: false,
      outcome: null,
      batches: null,
      durationMs: 0,
      frames: 0,
      frameRateHz: null,
      maxFrameGapMs: null,
      hands: { left: 0, right: 0 },
      objects: [],
      validationIssues: 0,
    },
    ...fields,
  };
}

/** A valid scene.json built from the compile of `compiledAt`, with one primitive model. */
export function sceneDoc(episodeId: string, compiledAt: string): SceneDoc {
  return {
    schema: 'clio.scene/1',
    episodeId,
    builtAt: '2026-10-24T03:25:00.000Z',
    builder: { name: 'clio-pipeline', version: '0.8.0' },
    frame: 'workspace',
    compiledAt,
    inputs: [],
    options: { models: 'primitive' },
    stages: [{ name: 'models', status: 'ok' }],
    keyframes: 1,
    objects: [
      {
        id: 'cup_a',
        label: 'cup',
        backend: 'primitive',
        generator: null,
        model: 'model-cup_a.glb',
        cad: null,
        crops: [],
        size: [0.08, 0.1, 0.08],
        sizeSource: 'extent',
        placement: { offset: [0, -0.05, 0], rotation: [0, 0, 0, 1], rotationSource: 'none' },
        note: null,
      },
    ],
  };
}

const FAKE_CLIO = join(import.meta.dirname, 'fake-clio-cli.mjs');

/** The pipeline command for the fake: node, the script, then the script's own options. */
export function fakeClio(...options: string[]): string[] {
  return [process.execPath, FAKE_CLIO, ...options];
}

export interface FakeRun {
  event: 'start' | 'end';
  pid: number;
  /** Everything after the script path, its own options included. */
  argv: string[];
  command: 'compile' | 'scene';
  /** The episode id. */
  key: string;
  /** Whether the run was asked to skip an up-to-date output (`--if-stale`). */
  ifStale: boolean;
}

/** The runs a fake logged with `--log`, in order. */
export async function fakeRuns(logPath: string): Promise<FakeRun[]> {
  let text: string;
  try {
    text = await readFile(logPath, 'utf8');
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const run = JSON.parse(line) as Omit<FakeRun, 'command' | 'key' | 'ifStale'>;
      const split = run.argv.findIndex((arg) => arg === 'compile' || arg === 'scene');
      const command = run.argv[split] === 'scene' ? 'scene' : 'compile';
      const key = basename(run.argv[split + 1] ?? '');
      return { ...run, command, key, ifStale: run.argv.includes('--if-stale') };
    });
}

/** Lets every run waiting on the control dir's gate go ahead. */
export function openGate(control: string): Promise<void> {
  return writeFile(join(control, 'gate'), '');
}

/** Makes the fake fail runs for the episode `key` with this stderr, or hang forever. */
export function steer(
  control: string,
  key: string,
  how: 'fail' | 'hang',
  text = '',
): Promise<void> {
  return writeFile(join(control, `${key}.${how}`), text);
}

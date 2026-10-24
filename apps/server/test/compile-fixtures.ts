import { readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { isMissing } from '../src/storage/files';

// Drives fake-clio-cli.mjs, the stand-in for the pipeline's `clio compile` (see the script).

const FAKE_CLIO = join(import.meta.dirname, 'fake-clio-cli.mjs');

/** The compile command for the fake: node, the script, then the script's own options. */
export function fakeClio(...options: string[]): string[] {
  return [process.execPath, FAKE_CLIO, ...options];
}

export interface FakeRun {
  event: 'start' | 'end';
  pid: number;
  /** Everything after the script path, its own options included. */
  argv: string[];
  /** The episode id. */
  key: string;
  /** Whether the run was asked to skip an up-to-date compile (`--if-stale`). */
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
      const run = JSON.parse(line) as Omit<FakeRun, 'key' | 'ifStale'>;
      const target = run.argv[run.argv.indexOf('compile') + 1] ?? '';
      return { ...run, key: basename(target), ifStale: run.argv.includes('--if-stale') };
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

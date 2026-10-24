import { describe, expect, it } from 'vitest';
import { LatestOnly } from '../../src/primary/latest-only';

/** A job the test finishes by hand, recording when it started. */
function jobs() {
  const started: string[] = [];
  const finish = new Map<string, () => void>();
  const job =
    (name: string, fail = false) =>
    () => {
      started.push(name);
      return new Promise<void>((resolve, reject) => {
        finish.set(name, () => (fail ? reject(new Error(name)) : resolve()));
      });
    };
  const done = async (name: string) => {
    finish.get(name)?.();
    // Let the runner pick up the next job.
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  return { started, job, done };
}

describe('LatestOnly', () => {
  it('runs one job at a time and only the newest of those that came in meanwhile', async () => {
    const runner = new LatestOnly();
    const { started, job, done } = jobs();
    runner.run(job('a'));
    runner.run(job('b'));
    runner.run(job('c'));
    expect(started).toEqual(['a']);
    await done('a');
    expect(started).toEqual(['a', 'c']);
    await done('c');
    runner.run(job('d'));
    expect(started).toEqual(['a', 'c', 'd']);
  });

  it('drops the waiting job on clear', async () => {
    const runner = new LatestOnly();
    const { started, job, done } = jobs();
    runner.run(job('a'));
    runner.run(job('b'));
    runner.clear();
    await done('a');
    expect(started).toEqual(['a']);
    runner.run(job('c'));
    expect(started).toEqual(['a', 'c']);
  });

  it('carries on after a job fails', async () => {
    const runner = new LatestOnly();
    const { started, job, done } = jobs();
    runner.run(job('a', true));
    runner.run(job('b'));
    await done('a');
    expect(started).toEqual(['a', 'b']);
  });
});

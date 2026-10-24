import { describe, expect, it } from 'vitest';
import { KeyedMutex } from '../src/storage/keyed-mutex';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('KeyedMutex', () => {
  it('runs tasks for the same key one at a time, in call order', async () => {
    const mutex = new KeyedMutex();
    const log: string[] = [];
    const gate = deferred();
    const first = mutex.run('ep', async () => {
      log.push('first:start');
      await gate.promise;
      log.push('first:end');
      return 1;
    });
    const second = mutex.run('ep', async () => {
      log.push('second:start');
      return 2;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(log).toEqual(['first:start']);
    gate.resolve();
    expect(await Promise.all([first, second])).toEqual([1, 2]);
    expect(log).toEqual(['first:start', 'first:end', 'second:start']);
  });

  it('lets different keys run concurrently', async () => {
    const mutex = new KeyedMutex();
    const gate = deferred();
    const log: string[] = [];
    const a = mutex.run('a', async () => {
      log.push('a:start');
      await gate.promise;
    });
    const b = mutex.run('b', async () => {
      log.push('b:start');
    });
    await b;
    expect(log).toEqual(['a:start', 'b:start']);
    gate.resolve();
    await a;
  });

  it('keeps going after a task fails, and only the caller sees the error', async () => {
    const mutex = new KeyedMutex();
    const failing = mutex.run('ep', async () => {
      throw new Error('disk full');
    });
    const next = mutex.run('ep', async () => 'ok');
    await expect(failing).rejects.toThrow('disk full');
    await expect(next).resolves.toBe('ok');
  });

  it('forgets keys once their queue is empty', async () => {
    const mutex = new KeyedMutex();
    await Promise.all([mutex.run('a', async () => 1), mutex.run('b', async () => 2)]);
    expect(mutex.size).toBe(0);
  });
});

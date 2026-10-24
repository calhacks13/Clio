/**
 * Serializes async tasks per key (one queue per episode), so concurrent requests for the same
 * episode never interleave appends or lose a bookkeeping update. Different keys run in parallel.
 */
export class KeyedMutex {
  readonly #tails = new Map<string, Promise<void>>();

  get size(): number {
    return this.#tails.size;
  }

  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The tail never rejects: it only signals "the previous holder is finished".
    const tail = previous.then(() => done);
    this.#tails.set(key, tail);
    await previous;
    try {
      return await task();
    } finally {
      release();
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    }
  }
}

// Async jobs run one at a time, newest first: a job that comes in while another runs waits, and a
// newer one replaces it. The outline is placed this way: each placement measures depth with
// hit-test rays that take a few frames to answer, and the tracker's masks come faster than that.
// Placing every mask at once would fill the depth probe, and the masks it turned away would be
// placed at once at a guessed depth, ahead of the measured ones still waiting for their frames.

export class LatestOnly {
  private running = false;
  private waiting: (() => Promise<void>) | null = null;

  /** Run `job` now, or after the running one (replacing any job already waiting). */
  run(job: () => Promise<void>): void {
    if (this.running) {
      this.waiting = job;
      return;
    }
    this.running = true;
    void this.drain(job);
  }

  /** Drop the waiting job; the running one finishes. */
  clear(): void {
    this.waiting = null;
  }

  private async drain(first: () => Promise<void>): Promise<void> {
    let job: (() => Promise<void>) | null = first;
    while (job) {
      try {
        await job();
      } catch {
        // A job reports its own failures; the next one still runs.
      }
      job = this.waiting;
      this.waiting = null;
    }
    this.running = false;
  }
}

import type { Detection, PrimaryResponse } from '@clio/protocol';
import { describe, expect, it } from 'vitest';
import { readAnswer } from '../../src/primary/answer';
import { PrimaryLoop, type PrimaryLoopOptions, trackerUpdate } from '../../src/primary/loop';

interface Look {
  response: PrimaryResponse;
}

const box: Detection = {
  id: 'primary',
  found: true,
  point: [0.5, 0.5],
  box: [0.4, 0.4, 0.6, 0.6],
  outline: null,
  confidence: 0.9,
};

const look = (name: string | null, detection: Detection | null = null): Look => ({
  response: {
    name,
    description: name,
    detection,
    model: { picker: 'gemini', finder: 'jev+sam2.1' },
    timings: { pickMs: 0, findMs: 0 },
  },
});

/** A request the test answers (or fails) by hand. */
interface Pending {
  previous: string | null;
  signal: AbortSignal;
  resolve(look: Look | null): void;
  reject(err: unknown): void;
}

function setup(options: PrimaryLoopOptions = {}) {
  let now = 0;
  const pending: Pending[] = [];
  const answers: { name: string | null; cycleMs: number }[] = [];
  const failures: unknown[] = [];
  const loop = new PrimaryLoop<Look>({
    now: () => now,
    ask: (previous, signal) =>
      new Promise((resolve, reject) => pending.push({ previous, signal, resolve, reject })),
    answer: (answer, cycleMs) => answers.push({ name: answer.response.name, cycleMs }),
    failed: (err) => failures.push(err),
    options,
  });
  const at = (t: number) => {
    now = t;
    loop.tick();
  };
  /** Lets the loop see a request the test just settled, at time t. */
  const settle = async (t: number) => {
    now = t;
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { loop, pending, answers, failures, at, settle };
}

describe('PrimaryLoop', () => {
  it('looks as soon as it starts, and never sends a second request while one is out', () => {
    const { loop, pending, at } = setup();
    loop.start();
    at(0);
    for (let t = 16; t < 10_000; t += 16) at(t);
    expect(pending).toHaveLength(1);
    expect(loop.busy).toBe(true);
  });

  it('looks about once a second: 1 s after the last look started, naming the last object named', async () => {
    const { loop, pending, answers, at, settle } = setup();
    loop.start();
    at(0);
    pending[0]?.resolve(look('micrometer', box));
    await settle(400);
    expect(answers).toEqual([{ name: 'micrometer', cycleMs: 400 }]);
    expect(pending[0]?.previous).toBeNull();

    at(999);
    expect(pending).toHaveLength(1);
    at(1000);
    expect(pending).toHaveLength(2);
    expect(pending[1]?.previous).toBe('micrometer');
  });

  it('looks again as soon as a look that took longer than a second ends', async () => {
    const { loop, pending, at, settle } = setup();
    loop.start();
    at(0);
    pending[0]?.resolve(look('cup', box));
    await settle(2500);
    at(2516);
    expect(pending).toHaveLength(2);
    pending[1]?.resolve(look('cup', box));
    await settle(2900);
    at(3515);
    expect(pending).toHaveLength(2);
    at(3516);
    expect(pending).toHaveLength(3);
  });

  it('forgets the name once an answer says nothing stands out', async () => {
    const { loop, pending, at, settle } = setup({ periodMs: 100 });
    loop.start();
    at(0);
    pending[0]?.resolve(look('cup'));
    await settle(50);
    at(100);
    pending[1]?.resolve(look(null));
    await settle(150);
    at(200);
    expect(pending[2]?.previous).toBeNull();
  });

  it('drops an answer that arrives after the loop was stopped and restarted', async () => {
    const { loop, pending, answers, at, settle } = setup();
    loop.start();
    at(0);
    loop.stop();
    expect(pending[0]?.signal.aborted).toBe(true);
    loop.start();
    at(100);
    expect(pending).toHaveLength(2);

    pending[0]?.resolve(look('stale'));
    await settle(200);
    expect(answers).toEqual([]);
    pending[1]?.resolve(look('fresh'));
    await settle(300);
    expect(answers.map((a) => a.name)).toEqual(['fresh']);
  });

  it('gives up on a hung request, then ignores its late answer', async () => {
    const { loop, pending, answers, failures, at, settle } = setup({
      timeoutMs: 20_000,
      retryMs: 1000,
    });
    loop.start();
    at(0);
    at(19_999);
    expect(pending).toHaveLength(1);
    at(20_000);
    expect(pending[0]?.signal.aborted).toBe(true);
    expect(failures).toHaveLength(1);
    expect(loop.busy).toBe(false);
    at(20_999);
    expect(pending).toHaveLength(1);
    at(21_000);
    expect(pending).toHaveLength(2);

    pending[0]?.resolve(look('late'));
    await settle(21_500);
    expect(answers).toEqual([]);
    expect(loop.busy).toBe(true);
  });

  it('waits longer after a failure, and carries on', async () => {
    const { loop, pending, answers, failures, at, settle } = setup({ retryMs: 3000 });
    loop.start();
    at(0);
    pending[0]?.reject(new Error('502 Bad Gateway'));
    await settle(1000);
    expect(failures).toHaveLength(1);
    expect(answers).toEqual([]);
    at(1500);
    expect(pending).toHaveLength(1);
    at(4000);
    expect(pending).toHaveLength(2);
  });

  it('tries again on the next beat when there was nothing to ask about yet', async () => {
    const { loop, pending, answers, failures, at, settle } = setup();
    loop.start();
    at(0);
    pending[0]?.resolve(null);
    await settle(10);
    expect(answers).toEqual([]);
    expect(failures).toEqual([]);
    at(999);
    expect(pending).toHaveLength(1);
    at(1000);
    expect(pending).toHaveLength(2);
  });

  it('does nothing until started or after it stops', () => {
    const { loop, pending, at } = setup();
    at(0);
    expect(pending).toHaveLength(0);
    loop.start();
    loop.stop();
    at(1000);
    expect(pending).toHaveLength(0);
  });
});

describe('trackerUpdate', () => {
  const found = readAnswer(look('caliper', box).response);

  it('tells the tracker to follow what an answer found, on the frame it was measured on', () => {
    expect(trackerUpdate(found, 37, null)).toEqual({
      type: 'target',
      seq: 37,
      box: [0.4, 0.4, 0.6, 0.6],
      name: 'caliper',
    });
    expect(trackerUpdate(found, 38, 'caliper')).toMatchObject({ type: 'target', seq: 38 });
  });

  it('sends nothing for an answer measured on a frame the tracker never saw', () => {
    expect(trackerUpdate(found, null, null)).toBeNull();
  });

  it('drops the target when nothing stands out or another object is named but not found', () => {
    expect(trackerUpdate(readAnswer(look(null).response), 40, 'caliper')).toEqual({
      type: 'clear',
    });
    expect(trackerUpdate(readAnswer(look('pen').response), 40, 'caliper')).toEqual({
      type: 'clear',
    });
  });

  it('keeps following when jev misses the tracked object once, or nothing is tracked', () => {
    expect(trackerUpdate(readAnswer(look('caliper').response), 40, 'caliper')).toBeNull();
    expect(trackerUpdate(readAnswer(look(null).response), 40, null)).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { RoomScan, roomCapture } from '../../src/adapters/xr/room-scan';

const settle = () => new Promise((r) => setTimeout(r, 0));

/** A room setup the test finishes (or fails) when it likes. */
function capture() {
  let calls = 0;
  let finish: () => void = () => {};
  let fail: (err: Error) => void = () => {};
  const run = () => {
    calls++;
    return new Promise<void>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
  };
  return { run, calls: () => calls, finish: () => finish(), fail: (e: Error) => fail(e) };
}

describe('RoomScan', () => {
  it('starts the lesson at once when the room scan is already there', () => {
    const c = capture();
    const scan = new RoomScan(c.run);
    expect(scan.update(0, 6)).toBe(false);
    expect(scan.settled).toBe(true);
    expect(c.calls()).toBe(0);
  });

  it('runs room setup when no surface shows up in 1.5 s, and holds the lesson until it ends', async () => {
    const c = capture();
    const scan = new RoomScan(c.run);
    scan.update(0, 0);
    scan.update(1400, 0);
    expect(c.calls()).toBe(0);
    expect(scan.settled).toBe(false);
    scan.update(1500, 0);
    expect(c.calls()).toBe(1);
    expect(scan.settled).toBe(false);
    scan.update(1600, 0);
    expect(c.calls()).toBe(1);
    c.finish();
    await settle();
    // The frame after it ends says so once, so the workspace can look for the table again.
    expect(scan.update(30_000, 8)).toBe(true);
    expect(scan.settled).toBe(true);
    expect(scan.update(30_100, 8)).toBe(false);
  });

  it('does not wait on surfaces that arrive during the check', () => {
    const c = capture();
    const scan = new RoomScan(c.run);
    scan.update(0, 0);
    scan.update(600, 3);
    expect(scan.settled).toBe(true);
    scan.update(2000, 3);
    expect(c.calls()).toBe(0);
  });

  it('lets the lesson start when room setup fails or is not there', async () => {
    const c = capture();
    const failing = new RoomScan(c.run);
    failing.update(0, 0);
    failing.update(1500, 0);
    c.fail(new Error('NotAllowedError'));
    await settle();
    failing.update(1600, 0);
    expect(failing.settled).toBe(true);

    const without = new RoomScan(null);
    without.update(0, 0);
    expect(without.settled).toBe(true);
  });
});

describe('roomCapture', () => {
  it("is Quest Browser's initiateRoomCapture, bound to its session, when there is one", async () => {
    let called: unknown = null;
    const session = {
      initiateRoomCapture() {
        called = this;
        return Promise.resolve();
      },
    } as unknown as XRSession;
    const run = roomCapture(session);
    await run?.();
    expect(called).toBe(session);
    expect(roomCapture({} as XRSession)).toBeNull();
  });
});

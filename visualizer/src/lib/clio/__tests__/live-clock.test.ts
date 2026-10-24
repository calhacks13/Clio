import { describe, expect, test } from "bun:test";
import {
  advanceClock,
  type Clock,
  type ClockInput,
  clockModeFor,
  createClock,
  followLive,
  liveEdgeUs,
  MAX_EXTRAPOLATION_US,
  type Newest,
  PLAY_DELAY_US,
  seekClock,
  setClockMode,
  setPlaying,
  SNAP_BACKLOG_US,
} from "../live-clock";

// The playhead: lags the live edge by 1.5 s, never passes it, snaps forward
// past a 3 s backlog, and in replay stays within the capture. Laptop time is
// only `nowMs`; every `…Us` is recording time.

const FRAME_MS = 1000 / 60;
const EPISODE = "ep-20261024-120000-aaaa";

const input = (
  nowMs: number,
  newest: Newest,
  overrides: Partial<ClockInput> = {},
): ClockInput => ({
  episodeId: EPISODE,
  nowMs,
  dtMs: FRAME_MS,
  newest,
  startUs: 0,
  endUs: 0,
  ...overrides,
});

/**
 * A live feed: every `everyMs` of laptop time a read brings `everyMs` more of
 * recording, which started `firstUs` in. Runs the clock at 60 fps and hands
 * each frame's state to `check`.
 */
function runLive(
  durationMs: number,
  options: {
    everyMs?: number;
    firstUs?: number;
    stallAfterMs?: number;
    check?: (state: Clock, input: ClockInput) => void;
  } = {},
): Clock {
  const everyMs = options.everyMs ?? 1000;
  const firstUs = options.firstUs ?? 10_000_000;
  let newest: Newest = { tUs: firstUs, receivedAtMs: 0 };
  let state = createClock("live", input(0, newest));
  let nextReadMs = everyMs;
  for (let nowMs = FRAME_MS; nowMs <= durationMs; nowMs += FRAME_MS) {
    const stalled =
      options.stallAfterMs !== undefined && nowMs > options.stallAfterMs;
    if (nowMs >= nextReadMs && !stalled) {
      newest = { tUs: newest.tUs + everyMs * 1000, receivedAtMs: nowMs };
      nextReadMs += everyMs;
    }
    const frame = input(nowMs, newest);
    state = advanceClock(state, frame);
    options.check?.(state, frame);
  }
  return state;
}

describe("live edge", () => {
  test("is the newest frame advanced by laptop time since its read", () => {
    const newest = { tUs: 5_000_000, receivedAtMs: 1000 };
    expect(liveEdgeUs(newest, 1000)).toBe(5_000_000);
    expect(liveEdgeUs(newest, 1400)).toBe(5_400_000);
    // An arrival time in the future (a skewed clock) never moves it back.
    expect(liveEdgeUs(newest, 900)).toBe(5_000_000);
  });

  test("is advanced at most MAX_EXTRAPOLATION_US", () => {
    const newest = { tUs: 5_000_000, receivedAtMs: 0 };
    expect(liveEdgeUs(newest, 60_000)).toBe(5_000_000 + MAX_EXTRAPOLATION_US);
  });

  test("is 0 before any frame", () => {
    expect(liveEdgeUs(null, 1234)).toBe(0);
  });

  test("live only while the episode grows", () => {
    expect(clockModeFor("live")).toBe("live");
    expect(clockModeFor("stopped")).toBe("replay");
    expect(clockModeFor("finished")).toBe("replay");
    expect(clockModeFor(null)).toBe("replay");
  });
});

describe("live clock", () => {
  test("starts following at the play delay", () => {
    const state = createClock(
      "live",
      input(0, { tUs: 10_000_000, receivedAtMs: 0 }),
    );
    expect(state).toEqual({
      mode: "live",
      tUs: 10_000_000 - PLAY_DELAY_US,
      edgeUs: 10_000_000,
      following: true,
      playing: true,
      episodeId: EPISODE,
      held: false,
    });
  });

  test("lags the edge by 1.5 s, never passes it and never steps back", () => {
    let previous = Number.NEGATIVE_INFINITY;
    const lags: number[] = [];
    runLive(30_000, {
      check: (state, frame) => {
        expect(state.tUs).toBeLessThanOrEqual(state.edgeUs);
        expect(state.tUs).toBeGreaterThanOrEqual(previous);
        expect(state.following).toBe(true);
        previous = state.tUs;
        if (frame.nowMs > 5000) lags.push(state.edgeUs - state.tUs);
      },
    });
    for (const lag of lags) {
      expect(Math.abs(lag - PLAY_DELAY_US)).toBeLessThan(50_000);
    }
  });

  test("with late, uneven reads it still never passes the edge", () => {
    // Reads every 1.4 s carrying 1.4 s: the edge jumps back a little at each.
    runLive(30_000, {
      everyMs: 1400,
      check: (state, frame) => {
        expect(state.tUs).toBeLessThanOrEqual(state.edgeUs);
        if (frame.newest) {
          expect(state.tUs).toBeLessThanOrEqual(frame.newest.tUs);
        }
      },
    });
  });

  test("when uploads stall it stops at the newest frame", () => {
    let newestUs = 0;
    const state = runLive(20_000, {
      stallAfterMs: 10_000,
      check: (_, frame) => {
        newestUs = frame.newest?.tUs ?? 0;
      },
    });
    expect(state.tUs).toBe(newestUs);
    expect(state.edgeUs).toBe(newestUs + MAX_EXTRAPOLATION_US);
  });

  test("snaps forward when the backlog exceeds 3 s", () => {
    const state = createClock(
      "live",
      input(0, { tUs: 10_000_000, receivedAtMs: 0 }),
    );
    // A hidden tab: the next read is 10 s of recording later.
    const jumped = { tUs: 20_000_000, receivedAtMs: 100 };
    const next = advanceClock(state, input(100, jumped));
    expect(next.edgeUs - state.tUs).toBeGreaterThan(SNAP_BACKLOG_US);
    expect(next.tUs).toBe(20_000_000 - PLAY_DELAY_US);
    expect(next.following).toBe(true);
  });

  test("below the snap it catches up smoothly instead", () => {
    const state = createClock(
      "live",
      input(0, { tUs: 10_000_000, receivedAtMs: 0 }),
    );
    const ahead = { tUs: 11_000_000, receivedAtMs: 100 };
    const next = advanceClock(state, input(100, ahead));
    const dtUs = FRAME_MS * 1000;
    expect(next.tUs).toBeGreaterThan(state.tUs + dtUs);
    expect(next.tUs).toBeLessThan(11_000_000 - PLAY_DELAY_US);
  });

  test("never shows time before the first loaded frame", () => {
    const newest = { tUs: 400_000, receivedAtMs: 0 };
    const state = createClock("live", input(0, newest, { startUs: 100_000 }));
    expect(state.tUs).toBe(100_000);
  });

  test("a seek stops following; playing on hands back at the target", () => {
    const newest = { tUs: 10_000_000, receivedAtMs: 0 };
    const state = createClock("live", input(0, newest));
    // Past the target is clamped to it.
    expect(seekClock(state, 99_000_000, input(0, newest)).tUs).toBe(
      10_000_000 - PLAY_DELAY_US,
    );
    let seeked = seekClock(state, 4_000_000, input(0, newest));
    expect(seeked).toMatchObject({ tUs: 4_000_000, following: false });

    // Paused: stays put while the edge moves on.
    seeked = setPlaying(seeked, false, input(0, newest));
    const later = { tUs: 12_000_000, receivedAtMs: 2000 };
    const held = advanceClock(seeked, input(2000, later));
    expect(held.tUs).toBe(4_000_000);
    expect(held.playing).toBe(false);

    // Playing: real time from the seek, then following at the target.
    let playing = setPlaying(held, true, input(2000, later));
    playing = advanceClock(playing, input(2016, later, { dtMs: 16 }));
    expect(playing.tUs).toBe(4_016_000);
    expect(playing.following).toBe(false);
    playing = advanceClock(playing, input(2016, later, { dtMs: 60_000 }));
    expect(playing.following).toBe(true);
    expect(playing.tUs).toBe(12_000_000 - PLAY_DELAY_US + 16_000);
  });

  test("follow live returns to the target", () => {
    const newest = { tUs: 10_000_000, receivedAtMs: 0 };
    const seeked = seekClock(
      createClock("live", input(0, newest)),
      1_000_000,
      input(0, newest),
    );
    expect(followLive(seeked, input(0, newest))).toMatchObject({
      tUs: 10_000_000 - PLAY_DELAY_US,
      following: true,
      playing: true,
    });
  });
});

describe("replay clock", () => {
  const replay = (nowMs: number, dtMs = FRAME_MS) =>
    input(nowMs, null, { startUs: 0, endUs: 2_000_000, dtMs });

  test("starts paused at the first frame", () => {
    expect(createClock("replay", replay(0))).toEqual({
      mode: "replay",
      tUs: 0,
      edgeUs: 2_000_000,
      following: false,
      playing: false,
      episodeId: EPISODE,
      held: false,
    });
  });

  test("plays to the end of the capture and stops there", () => {
    let state = setPlaying(createClock("replay", replay(0)), true, replay(0));
    state = advanceClock(state, replay(500, 500));
    expect(state.tUs).toBe(500_000);
    state = advanceClock(state, replay(5000, 4500));
    expect(state).toMatchObject({ tUs: 2_000_000, playing: false });
    // Playing again at the end starts over.
    expect(setPlaying(state, true, replay(5000)).tUs).toBe(0);
  });

  test("a seek stays within the capture", () => {
    const state = createClock("replay", replay(0));
    expect(seekClock(state, 9_000_000, replay(0)).tUs).toBe(2_000_000);
    expect(seekClock(state, -5, replay(0)).tUs).toBe(0);
  });

  test("a live episode that stops keeps its playhead as a replay", () => {
    const newest = { tUs: 10_000_000, receivedAtMs: 0 };
    const live = createClock("live", input(0, newest, { endUs: 10_000_000 }));
    const stopped = setClockMode(
      live,
      "replay",
      input(0, newest, { endUs: 10_000_000 }),
    );
    expect(stopped).toMatchObject({
      mode: "replay",
      tUs: live.tUs,
      edgeUs: 10_000_000,
      following: false,
      playing: true,
    });
    const resumed = setClockMode(
      stopped,
      "live",
      input(0, newest, { endUs: 10_000_000 }),
    );
    expect(resumed).toMatchObject({ mode: "live", following: true });
  });

  test("a clock made before the status is known follows a live episode", () => {
    // The source's state before the list or detail arrives.
    let state = createClock(clockModeFor(null), input(0, null));
    let newest: Newest = { tUs: 5_000_000, receivedAtMs: 0 };
    state = setClockMode(state, clockModeFor("live"), input(0, newest));
    expect(state).toMatchObject({ mode: "live", following: true });
    for (let nowMs = FRAME_MS; nowMs <= 5000; nowMs += FRAME_MS) {
      if (nowMs >= newest.receivedAtMs + 1000) {
        newest = { tUs: newest.tUs + 1_000_000, receivedAtMs: nowMs };
      }
      state = advanceClock(state, input(nowMs, newest));
    }
    expect(state).toMatchObject({ following: true, playing: true });
    expect(
      Math.abs(state.edgeUs - state.tUs - PLAY_DELAY_US),
    ).toBeLessThanOrEqual(300_000);
  });

  test("a replay played to its end follows when the episode grows again", () => {
    let state = setPlaying(createClock("replay", replay(0)), true, replay(0));
    state = advanceClock(state, replay(5000, 5000));
    expect(state).toMatchObject({ tUs: 2_000_000, playing: false });
    const grown = { tUs: 6_000_000, receivedAtMs: 5000 };
    state = setClockMode(state, "live", input(5000, grown));
    expect(state).toMatchObject({
      mode: "live",
      tUs: 6_000_000 - PLAY_DELAY_US,
      following: true,
      playing: true,
    });
  });

  test("a paused or seeked replay stays where the user left it", () => {
    const newest = { tUs: 10_000_000, receivedAtMs: 0 };
    const end = { endUs: 10_000_000 };
    const replayed = createClock("replay", input(0, newest, end));

    const paused = setPlaying(
      setPlaying(replayed, true, input(0, newest, end)),
      false,
      input(0, newest, end),
    );
    expect(setClockMode(paused, "live", input(0, newest))).toMatchObject({
      mode: "live",
      tUs: 0,
      following: false,
      playing: false,
    });

    // Seeked and playing: plays on, then hands over at the target.
    let seeked = setPlaying(
      seekClock(replayed, 3_000_000, input(0, newest, end)),
      true,
      input(0, newest, end),
    );
    seeked = setClockMode(seeked, "live", input(0, newest));
    expect(seeked).toMatchObject({
      mode: "live",
      tUs: 3_000_000,
      following: false,
      playing: true,
    });
    seeked = advanceClock(seeked, input(16, newest, { dtMs: 60_000 }));
    expect(seeked).toMatchObject({ following: true, held: false });
  });

  test("a new episode starts a new clock", () => {
    // /clio/live: episode A finished and was paused at its end, B is live.
    const a = { tUs: 10_000_000, receivedAtMs: 0 };
    let state = createClock("replay", input(0, a, { endUs: 10_000_000 }));
    state = seekClock(state, 10_000_000, input(0, a, { endUs: 10_000_000 }));
    state = setPlaying(state, false, input(0, a, { endUs: 10_000_000 }));
    expect(state.held).toBe(true);

    const b = { tUs: 4_000_000, receivedAtMs: 100 };
    const onB = (nowMs: number, newest: Newest) =>
      input(nowMs, newest, { episodeId: "ep-20261024-120100-bbbb" });
    expect(setClockMode(state, "live", onB(100, b))).toEqual(
      createClock("live", onB(100, b)),
    );
    // Also when the mode does not change: a finished A, then a finished B.
    const replayB = onB(100, null);
    expect(advanceClock(state, { ...replayB, endUs: 3_000_000 })).toEqual(
      createClock("replay", { ...replayB, endUs: 3_000_000 }),
    );
  });
});

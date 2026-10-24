import type { ClockMode, ClockState, EpisodeSourceState } from "./types";

// The playhead of the Clio episode viewer (docs/plans/visualizer.md 2.2,
// 2.5). Pure: every function takes the previous state and returns the next.
//
// Live, the edge is the newest received frame time, advanced by laptop time
// since that read, and the playhead follows it at PLAY_DELAY_US. Laptop time
// (performance.now() milliseconds) only paces the playhead: it is never
// written into a sample time, and every `…Us` value here is recording time.
// Replay, the edge is the end of the capture.

/** How far the playhead plays behind the live edge. */
export const PLAY_DELAY_US = 1_500_000;

/** A backlog beyond this (a stall, a hidden tab) snaps the playhead forward. */
export const SNAP_BACKLOG_US = 3_000_000;

/**
 * The longest the edge is advanced past the newest received frame. Equal to
 * the play delay, so the playhead never reaches time with no data behind it:
 * when uploads stall, it stops at the newest frame.
 */
export const MAX_EXTRAPOLATION_US = PLAY_DELAY_US;

/**
 * While following, the play rate is 1 plus the distance behind the target
 * over this, so a playhead that fell behind catches up smoothly. It never
 * plays past the target and never steps back: when the target moves back (a
 * read brought less than the edge assumed) or stops (uploads stalled), the
 * playhead holds until the target passes it again.
 */
const CATCH_UP_US = PLAY_DELAY_US;
const MAX_RATE = 1.5;

export type Newest = EpisodeSourceState["newest"];

/**
 * The clock: the published ClockState plus what the clock needs to remember.
 * Keep the whole object and pass it back to the next call.
 */
export interface Clock extends ClockState {
  /** The episode this clock plays (`snapshot.episodeId`). */
  episodeId: string | null;
  /**
   * The user left the edge (a seek or a pause): an episode that starts
   * growing again is not followed until they return to it.
   */
  held: boolean;
}

/** What the clock reads on every animation frame. */
export interface ClockInput {
  /** The episode shown (`snapshot.episodeId`): a different one starts a new clock. */
  episodeId: string | null;
  /** performance.now() of this frame, in ms. */
  nowMs: number;
  /** performance.now() since the previous frame, in ms. */
  dtMs: number;
  /** The newest received frame and when its read completed (source state). */
  newest: Newest;
  /** The earliest time that can be shown (the first loaded frame). */
  startUs: number;
  /** Replay: the end of the capture (`capture.endUs`). */
  endUs: number;
}

/** Live while the episode grows; a stopped or finished one is replayed. */
export function clockModeFor(status: EpisodeSourceState["status"]): ClockMode {
  return status === "live" ? "live" : "replay";
}

/**
 * The newest received frame time, advanced by laptop time since its read (at
 * most MAX_EXTRAPOLATION_US). 0 before any frame arrived.
 */
export function liveEdgeUs(newest: Newest, nowMs: number): number {
  if (!newest) return 0;
  const sinceUs = Math.max(0, nowMs - newest.receivedAtMs) * 1000;
  return newest.tUs + Math.round(Math.min(sinceUs, MAX_EXTRAPOLATION_US));
}

/** The edge for the clock's mode: live edge, or the end of the capture. */
export function edgeFor(mode: ClockMode, input: ClockInput): number {
  return mode === "live"
    ? Math.max(input.startUs, liveEdgeUs(input.newest, input.nowMs))
    : Math.max(input.startUs, input.endUs);
}

/** Where a following playhead aims: the edge less the play delay. */
const targetOf = (edgeUs: number, startUs: number) =>
  Math.max(startUs, edgeUs - PLAY_DELAY_US);

/**
 * A new clock. Live it starts following at the play delay; replay it starts
 * paused at `startUs`. Neither is held, so a replay clock made before the
 * episode's status is known follows once it turns out to be live.
 */
export function createClock(mode: ClockMode, input: ClockInput): Clock {
  const edgeUs = edgeFor(mode, input);
  const { episodeId } = input;
  return mode === "live"
    ? {
        mode,
        tUs: targetOf(edgeUs, input.startUs),
        edgeUs,
        following: true,
        playing: true,
        episodeId,
        held: false,
      }
    : {
        mode,
        tUs: input.startUs,
        edgeUs,
        following: false,
        playing: false,
        episodeId,
        held: false,
      };
}

/**
 * Moves the playhead by one animation frame. A different episode starts a new
 * clock in the same mode.
 */
export function advanceClock(state: Clock, input: ClockInput): Clock {
  if (input.episodeId !== state.episodeId) {
    return createClock(state.mode, input);
  }
  const edgeUs = edgeFor(state.mode, input);
  const dtUs = Math.max(0, input.dtMs) * 1000;
  let { tUs, following, playing, held } = state;

  if (state.mode === "live") {
    const targetUs = targetOf(edgeUs, input.startUs);
    if (following) {
      playing = true;
      if (edgeUs - tUs > SNAP_BACKLOG_US) tUs = targetUs;
      else if (tUs < targetUs) {
        const rate = Math.min(MAX_RATE, 1 + (targetUs - tUs) / CATCH_UP_US);
        tUs = Math.min(targetUs, tUs + dtUs * rate);
      }
    } else if (playing) {
      tUs += dtUs;
      // Playing on from a seek hands over to following at the target.
      if (tUs >= targetUs) {
        tUs = targetUs;
        following = true;
        held = false;
      }
    }
    tUs = Math.min(tUs, edgeUs);
  } else {
    if (playing) tUs += dtUs;
    if (tUs >= edgeUs) {
      tUs = edgeUs;
      playing = false;
    }
    following = false;
  }

  tUs = Math.round(Math.max(input.startUs, tUs));
  if (
    tUs === state.tUs &&
    edgeUs === state.edgeUs &&
    following === state.following &&
    playing === state.playing &&
    held === state.held
  ) {
    return state;
  }
  return { ...state, tUs, edgeUs, following, playing, held };
}

/**
 * Moves the playhead to `tUs` and stops following. Live it cannot go past the
 * play delay behind the edge; replay it stays within the capture.
 */
export function seekClock(state: Clock, tUs: number, input: ClockInput): Clock {
  const edgeUs = edgeFor(state.mode, input);
  const maxUs =
    state.mode === "live" ? targetOf(edgeUs, input.startUs) : edgeUs;
  const clamped = Math.round(Math.min(maxUs, Math.max(input.startUs, tUs)));
  return { ...state, tUs: clamped, edgeUs, following: false, held: true };
}

/** Plays or pauses. Pausing stops following; replay at the end restarts. */
export function setPlaying(
  state: Clock,
  playing: boolean,
  input: ClockInput,
): Clock {
  if (!playing) {
    return { ...state, playing: false, following: false, held: true };
  }
  const edgeUs = edgeFor(state.mode, input);
  const tUs =
    state.mode === "replay" && state.tUs >= edgeUs ? input.startUs : state.tUs;
  return { ...state, tUs, edgeUs, playing: true };
}

/** Back to following the live edge (live mode only). */
export function followLive(state: Clock, input: ClockInput): Clock {
  if (state.mode !== "live") return state;
  const edgeUs = edgeFor("live", input);
  return {
    ...state,
    tUs: targetOf(edgeUs, input.startUs),
    edgeUs,
    following: true,
    playing: true,
    held: false,
  };
}

/**
 * Switches mode, keeping the playhead: a live episode that stops or finishes
 * goes on playing to its end as a replay; one that starts growing again is
 * followed unless the user had left the edge, in which case it stays where
 * they left it (and, if playing, hands over to following at the target). A
 * different episode starts a new clock in the new mode.
 */
export function setClockMode(
  state: Clock,
  mode: ClockMode,
  input: ClockInput,
): Clock {
  if (input.episodeId !== state.episodeId) return createClock(mode, input);
  if (mode === state.mode) return state;
  if (mode === "live" && !state.held) {
    return followLive({ ...state, mode }, input);
  }
  const edgeUs = edgeFor(mode, input);
  const tUs = Math.round(Math.min(edgeUs, Math.max(input.startUs, state.tUs)));
  return { ...state, mode, tUs, edgeUs, following: false };
}

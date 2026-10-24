"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTimeControls } from "@/context/time-context";
import {
  advanceClock,
  type Clock,
  type ClockInput,
  clockModeFor,
  createClock,
  followLive,
  seekClock,
  setClockMode,
  setPlaying as setClockPlaying,
} from "@/lib/clio/live-clock";
import type { EpisodeSourceState } from "@/lib/clio/types";

// Drives the Clio viewer's one playhead (docs/plans/visualizer.md 2.2). Each
// animation frame advances the pure live clock from the source's snapshot and
// publishes it in integer microseconds: the panels read it as props and the 3D
// scene through useSceneClock (clio-scene.tsx). It also hands the time, duration
// and play state to the TimeProvider (seek(t, "video")). Laptop time only paces
// the playhead; it never becomes a sample time.

/**
 * The longest step one frame may take. A tab that was hidden resumes where it
 * was instead of jumping by the time it spent hidden; live following snaps to
 * the edge on its own.
 */
const MAX_FRAME_MS = 250;

/** The edge is handed to the TimeProvider in steps of this much. */
const DURATION_STEP_US = 100_000;

function inputOf(
  source: EpisodeSourceState,
  nowMs: number,
  dtMs: number,
): ClockInput {
  return {
    episodeId: source.episodeId,
    nowMs,
    dtMs,
    newest: source.newest,
    startUs: source.loaded?.fromUs ?? 0,
    endUs: source.capture?.endUs ?? 0,
  };
}

export interface ClioClock {
  /** The playhead: the time every layer, lane and the inspector reads. */
  clock: Clock;
  seek: (tUs: number) => void;
  setPlaying: (playing: boolean) => void;
  togglePlaying: () => void;
  /** Back to following the live edge (live episodes only). */
  goLive: () => void;
}

/**
 * The playhead for a source snapshot, advanced on every animation frame. Must
 * be called inside a TimeProvider. A new episode starts a new clock; a status
 * change switches between following (live) and replay. `initial` carries on a
 * clock from another viewer of the same episode (Pin).
 */
export function useClioClock(
  source: EpisodeSourceState,
  initial: Clock | null = null,
): ClioClock {
  const { seek, setDuration, setIsPlaying } = useTimeControls();
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const [clock, setClock] = useState<Clock>(() =>
    initial && initial.episodeId === source.episodeId
      ? initial
      : createClock(
          clockModeFor(source.status),
          inputOf(source, performance.now(), 0),
        ),
  );
  const clockRef = useRef(clock);

  const publish = useCallback(
    (next: Clock) => {
      const prev = clockRef.current;
      if (next === prev) return;
      clockRef.current = next;
      if (next.tUs !== prev.tUs || next.episodeId !== prev.episodeId) {
        seek(next.tUs / 1e6, "video");
      }
      setClock(next);
    },
    [seek],
  );

  useEffect(() => {
    seek(clockRef.current.tUs / 1e6, "video");
    let raf = 0;
    let last: number | null = null;
    const frame = (now: number) => {
      const dtMs = last === null ? 0 : Math.min(MAX_FRAME_MS, now - last);
      last = now;
      const s = sourceRef.current;
      const input = inputOf(s, now, dtMs);
      const moded = setClockMode(
        clockRef.current,
        clockModeFor(s.status),
        input,
      );
      publish(advanceClock(moded, input));
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [publish, seek]);

  const durationSteps = Math.ceil(clock.edgeUs / DURATION_STEP_US);
  useEffect(() => {
    setDuration((durationSteps * DURATION_STEP_US) / 1e6);
  }, [durationSteps, setDuration]);
  useEffect(() => {
    setIsPlaying(clock.playing);
  }, [clock.playing, setIsPlaying]);

  /** Applies a user action to the current clock, with the time of the action. */
  const act = useCallback(
    (change: (clock: Clock, input: ClockInput) => Clock) => {
      const input = inputOf(sourceRef.current, performance.now(), 0);
      publish(change(clockRef.current, input));
    },
    [publish],
  );

  return {
    clock,
    seek: useCallback(
      (tUs: number) => act((c, input) => seekClock(c, tUs, input)),
      [act],
    ),
    setPlaying: useCallback(
      (playing: boolean) =>
        act((c, input) => setClockPlaying(c, playing, input)),
      [act],
    ),
    togglePlaying: useCallback(
      () => act((c, input) => setClockPlaying(c, !c.playing, input)),
      [act],
    ),
    goLive: useCallback(() => act(followLive), [act]),
  };
}

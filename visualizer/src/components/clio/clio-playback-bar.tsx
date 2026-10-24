"use client";

import React from "react";
import { LuPause, LuPlay } from "react-icons/lu";
import { formatSeconds, formatTime, missingBatches } from "@/lib/clio/lanes";
import type { BatchIntegrity, EpisodeStatus } from "@/lib/clio/types";

// The Clio transport: play, seek, sub-second time and the episode's state
// (DESIGN.md, "Status and live"). While live and following, a Live pill; after
// a seek away from the edge, a Go live pill. Missing batches show only when
// some are missing. Lag figures are for Debug and show only when passed.

/** Reconnecting: the source is retrying after a failed read. */
export type PlaybackStatus = EpisodeStatus | "reconnecting";

/** The dev lag readout (Debug only). */
export interface ClioLag {
  /** The clock's edge minus the displayed time. */
  behindEdgeUs: number;
  /** Laptop now minus (meta.clock.startEpochMs + newest t); approximate. */
  arrivalAgeMs: number | null;
  duplicates: number;
  rejected: number;
}

export interface ClioPlaybackBarProps {
  tUs: number;
  /** The end of the seek range: the live edge while live, else the capture end. */
  endUs: number;
  playing: boolean;
  onPlayPause: () => void;
  onSeek: (tUs: number) => void;
  status: PlaybackStatus | null;
  /** Live only: tracking the edge. */
  following?: boolean;
  onGoLive?: () => void;
  batches?: BatchIntegrity | null;
  /** Pass only in Debug. */
  lag?: ClioLag | null;
  disabled?: boolean;
}

const PILL =
  "inline-flex h-5 shrink-0 items-center rounded-full px-2 text-xs font-medium";

function StatusPill({
  status,
  following,
  onGoLive,
  batches,
}: Pick<
  ClioPlaybackBarProps,
  "status" | "following" | "onGoLive" | "batches"
>) {
  if (status === "live" && following === false && onGoLive) {
    return (
      <button
        type="button"
        onClick={onGoLive}
        className={`${PILL} bg-fill-strong text-fg-soft transition-colors hover:text-fg`}
      >
        Go live
      </button>
    );
  }
  switch (status) {
    case "live":
      return <span className={`${PILL} bg-accent text-[#0F1117]`}>Live</span>;
    case "stopped":
    case "reconnecting":
      return (
        <span className={`${PILL} bg-fg-muted text-surface-0`}>
          {status === "stopped" ? "Stopped" : "Reconnecting"}
        </span>
      );
    case "finished": {
      const complete = batches?.sent != null && missingBatches(batches) === 0;
      return (
        <span
          className={`${PILL} bg-fill-strong text-fg-soft`}
          title={complete ? `All ${batches?.sent} batches received` : undefined}
        >
          Finished
        </span>
      );
    }
    default:
      return null;
  }
}

export default function ClioPlaybackBar({
  tUs,
  endUs,
  playing,
  onPlayPause,
  onSeek,
  status,
  following,
  onGoLive,
  batches = null,
  lag = null,
  disabled = false,
}: ClioPlaybackBarProps) {
  const end = Math.max(0, endUs);
  const now = Math.min(Math.max(0, tUs), end);
  const missing = missingBatches(batches);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="transport-controls flex-wrap sm:flex-nowrap">
        <button
          type="button"
          onClick={onPlayPause}
          disabled={disabled}
          aria-label={playing ? "Pause" : "Play"}
          title={playing ? "Pause (Space)" : "Play (Space)"}
          className="transport-play"
        >
          {playing ? (
            <LuPause size={17} fill="currentColor" aria-hidden="true" />
          ) : (
            <LuPlay size={17} fill="currentColor" aria-hidden="true" />
          )}
        </button>
        <input
          type="range"
          min={0}
          max={end}
          step={1000}
          value={now}
          onChange={(e) => onSeek(Number(e.target.value))}
          disabled={disabled}
          className="transport-scrubber order-last basis-full sm:order-none sm:basis-auto"
          aria-label="Seek"
          aria-valuetext={`${formatTime(now)} of ${formatTime(end)}`}
        />
        <span className="transport-time tabular">
          <strong>{formatTime(now)}</strong>
          <span>/</span>
          {formatTime(end)}
        </span>
        <StatusPill
          status={status}
          following={following}
          onGoLive={onGoLive}
          batches={batches}
        />
        {missing > 0 && (
          <span className="shrink-0 text-xs font-medium text-flag-fg tabular">
            {missing === 1 ? "1 batch missing" : `${missing} batches missing`}
          </span>
        )}
      </div>
      {lag && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-fg-muted">
          <span>Behind edge {formatSeconds(lag.behindEdgeUs)}</span>
          {lag.arrivalAgeMs !== null && (
            <span>
              Arrival age {formatSeconds(lag.arrivalAgeMs * 1000)} approximate
            </span>
          )}
          <span>Duplicates {lag.duplicates}</span>
          <span>Rejected {lag.rejected}</span>
        </div>
      )}
    </div>
  );
}

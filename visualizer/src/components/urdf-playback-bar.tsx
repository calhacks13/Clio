"use client";

import React from "react";
import { LuPlay, LuPause, LuSpline } from "react-icons/lu";

interface UrdfPlaybackBarProps {
  frame: number;
  totalFrames: number;
  fps: number;
  playing: boolean;
  onPlayPause: () => void;
  trailEnabled: boolean;
  onTrailToggle: () => void;
  onFrameChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  disabled?: boolean;
}

export default function UrdfPlaybackBar({
  frame,
  totalFrames,
  fps,
  playing,
  onPlayPause,
  trailEnabled,
  onTrailToggle,
  onFrameChange,
  disabled = false,
}: UrdfPlaybackBarProps) {
  const currentTime = totalFrames > 0 ? Math.round(frame / fps) : 0;
  const totalTime = Math.round(Math.max(totalFrames - 1, 0) / fps);

  return (
    <div
      className={`transport-controls ${disabled ? "opacity-50" : ""}`}
      aria-busy={disabled}
    >
      <button
        onClick={onPlayPause}
        disabled={disabled}
        aria-label={playing ? "Pause replay" : "Play replay"}
        title={playing ? "Pause (Space)" : "Play (Space)"}
        className="transport-play"
      >
        {playing ? (
          <LuPause size={17} fill="currentColor" aria-hidden="true" />
        ) : (
          <LuPlay size={17} fill="currentColor" aria-hidden="true" />
        )}
      </button>
      <button
        onClick={onTrailToggle}
        disabled={disabled}
        aria-pressed={trailEnabled}
        className={`btn ${trailEnabled ? "btn-active" : ""}`}
        title="Show hand motion trails"
      >
        <LuSpline size={15} aria-hidden="true" /> Trails
      </button>
      <input
        type="range"
        min={0}
        max={Math.max(totalFrames - 1, 0)}
        value={frame}
        onChange={onFrameChange}
        disabled={disabled}
        className="transport-scrubber"
        aria-label="Seek frame"
        aria-valuetext={`${currentTime} seconds, frame ${frame}`}
      />
      <span
        className="transport-time tabular"
        title={`Frame ${frame} of ${Math.max(totalFrames - 1, 0)}`}
      >
        <strong>{currentTime}</strong>
        <span>/</span>
        {totalTime} s
      </span>
    </div>
  );
}

"use client";

import { useEffect, useMemo } from "react";
import { useTime, useTimeControls } from "@/context/time-context";
import { createReplayTimeLink } from "@/lib/replay-comparison";

/** The robot's frame ticker owns playback; charts can seek that same clock. */
export function ReplayComparisonClock({
  frame,
  fps,
  totalFrames,
  playing,
  onSeek,
  onPlayingChange,
}: {
  frame: number;
  fps: number;
  totalFrames: number;
  playing: boolean;
  onSeek: (time: number) => void;
  onPlayingChange: (playing: boolean) => void;
}) {
  const { isPlaying } = useTime();
  const { seek, subscribe, setIsPlaying, setDuration } = useTimeControls();
  const link = useMemo(
    () => createReplayTimeLink((time) => seek(time, "video"), onSeek),
    [seek, onSeek],
  );

  useEffect(() => subscribe(link.receive), [subscribe, link]);
  useEffect(() => link.publish(frame / fps), [link, frame, fps]);
  useEffect(() => {
    setDuration(Math.max(totalFrames - 1, 0) / fps);
  }, [setDuration, totalFrames, fps]);
  useEffect(() => setIsPlaying(playing), [playing, setIsPlaying]);
  useEffect(() => onPlayingChange(isPlaying), [isPlaying, onPlayingChange]);
  return null;
}

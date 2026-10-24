"use client";

import { EpisodePrompt } from "@/components/episode-prompt";
import { SimpleVideosPlayer } from "@/components/simple-videos-player";
import { InspectionSection } from "@/components/inspection-section";
import type { VideoInfo } from "@/types/video.types";

export function EpisodeDataPanel({
  task,
  videosInfo,
  externalClock,
  onVideosReady,
}: {
  task?: string;
  videosInfo: VideoInfo[];
  externalClock?: boolean;
  onVideosReady?: () => void;
}) {
  return (
    <InspectionSection title="Data" className="episode-data-panel">
      <EpisodePrompt text={task} />
      {videosInfo.length > 0 ? (
        <div className="episode-data-cameras">
          <SimpleVideosPlayer
            videosInfo={videosInfo}
            externalClock={externalClock}
            onVideosReady={onVideosReady}
          />
        </div>
      ) : (
        <p className="text-xs text-fg-muted">
          No camera footage in this episode.
        </p>
      )}
    </InspectionSection>
  );
}

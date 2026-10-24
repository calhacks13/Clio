"use client";

import { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  getEpisodeDataSafe,
  type EpisodeData,
} from "@/app/[org]/[dataset]/[episode]/fetch-data";
import { useAnnotations } from "@/context/annotations-context";
import { InlineLoading } from "@/components/ui";
import { EpisodeDataPanel } from "@/components/episode-data-panel";
import { InspectionSection } from "@/components/inspection-section";

const DataRecharts = lazy(() => import("@/components/data-recharts"));

export function ReplayComparisonData({
  org,
  dataset,
  episodeId,
  initialData,
}: {
  org?: string;
  dataset?: string;
  episodeId: number;
  initialData: EpisodeData;
}) {
  const cache = useRef(new Map([[initialData.episodeId, initialData]]));
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{
    episodeId: number;
    data?: EpisodeData;
    error?: string;
  }>({ episodeId, data: cache.current.get(episodeId) });
  const { setEpisode } = useAnnotations();

  useEffect(() => {
    let active = true;
    const cached = cache.current.get(episodeId);
    setResult({ episodeId, data: cached });
    if (cached) return;
    if (!org || !dataset) {
      setResult({
        episodeId,
        error: "Camera and signal data are unavailable for this recording.",
      });
      return;
    }
    getEpisodeDataSafe(org, dataset, episodeId)
      .then(({ data, error }) => {
        if (!active) return;
        if (!data) {
          setResult({
            episodeId,
            error: error || "Could not load this episode’s data.",
          });
          return;
        }
        cache.current.set(episodeId, data);
        setResult({ episodeId, data });
      })
      .catch(() => {
        if (active)
          setResult({
            episodeId,
            error: "Could not load this episode’s data.",
          });
      });
    return () => {
      active = false;
    };
  }, [org, dataset, episodeId, attempt]);

  const data = result.episodeId === episodeId ? result.data : undefined;
  const error = result.episodeId === episodeId ? result.error : undefined;
  useEffect(() => {
    if (!data) return;
    setEpisode(
      data.episodeId,
      { repoId: data.datasetInfo.repoId },
      data.languageAtoms,
      data.frameTimestamps,
    );
  }, [data, setEpisode]);

  return (
    <section
      id="comparison-data"
      className="comparison-data"
      aria-label="Comparison data"
    >
      {data ? (
        <div className="comparison-data-content">
          <EpisodeDataPanel
            key={data.episodeId}
            task={data.task}
            videosInfo={data.videosInfo}
            externalClock
          />
          {data.chartDataGroups.length > 0 && (
            <InspectionSection title="Signals" className="comparison-signals">
              <Suspense fallback={<InlineLoading label="Loading signals…" />}>
                <DataRecharts data={data.chartDataGroups} />
              </Suspense>
            </InspectionSection>
          )}
        </div>
      ) : (
        <InspectionSection title="Data" className="episode-data-panel">
          {error ? (
            <div className="comparison-message" role="alert">
              <p>{error}</p>
              <button className="btn" onClick={() => setAttempt((n) => n + 1)}>
                Retry
              </button>
            </div>
          ) : (
            <InlineLoading label="Loading episode data…" />
          )}
        </InspectionSection>
      )}
    </section>
  );
}

"use client";

import { notFound } from "next/navigation";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import ClioPlaybackBar, {
  type PlaybackStatus,
} from "@/components/clio/clio-playback-bar";
import EventList from "@/components/clio/event-list";
import ObjectInspector from "@/components/clio/object-inspector";
import ObjectLanes from "@/components/clio/object-lanes";
import StepBanner from "@/components/clio/step-banner";
import { ThemeToggle } from "@/components/ui";
import { syntheticEpisode } from "@/lib/clio/__fixtures__/synthetic-episode";
import { buildLanes, recordsLocationFlags } from "@/lib/clio/lanes";
import type { BatchIntegrity } from "@/lib/clio/types";
import { buildCaptureFromClio } from "@clio-viewer/capture/from-clio";

// Dev harness for the Clio panels: the synthetic episode, built in memory
// without the server, in the lanes, inspector, event list, step banner and
// transport. Toggles cover the states DESIGN.md asks to check. Not served in
// production builds.

const LIVE_DELAY_US = 1_500_000;
const LONG_NAME = "plastic oral syringe with a long display name";

type Toggle =
  | "flags"
  | "joined"
  | "handsDropped"
  | "missing"
  | "longName"
  | "debug";

const TOGGLES: { key: Toggle; label: string }[] = [
  { key: "flags", label: "Location flags" },
  { key: "joined", label: "Joined late" },
  { key: "handsDropped", label: "Hands dropped" },
  { key: "missing", label: "Missing batches" },
  { key: "longName", label: "Long name" },
  { key: "debug", label: "Debug" },
];

const STATUSES: { key: PlaybackStatus; label: string }[] = [
  { key: "live", label: "Live" },
  { key: "stopped", label: "Stopped" },
  { key: "finished", label: "Finished" },
  { key: "reconnecting", label: "Reconnecting" },
];

export default function LanesHarnessPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <LanesHarness />;
}

function LanesHarness() {
  const [on, setOn] = useState<Record<Toggle, boolean>>({
    flags: false,
    joined: false,
    handsDropped: false,
    missing: false,
    longName: false,
    debug: false,
  });
  const [status, setStatus] = useState<PlaybackStatus>("finished");
  const live = status === "live";

  const { episode, capture } = useMemo(() => {
    const episode = syntheticEpisode({ recordedGrasps: on.flags });
    const capture = buildCaptureFromClio(episode);
    if (on.longName) {
      const syringe = capture.entities.get("syringe");
      if (syringe) syringe.name = LONG_NAME;
    }
    return { episode, capture };
  }, [on.flags, on.longName]);
  const endUs = capture.endUs;
  const flagsRecorded = recordsLocationFlags(episode.meta);

  // A simulated live edge: it advances with laptop time and wraps at the end.
  const [edgeUs, setEdgeUs] = useState(endUs);
  const [tUs, setTUs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [following, setFollowing] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>("syringe");
  const tUsRef = useRef(tUs);
  tUsRef.current = tUs;

  const edgeRef = useRef(edgeUs);
  edgeRef.current = edgeUs;

  useEffect(() => {
    if (!live && !playing) return;
    let raf = 0;
    let last: number | null = null;
    const step = (now: number) => {
      const dtUs = last === null ? 0 : (now - last) * 1000;
      last = now;
      if (live) {
        let edge = edgeRef.current + dtUs;
        if (edge > endUs) edge = LIVE_DELAY_US;
        edgeRef.current = edge;
        setEdgeUs(edge);
        if (following) setTUs(Math.max(0, edge - LIVE_DELAY_US));
      }
      if (playing && !(live && following)) {
        const limit = live ? edgeRef.current : endUs;
        setTUs((t) => Math.min(limit, t + dtUs));
        if (!live && tUsRef.current + dtUs >= endUs) setPlaying(false);
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [live, playing, following, endUs]);

  const seekEndUs = live ? edgeUs : endUs;
  const seek = useCallback(
    (t: number) => {
      setTUs(Math.min(Math.max(0, t), seekEndUs));
      if (live) setFollowing(false);
    },
    [live, seekEndUs],
  );

  // A live edge moves every frame; the axis grows in 100 ms steps, so the lanes
  // are rebuilt ten times a second rather than every frame.
  const axisEndUs = live ? Math.ceil(edgeUs / 100_000) * 100_000 : endUs;
  const model = useMemo(
    () =>
      buildLanes(capture, {
        endUs: axisEndUs,
        loaded: on.joined ? { fromUs: 2_000_000, toUs: endUs } : null,
        handsKeptFromUs: on.handsDropped ? 4_000_000 : null,
      }),
    [capture, axisEndUs, endUs, on.joined, on.handsDropped],
  );

  const sent = episode.finish.batches ?? null;
  const batches: BatchIntegrity = {
    received: on.missing ? (sent ?? 12) - 3 : (sent ?? 12),
    gaps: on.missing ? [3, 4, 7] : [],
    lastSeq: (sent ?? 12) - 1,
    sent: status === "finished" ? sent : null,
  };

  return (
    <main className="min-h-dvh bg-bg text-fg">
      <header className="flex flex-wrap items-center gap-x-6 gap-y-3 border-b border-line-subtle bg-surface-0 px-4 py-3 sm:px-6">
        <h1 className="text-base font-semibold">Lanes harness</h1>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Status">
          {STATUSES.map(({ key, label }) => (
            <button
              key={key}
              type="button"
              aria-pressed={status === key}
              onClick={() => {
                setStatus(key);
                setFollowing(true);
                setEdgeUs(key === "live" ? LIVE_DELAY_US : endUs);
              }}
              className={`btn min-h-8 py-1 ${status === key ? "btn-active" : ""}`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Cases">
          {TOGGLES.map(({ key, label }) => (
            <button
              key={key}
              type="button"
              aria-pressed={on[key]}
              onClick={() => setOn((o) => ({ ...o, [key]: !o[key] }))}
              className={`btn min-h-8 py-1 ${on[key] ? "btn-active" : ""}`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="ml-auto">
          <ThemeToggle />
        </div>
      </header>

      <div className="mx-auto flex max-w-[1400px] flex-col gap-4 p-4 sm:p-6">
        <div className="rounded-[18px] bg-surface-0 px-5 py-4">
          <StepBanner capture={capture} tUs={tUs} />
        </div>
        <div className="flex flex-col gap-4 lg:flex-row">
          <div className="min-w-0 flex-1 rounded-[18px] bg-surface-0 p-4 sm:p-5">
            <ObjectLanes
              model={model}
              tUs={tUs}
              liveEdgeUs={live ? edgeUs : null}
              flagsRecorded={flagsRecorded}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onSeek={seek}
            />
          </div>
          <aside className="flex w-full shrink-0 flex-col gap-4 lg:w-[300px]">
            <div className="rounded-[18px] bg-surface-0 p-4 sm:p-5">
              <ObjectInspector
                capture={capture}
                entityId={selectedId}
                tUs={tUs}
                flagsRecorded={flagsRecorded}
              />
            </div>
            <div className="flex max-h-[360px] min-h-0 flex-col rounded-[18px] bg-surface-0 p-2">
              <EventList
                capture={capture}
                revision={0}
                tUs={tUs}
                onSeek={seek}
              />
            </div>
          </aside>
        </div>
        <div className="replay-transport">
          <ClioPlaybackBar
            tUs={tUs}
            endUs={seekEndUs}
            playing={live && following ? true : playing}
            onPlayPause={() => {
              if (live && following) {
                setFollowing(false);
                setPlaying(false);
              } else {
                if (!live && tUs >= endUs) setTUs(0);
                setPlaying((p) => !p);
              }
            }}
            onSeek={seek}
            status={status}
            following={following}
            onGoLive={() => {
              setFollowing(true);
              setPlaying(false);
            }}
            batches={batches}
            lag={
              on.debug
                ? {
                    behindEdgeUs: Math.max(0, seekEndUs - tUs),
                    arrivalAgeMs: live ? 800 : null,
                    duplicates: 0,
                    rejected: 0,
                  }
                : null
            }
          />
        </div>
      </div>
    </main>
  );
}

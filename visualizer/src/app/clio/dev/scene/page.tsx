"use client";

import { notFound } from "next/navigation";
import React, { useEffect, useMemo, useRef, useState } from "react";
import ClioPlaybackBar from "@/components/clio/clio-playback-bar";
import ClioScene, { useSceneClock } from "@/components/clio/clio-scene";
import ObjectInspector from "@/components/clio/object-inspector";
import { ThemeToggle } from "@/components/ui";
import {
  SYNTHETIC_TIMES,
  syntheticEpisode,
} from "@/lib/clio/__fixtures__/synthetic-episode";
import { recordsLocationFlags } from "@/lib/clio/lanes";
import { buildCaptureFromClio } from "@clio-viewer/capture/from-clio";

// Dev harness for the Clio 3D scene: the synthetic episode, built in memory
// without the server, drawn by ClioScene at a time kept in state (useSceneClock),
// as the replay viewer does. Toggles cover the states DESIGN.md asks to check. Not
// served in production builds.

const HANDS_KEPT_FROM_US = 4_000_000;
// A replay stopped by the frames cap: no hands or head after this.
const FRAMES_LOADED_TO_US = 3_000_000;
// Mid-carry, after the hand dropout: held ring, trail and the indicator outline.
const START_US = Math.round((SYNTHETIC_TIMES.grasp + 1600) * 1000);

type Toggle = "flags" | "handsDropped" | "framesCut" | "debug";

const TOGGLES: { key: Toggle; label: string }[] = [
  { key: "flags", label: "Location flags" },
  { key: "handsDropped", label: "Hands dropped" },
  { key: "framesCut", label: "Frames cut" },
  { key: "debug", label: "Debug" },
];

export default function SceneHarnessPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <SceneHarness />;
}

function SceneHarness() {
  const [on, setOn] = useState<Record<Toggle, boolean>>({
    flags: false,
    handsDropped: false,
    framesCut: false,
    debug: false,
  });
  const { episode, capture } = useMemo(() => {
    const episode = syntheticEpisode({ recordedGrasps: on.flags });
    return { episode, capture: buildCaptureFromClio(episode) };
  }, [on.flags]);

  return (
    <main className="min-h-dvh bg-bg text-fg">
      <header className="flex flex-wrap items-center gap-x-6 gap-y-3 border-b border-line-subtle bg-surface-0 px-4 py-3 sm:px-6">
        <h1 className="text-base font-semibold">Scene harness</h1>
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
      <SceneStage
        capture={capture}
        flagsRecorded={recordsLocationFlags(episode.meta)}
        handsKeptFromUs={on.handsDropped ? HANDS_KEPT_FROM_US : null}
        framesLoadedToUs={on.framesCut ? FRAMES_LOADED_TO_US : null}
        debug={on.debug}
      />
    </main>
  );
}

function SceneStage({
  capture,
  flagsRecorded,
  handsKeptFromUs,
  framesLoadedToUs,
  debug,
}: {
  capture: ReturnType<typeof buildCaptureFromClio>;
  flagsRecorded: boolean;
  handsKeptFromUs: number | null;
  framesLoadedToUs: number | null;
  debug: boolean;
}) {
  const endUs = capture.endUs;
  const [tUs, setTUs] = useState(START_US);
  const clock = useSceneClock(tUs);
  const [playing, setPlaying] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>("syringe");
  const tUsRef = useRef(tUs);
  tUsRef.current = tUs;

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last: number | null = null;
    const step = (now: number) => {
      const dtUs = last === null ? 0 : Math.round((now - last) * 1000);
      last = now;
      const next = Math.min(endUs, tUsRef.current + dtUs);
      setTUs(next);
      if (next >= endUs) {
        setPlaying(false);
        return;
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, endUs]);

  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-4 p-4 sm:p-6">
      <div className="flex flex-col gap-4 lg:flex-row">
        <div className="replay-viewport h-[62vh] min-h-[320px] flex-none lg:flex-1">
          <ClioScene
            capture={capture}
            revision={0}
            clock={clock}
            handsKeptFromUs={handsKeptFromUs}
            framesLoadedToUs={framesLoadedToUs}
            debug={debug}
            selectedId={selectedId}
            onSelect={setSelectedId}
            className="absolute inset-0"
          />
        </div>
        <aside className="w-full shrink-0 rounded-[18px] bg-surface-0 p-4 sm:p-5 lg:w-[300px]">
          <ObjectInspector
            capture={capture}
            entityId={selectedId}
            tUs={tUs}
            flagsRecorded={flagsRecorded}
          />
        </aside>
      </div>
      <div className="replay-transport">
        <ClioPlaybackBar
          tUs={tUs}
          endUs={endUs}
          playing={playing}
          onPlayPause={() => {
            if (!playing && tUs >= endUs) setTUs(0);
            setPlaying((p) => !p);
          }}
          onSeek={(t) => setTUs(Math.min(Math.max(0, t), endUs))}
          status="finished"
        />
      </div>
    </div>
  );
}

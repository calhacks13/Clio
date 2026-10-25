"use client";

import { notFound } from "next/navigation";
import React, { useEffect, useMemo, useRef, useState } from "react";
import ClioPlaybackBar from "@/components/clio/clio-playback-bar";
import ClioScene, { useSceneClock } from "@/components/clio/clio-scene";
import ObjectInspector from "@/components/clio/object-inspector";
import { ThemeToggle } from "@/components/ui";
import { syntheticDerived } from "@/lib/clio/__fixtures__/synthetic-derived";
import {
  SYNTHETIC_TIMES,
  syntheticEpisode,
} from "@/lib/clio/__fixtures__/synthetic-episode";
import { type CompileStatusView, compileStatus } from "@/lib/clio/derived";
import { recordsLocationFlags } from "@/lib/clio/lanes";
import type {
  EnvironmentDoc,
  RetargetDoc,
  ShapesDoc,
  TracksDoc,
} from "@clio/protocol";
import { buildCaptureFromClio } from "@clio-viewer/capture/from-clio";

// Dev harness for the Clio 3D scene: the synthetic episode, built in memory
// without the server, drawn by ClioScene at a time kept in state (useSceneClock),
// as the replay viewer does. Toggles cover the states DESIGN.md asks to check,
// and the compiled documents (synthetic-derived.ts): the compiled object
// series with the syringe's extent box and fused shape, detected planes, the
// table on the detected table plane, the retargeted arm and the compile state
// (a failed retarget stage, a verdict that is not usable). Not served in
// production builds.

const HANDS_KEPT_FROM_US = 4_000_000;
// A replay stopped by the frames cap: no hands or head after this.
const FRAMES_LOADED_TO_US = 3_000_000;
// Mid-carry, after the hand dropout: held ring, trail and the indicator outline.
const START_US = Math.round((SYNTHETIC_TIMES.grasp + 1600) * 1000);

type Toggle =
  | "flags"
  | "handsDropped"
  | "framesCut"
  | "compiled"
  | "robot"
  | "compileFailed"
  | "notUsable"
  | "debug";

const TOGGLES: { key: Toggle; label: string }[] = [
  { key: "flags", label: "Location flags" },
  { key: "handsDropped", label: "Hands dropped" },
  { key: "framesCut", label: "Frames cut" },
  { key: "compiled", label: "Compiled" },
  { key: "robot", label: "Robot" },
  { key: "compileFailed", label: "Compile failed" },
  { key: "notUsable", label: "Not usable" },
  { key: "debug", label: "Debug" },
];

const NO_RETARGET: readonly RetargetDoc[] = [];

export default function SceneHarnessPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <SceneHarness />;
}

function SceneHarness() {
  const [on, setOn] = useState<Record<Toggle, boolean>>({
    flags: false,
    handsDropped: false,
    framesCut: false,
    compiled: true,
    robot: true,
    compileFailed: false,
    notUsable: false,
    debug: false,
  });
  const { episode, capture } = useMemo(() => {
    const episode = syntheticEpisode({ recordedGrasps: on.flags });
    return { episode, capture: buildCaptureFromClio(episode) };
  }, [on.flags]);
  const derived = useMemo(
    () =>
      syntheticDerived(episode, {
        ...(on.notUsable && {
          quality: {
            usable: false,
            reasons: ["Right hand tracked in 41% of frames"],
          },
        }),
        ...(on.compileFailed && { retargetFailed: "URDF not found" }),
      }),
    [episode, on.notUsable, on.compileFailed],
  );

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
        environment={on.compiled ? derived.environment : null}
        tracks={on.compiled ? derived.tracks : null}
        shapes={on.compiled ? derived.shapes : null}
        retarget={on.compiled ? derived.retarget : NO_RETARGET}
        showRobot={on.robot}
        compile={compileStatus(
          {
            compile: on.compiled ? "ok" : "none",
            compileError: null,
            manifest: on.compiled ? derived.manifest : null,
          },
          "finished",
        )}
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
  environment,
  tracks,
  shapes,
  retarget,
  showRobot,
  compile,
}: {
  capture: ReturnType<typeof buildCaptureFromClio>;
  flagsRecorded: boolean;
  handsKeptFromUs: number | null;
  framesLoadedToUs: number | null;
  debug: boolean;
  environment: EnvironmentDoc | null;
  tracks: TracksDoc | null;
  shapes: ShapesDoc | null;
  retarget: readonly RetargetDoc[];
  showRobot: boolean;
  compile: CompileStatusView | null;
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
            environment={environment}
            tracks={tracks}
            shapes={shapes}
            retarget={retarget}
            showRobot={showRobot}
            className="absolute inset-0"
          />
        </div>
        <aside className="w-full shrink-0 rounded-[18px] bg-surface-0 p-4 sm:p-5 lg:w-[300px]">
          <ObjectInspector
            capture={capture}
            entityId={selectedId}
            tUs={tUs}
            flagsRecorded={flagsRecorded}
            tracks={tracks}
            shapes={shapes}
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
          compile={compile}
        />
      </div>
    </div>
  );
}

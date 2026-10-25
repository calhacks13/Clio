"use client";

import type { EpisodeMeta } from "@clio/protocol";
import Link from "next/link";
import { useRouter } from "next/navigation";
import React, {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  LuBot,
  LuBug,
  LuFolderOpen,
  LuHouse,
  LuPin,
  LuShapes,
} from "react-icons/lu";
import { ClioBrand } from "@/components/clio-brand";
import { ThemeToggle } from "@/components/ui";
import { TimeProvider } from "@/context/time-context";
import { captureKey } from "@/lib/clio/capture-key";
import {
  compileStatus,
  type DerivedState,
  sceneStatus,
} from "@/lib/clio/derived";
import { buildLanes, recordsLocationFlags } from "@/lib/clio/lanes";
import type { Clock } from "@/lib/clio/live-clock";
import { modelFiles, roomFile, sceneFileUrl } from "@/lib/clio/scene-files";
import { ClioSource } from "@/lib/clio/source";
import type { EpisodeSourceState, FollowMode } from "@/lib/clio/types";
import { useClioClock } from "./clio-clock";
import ClioPlaybackBar, {
  type ClioLag,
  type PlaybackStatus,
} from "./clio-playback-bar";
import ClioScene, { useSceneClock } from "./clio-scene";
import EventList from "./event-list";
import ObjectInspector from "./object-inspector";
import ObjectLanes from "./object-lanes";
import StepBanner from "./step-banner";
import { useClioDerived } from "./use-clio-derived";

// The Clio episode viewer behind /clio/live and /clio/<id>
// (docs/plans/visualizer.md 2.1, 2.2): one ClioSource polls the Clio server
// through the /api/clio proxy, one clock (clio-clock) chooses the viewed time,
// and the scene, lanes, inspector, event list and transport all read it. Live
// follows the newest episode and keeps the address; Pin stays on the episode
// shown and moves to its /clio/<id> page. Laid out like the G1 replay: an
// unframed canvas between two rounded toolbar surfaces, with docked panels.
// The compiled documents (object series and shapes, planes, retargeted
// robots, the compile state) and the rebuilt scene's SceneDoc come from their
// own loader beside the source (use-clio-derived), so raw following never
// waits on them. The Room and Models toggles show the Quest room scan and the
// generated object models; their files are read only while shown.

/** The lanes' axis grows in these steps while live, so they rebuild at most ten times a second. */
const AXIS_STEP_US = 100_000;

/** The title of a recording made without a procedure. */
const MODE_TITLE: Record<EpisodeMeta["mode"], string> = {
  learn: "Lesson",
  record_demo: "Demonstration",
  free: "Free recording",
};

const startFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** Skips the Space shortcut while typing or on a focused control, as the G1 viewer does. */
function isKeyboardFocusInsideTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return (
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    tag === "INPUT" ||
    tag === "BUTTON" ||
    (tag === "A" && target.hasAttribute("href"))
  );
}

/** The scene re-renders only when what it draws changes, not on every playhead frame. */
const Scene = memo(ClioScene);

/**
 * What Pin hands from the /clio/live viewer to the /clio/<id> viewer that
 * replaces it: the source, already pinned, and the playhead. Read, not taken,
 * on mount (React may run the state initializer twice) and cleared once a
 * viewer has adopted it.
 */
let pinHandoff: { id: string; source: ClioSource; clock: Clock | null } | null =
  null;

function sourceFor(follow: FollowMode, episodeId: string | null) {
  if (follow === "pinned" && pinHandoff && pinHandoff.id === episodeId) {
    return { source: pinHandoff.source, clock: pinHandoff.clock };
  }
  return { source: new ClioSource({ follow, episodeId }), clock: null };
}

export interface ClioReplayViewerProps {
  follow: FollowMode;
  /** The pinned episode (follow "pinned"). */
  episodeId?: string | null;
}

export default function ClioReplayViewer({
  follow,
  episodeId = null,
}: ClioReplayViewerProps) {
  const router = useRouter();
  const [{ source, clock: initialClock }] = useState(() =>
    sourceFor(follow, episodeId),
  );
  useEffect(() => {
    if (pinHandoff?.source === source) pinHandoff = null;
    source.start();
    return () => source.stop();
  }, [source]);
  /** The playhead as last drawn, for Pin to hand over. */
  const clockRef = useRef<Clock | null>(null);
  const snapshot = useSyncExternalStore(
    source.subscribe,
    source.getSnapshot,
    source.getSnapshot,
  );
  const derived = useClioDerived(snapshot.episodeId);
  const [showRobot, setShowRobot] = useState(true);
  const [showRoom, setShowRoom] = useState(true);
  const [showModels, setShowModels] = useState(true);
  const hasRoom = Boolean(derived.environment?.room);
  const hasModels =
    derived.scene?.objects.some((model) => model.model !== null) ?? false;

  // A pinned episode the server does not have: back to the list.
  const gone =
    snapshot.follow === "pinned" &&
    snapshot.error?.status === 404 &&
    snapshot.error.retryAtMs === null;
  useEffect(() => {
    if (gone) router.replace("/clio");
  }, [gone, router]);

  const [debug, setDebug] = useState(
    () => new URLSearchParams(window.location.search).get("debug") === "1",
  );
  const toggleDebug = () => {
    const next = !debug;
    setDebug(next);
    const params = new URLSearchParams(window.location.search);
    if (next) params.set("debug", "1");
    else params.delete("debug");
    const query = params.toString();
    // A null state lets Next's router take the new address (it keeps its own
    // tree), so a later refresh or reload keeps the choice.
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${query ? `?${query}` : ""}`,
    );
  };

  // Pin moves to /clio/<id> (plan 2.1); the viewer there carries on with this
  // source and playhead, so nothing reloads.
  const pin = () => {
    const id = source.pin();
    if (!id) return;
    pinHandoff = { id, source, clock: clockRef.current };
    router.replace(`/clio/${encodeURIComponent(id)}${window.location.search}`);
  };

  const meta = snapshot.meta;

  return (
    <div className="visualizer-shell is-replay">
      <header className="workspace-header workspace-header-compact">
        <Link href="/clio" className="brand-link" aria-label="Recordings">
          <ClioBrand />
        </Link>
        <div className="flex min-w-0 flex-1 items-baseline gap-3">
          {meta ? (
            <>
              <h1 className="min-w-0 truncate text-sm font-semibold !whitespace-nowrap">
                {meta.procedure?.title ?? MODE_TITLE[meta.mode]}
              </h1>
              <span className="shrink-0 text-xs text-fg-muted tabular">
                {startFormat.format(Date.parse(meta.createdAt))}
              </span>
            </>
          ) : (
            <h1 className="sr-only">Clio recording</h1>
          )}
          {debug && snapshot.episodeId && (
            <span className="hidden truncate font-mono text-[11px] text-fg-muted sm:inline">
              {snapshot.episodeId}
            </span>
          )}
        </div>
        <div className="replay-toolbar-slot">
          <div className="replay-tools" aria-label="Replay tools">
            {snapshot.follow === "live" && snapshot.episodeId && (
              <button
                type="button"
                onClick={pin}
                className="btn"
                title="Stay on this recording"
                aria-label="Pin"
              >
                <LuPin size={16} aria-hidden="true" />{" "}
                <span className="tool-label">Pin</span>
              </button>
            )}
            {hasRoom && (
              <button
                type="button"
                aria-pressed={showRoom}
                title="Show the Quest room scan, from Space Setup before the recording"
                aria-label="Room"
                onClick={() => setShowRoom((on) => !on)}
                className={`btn ${showRoom ? "btn-active" : ""}`}
              >
                <LuHouse size={16} aria-hidden="true" />{" "}
                <span className="tool-label">Room</span>
              </button>
            )}
            {hasModels && (
              <button
                type="button"
                aria-pressed={showModels}
                title="Show the generated object models"
                aria-label="Models"
                onClick={() => setShowModels((on) => !on)}
                className={`btn ${showModels ? "btn-active" : ""}`}
              >
                <LuShapes size={16} aria-hidden="true" />{" "}
                <span className="tool-label">Models</span>
              </button>
            )}
            {(derived.retarget.length > 0 || derived.body !== null) && (
              <button
                type="button"
                aria-pressed={showRobot}
                title="Show the retargeted robot"
                aria-label="Robot"
                onClick={() => setShowRobot((on) => !on)}
                className={`btn ${showRobot ? "btn-active" : ""}`}
              >
                <LuBot size={16} aria-hidden="true" />{" "}
                <span className="tool-label">Robot</span>
              </button>
            )}
            <button
              type="button"
              aria-pressed={debug}
              title="Show origin labels, ids and lag"
              aria-label="Debug"
              onClick={toggleDebug}
              className={`btn ${debug ? "btn-active" : ""}`}
            >
              <LuBug size={16} aria-hidden="true" />{" "}
              <span className="tool-label">Debug</span>
            </button>
          </div>
        </div>
        <div className="header-actions">
          <ThemeToggle />
          <Link
            href="/clio"
            className="btn dataset-link"
            aria-label="Recordings"
            title="All recordings"
          >
            <LuFolderOpen size={16} aria-hidden="true" />
            <span className="dataset-label">Recordings</span>
          </Link>
        </div>
      </header>

      <TimeProvider duration={0}>
        {/* Mounted once per capture (capture-key.ts): a new episode, or a
            rebuild of this one, unmounts everything that drew the old capture.
            The playhead carries over when the episode stays the same. */}
        <ClioWorkspace
          key={snapshot.capture ? captureKey(snapshot.capture) : "none"}
          snapshot={snapshot}
          initialClock={clockRef.current ?? initialClock}
          clockRef={clockRef}
          debug={debug}
          derived={derived}
          showRobot={showRobot}
          showRoom={showRoom}
          showModels={showModels}
          onRetry={() => {
            source.stop();
            source.start();
          }}
        />
      </TimeProvider>
    </div>
  );
}

function ClioWorkspace({
  snapshot,
  initialClock,
  clockRef,
  debug,
  derived,
  showRobot,
  showRoom,
  showModels,
  onRetry,
}: {
  snapshot: EpisodeSourceState;
  initialClock: Clock | null;
  clockRef: React.RefObject<Clock | null>;
  debug: boolean;
  derived: DerivedState;
  showRobot: boolean;
  showRoom: boolean;
  showModels: boolean;
  onRetry: () => void;
}) {
  const { clock, seek, togglePlaying, goLive } = useClioClock(
    snapshot,
    initialClock,
  );
  useEffect(() => {
    clockRef.current = clock;
  }, [clock, clockRef]);
  const sceneClock = useSceneClock(clock.tUs);
  const { capture, revision, loaded, truncated, handsKeptFromUs, error } =
    snapshot;

  // The selection belongs to one episode; a new one starts with none.
  const [selection, setSelection] = useState<{
    episodeId: string | null;
    entityId: string;
  } | null>(null);
  const selectedId =
    selection && selection.episodeId === snapshot.episodeId
      ? selection.entityId
      : null;
  const episodeId = snapshot.episodeId;
  const select = useCallback(
    (entityId: string) => setSelection({ episodeId, entityId }),
    [episodeId],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space" || isKeyboardFocusInsideTextEntry(e.target)) {
        return;
      }
      e.preventDefault();
      togglePlaying();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlaying]);

  const live = clock.mode === "live";
  const axisEndUs = live
    ? Math.ceil(clock.edgeUs / AXIS_STEP_US) * AXIS_STEP_US
    : (capture?.endUs ?? 0);
  const loadedFromUs = loaded?.fromUs ?? null;
  const loadedToUs = loaded?.toUs ?? null;
  const model = useMemo(
    () =>
      capture
        ? buildLanes(capture, {
            endUs: axisEndUs,
            loaded:
              loadedFromUs !== null && loadedToUs !== null
                ? { fromUs: loadedFromUs, toUs: loadedToUs }
                : null,
            truncated,
            handsKeptFromUs,
          })
        : null,
    // revision marks new records in the same capture
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      capture,
      revision,
      axisEndUs,
      loadedFromUs,
      loadedToUs,
      truncated,
      handsKeptFromUs,
    ],
  );
  const flagsRecorded = recordsLocationFlags(snapshot.meta);
  const framesLoadedToUs = truncated ? loadedToUs : null;

  const reconnecting =
    error !== null && error.retryAtMs !== null && capture !== null;
  const status: PlaybackStatus | null = reconnecting
    ? "reconnecting"
    : snapshot.status;

  // On the raw episode's own status, not the Reconnecting overlay: a live
  // episode that briefly fails to read is still not compiled.
  const compile = compileStatus(derived, snapshot.status);
  const scene = sceneStatus(derived, snapshot.status);

  // The files the scene reads, only while their toggle is on.
  const { environment, compiledAt } = derived;
  const room = useMemo(
    () => roomFile({ episodeId, environment, compiledAt }, showRoom),
    [episodeId, environment, compiledAt, showRoom],
  );
  const sceneDoc = derived.scene;
  const models = useMemo(
    () => modelFiles({ episodeId, scene: sceneDoc }, showModels),
    [episodeId, sceneDoc, showModels],
  );
  const selectedModel =
    sceneDoc?.objects.find((model) => model.id === selectedId) ?? null;
  const cropUrl = useCallback(
    (name: string) => sceneFileUrl(episodeId, name),
    [episodeId],
  );

  const newest = snapshot.newest;
  const lag: ClioLag | null =
    debug && newest
      ? {
          // The clock's edge, not the newest frame: the edge advances
          // between reads, so this holds at the play delay while following.
          behindEdgeUs: Math.max(0, clock.edgeUs - clock.tUs),
          // Laptop wall time when the newest frame arrived, minus the
          // headset's wall time for it: approximate, the clocks can differ.
          arrivalAgeMs:
            snapshot.status === "live" && snapshot.meta
              ? Math.round(
                  performance.timeOrigin +
                    newest.receivedAtMs -
                    (snapshot.meta.clock.startEpochMs + newest.tUs / 1000),
                )
              : null,
          duplicates: snapshot.counts.duplicates,
          rejected: snapshot.counts.rejected,
        }
      : null;

  return (
    <>
      <main className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:overflow-hidden">
        <div className="contents lg:flex lg:min-h-0 lg:flex-1 lg:flex-row">
          <div className="relative flex h-[56vh] min-h-[280px] flex-none lg:h-auto lg:min-h-0 lg:flex-1">
            <div className="replay-viewport">
              {capture ? (
                <>
                  <Scene
                    capture={capture}
                    revision={revision}
                    clock={sceneClock}
                    handsKeptFromUs={handsKeptFromUs}
                    framesLoadedToUs={framesLoadedToUs}
                    debug={debug}
                    selectedId={selectedId}
                    onSelect={select}
                    environment={derived.environment}
                    tracks={derived.tracks}
                    shapes={derived.shapes}
                    retarget={derived.retarget}
                    body={derived.body}
                    showRobot={showRobot}
                    room={room}
                    models={models}
                    className="absolute inset-0"
                  />
                  <StepBanner
                    capture={capture}
                    tUs={clock.tUs}
                    className="pointer-events-none absolute left-5 right-5 top-4 z-[1] max-w-[560px]"
                  />
                  <p className="viewport-hint">
                    Drag to orbit{" "}
                    <span className="mx-2" aria-hidden="true">
                      /
                    </span>{" "}
                    Scroll to zoom
                  </p>
                </>
              ) : (
                <ViewportMessage
                  snapshot={snapshot}
                  onRetry={onRetry}
                  debug={debug}
                />
              )}
            </div>
          </div>
          {capture && (
            <aside
              aria-label="Selected object and events"
              className="order-last flex min-h-0 flex-none flex-col gap-4 border-t border-line-subtle bg-surface-1 p-5 lg:order-none lg:w-80 lg:shrink-0 lg:border-l lg:border-t-0"
            >
              <ObjectInspector
                capture={capture}
                revision={revision}
                entityId={selectedId}
                tUs={clock.tUs}
                flagsRecorded={flagsRecorded}
                tracks={derived.tracks}
                shapes={derived.shapes}
                model={selectedModel}
                sceneFileUrl={cropUrl}
              />
              <div className="flex max-h-[320px] min-h-0 flex-col border-t border-line-subtle pt-4 lg:max-h-none lg:flex-1">
                <EventList
                  capture={capture}
                  revision={revision}
                  tUs={clock.tUs}
                  onSeek={seek}
                />
              </div>
            </aside>
          )}
        </div>
        {capture && model && (
          <section
            aria-label="Objects over time"
            className="flex-none border-t border-line-subtle bg-surface-1 px-5 py-4 lg:max-h-[32vh] lg:overflow-y-auto"
          >
            <ObjectLanes
              model={model}
              tUs={clock.tUs}
              liveEdgeUs={live ? clock.edgeUs : null}
              flagsRecorded={flagsRecorded}
              selectedId={selectedId}
              onSelect={select}
              onSeek={seek}
            />
          </section>
        )}
      </main>
      <div className="replay-transport shrink-0">
        <ClioPlaybackBar
          tUs={clock.tUs}
          endUs={clock.edgeUs}
          playing={clock.playing}
          onPlayPause={togglePlaying}
          onSeek={seek}
          status={status}
          following={clock.following}
          onGoLive={goLive}
          batches={snapshot.batches}
          lag={lag}
          compile={compile}
          scene={scene}
          disabled={!capture}
        />
      </div>
    </>
  );
}

/** What the viewport shows before an episode is loaded. */
function ViewportMessage({
  snapshot,
  onRetry,
  debug,
}: {
  snapshot: EpisodeSourceState;
  onRetry: () => void;
  debug: boolean;
}) {
  const { error } = snapshot;
  const unreachable =
    error !== null && (error.status === null || error.status >= 500);
  return (
    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-surface-2 px-6 text-center">
      {error ? (
        <>
          <p className="text-sm text-fg-muted" role="alert">
            {unreachable
              ? "Can't reach the Clio server"
              : "Couldn't read this recording"}
          </p>
          {debug && (
            <p className="max-w-xl break-words font-mono text-[11px] text-fg-muted">
              {error.message}
            </p>
          )}
          <button type="button" className="btn" onClick={onRetry}>
            Retry
          </button>
        </>
      ) : (
        <p className="text-sm text-fg-muted" role="status">
          {snapshot.follow === "live" && !snapshot.episodeId
            ? "Waiting for a recording"
            : "Loading recording…"}
        </p>
      )}
    </div>
  );
}

"use client";

import { useState, useEffect, useRef, lazy, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { postParentMessageWithParams } from "@/utils/postParentMessage";
import { SimpleVideosPlayer } from "@/components/simple-videos-player";
import PlaybackBar from "@/components/playback-bar";
import { TimeProvider, useTime, useTimeControls } from "@/context/time-context";
import { FlaggedEpisodesProvider } from "@/context/flagged-episodes-context";
import Sidebar from "@/components/side-nav";
import {
  AnnotationsProvider,
  useAnnotations,
} from "@/context/annotations-context";
import Loading from "@/components/loading-component";
import { ThemeToggle } from "@/components/ui";
import Link from "next/link";
import {
  LuBox,
  LuChartNoAxesCombined,
  LuFolderOpen,
  LuChevronDown,
} from "react-icons/lu";
import { ClioBrand } from "@/components/clio-brand";
import { hasURDFSupport, isG1Robot } from "@/lib/so101-robot";
import { getEpisodeDataSafe, type EpisodeData } from "./fetch-data";
import { getDatasetVersionAndInfo } from "@/utils/versionUtils";

const URDFViewer = lazy(() => import("@/components/urdf-viewer"));
// Recharts is ~150KB gz and not above-the-fold (videos render first on the
// Episodes tab). Lazy-load it so the initial chunk can ship faster and
// videos start downloading in parallel with the chart bundle.
const DataRecharts = lazy(() => import("@/components/data-recharts"));

/** Skip global playback / navigation shortcuts while typing in a field. */
function isKeyboardFocusInsideTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target.closest('[contenteditable="true"]')) {
    return true;
  }
  const tag = target.tagName;
  return (
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    tag === "INPUT" ||
    tag === "BUTTON" ||
    (tag === "A" && target.hasAttribute("href"))
  );
}

const TABS = ["urdf", "episodes"] as const;
type ActiveTab = (typeof TABS)[number];

// Subscribes to `currentTime` so its parent doesn't have to. Keeping this
// in a leaf component means the throttled time ticks (~12.5/s during
// playback) only re-render this no-op sub-tree, not the entire 700-line
// EpisodeViewerInner. Vercel rule: rerender-defer-reads.
function UrlTimeSync() {
  const { currentTime, isPlaying } = useTime();
  const lastUrlSecondRef = useRef<number>(-1);

  // Only update the URL ?t= param when the integer second changes, and
  // only while paused — replacing state every frame during playback would
  // spam the browser's history.
  useEffect(() => {
    if (isPlaying) return;
    const currentSec = Math.floor(currentTime);
    if (currentTime > 0 && lastUrlSecondRef.current !== currentSec) {
      lastUrlSecondRef.current = currentSec;
      const newParams = new URLSearchParams(window.location.search);
      newParams.set("t", currentSec.toString());
      window.history.replaceState(
        {},
        "",
        `${window.location.pathname}?${newParams.toString()}`,
      );
      postParentMessageWithParams((params: URLSearchParams) => {
        params.set("path", window.location.pathname + window.location.search);
      });
    }
  }, [isPlaying, currentTime]);

  return null;
}

function TabButton({
  active,
  onClick,
  label,
  title,
  onPointerEnter,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  title?: string;
  onPointerEnter?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      onPointerEnter={onPointerEnter}
      title={title}
      aria-pressed={active}
      className={`view-tab ${active ? "is-active" : ""}`}
    >
      {label === "Replay" ? (
        <LuBox size={16} aria-hidden="true" />
      ) : (
        <LuChartNoAxesCombined size={16} aria-hidden="true" />
      )}
      {label}
    </button>
  );
}

export default function EpisodeViewer({
  org,
  dataset,
  episodeId,
}: {
  org: string;
  dataset: string;
  episodeId: number;
}) {
  const [data, setData] = useState<EpisodeData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [noEpisodes, setNoEpisodes] = useState(false);
  const requestIdRef = useRef(0);

  // Opening straight onto 3D Replay: start the robot meshes downloading now,
  // alongside the episode data, rather than once it has loaded and the viewer
  // mounts. info.json is all it needs, and the episode load fetches it anyway.
  useEffect(() => {
    getDatasetVersionAndInfo(`${org}/${dataset}`)
      .then(({ info }) => {
        if (
          hasURDFSupport(info.robot_type ?? null) &&
          info.codebase_version >= "v3.0" &&
          (sessionStorage.getItem("activeTab") === "urdf" ||
            isG1Robot(info.robot_type ?? null))
        ) {
          return import("@/components/urdf-viewer").then((m) =>
            m.prefetchRobotModel(info.robot_type ?? null),
          );
        }
      })
      .catch(() => {});
  }, [org, dataset]);

  useEffect(() => {
    if (Number.isNaN(episodeId)) {
      setError("Invalid episode id.");
      setData(null);
      return;
    }
    const requestId = ++requestIdRef.current;
    setError(null);
    setNoEpisodes(false);
    setData(null);
    getEpisodeDataSafe(org, dataset, episodeId)
      .then(({ data: loaded, error: loadError, noEpisodes: empty }) => {
        if (requestIdRef.current !== requestId) return;
        if (empty) {
          setNoEpisodes(true);
          return;
        }
        if (loadError) {
          setError(loadError);
          setData(null);
          return;
        }
        setData(loaded ?? null);
      })
      .catch((err) => {
        if (requestIdRef.current !== requestId) return;
        const message = err instanceof Error ? err.message : String(err);
        setError(message || "Unknown error");
        setData(null);
      });
  }, [org, dataset, episodeId]);

  if (noEpisodes) {
    return (
      <div className="flex h-screen items-center justify-center bg-[var(--bg)]">
        <div className="panel-raised max-w-xl p-6">
          <h2 className="text-xl font-medium text-fg mb-2">No episodes yet</h2>
          <p className="text-sm text-fg-muted">
            <a
              href={`https://huggingface.co/datasets/${org}/${dataset}`}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-fg hover:text-accent-fg transition-colors"
            >
              {org}/{dataset}
            </a>{" "}
            has a <code className="font-mono">meta/info.json</code> but no
            recorded episodes, so there is nothing to play.
          </p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-screen items-center justify-center bg-[var(--bg)] text-red-600 dark:text-red-300">
        <div className="panel-raised max-w-xl p-6 border-red-500/40">
          <h2 className="text-xl font-medium mb-3">Something went wrong</h2>
          <p className="text-sm whitespace-pre-wrap text-fg-muted">{error}</p>
          <div className="mt-5 flex gap-3">
            <button
              className="btn btn-primary"
              onClick={() => window.location.reload()}
            >
              Try again
            </button>
            <Link href="/?browse=1" className="btn">
              Choose dataset
            </Link>
          </div>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="relative h-screen bg-[var(--bg)]">
        <Loading />
      </div>
    );
  }

  return (
    <TimeProvider duration={data!.duration}>
      <FlaggedEpisodesProvider>
        <AnnotationsProvider>
          <EpisodeBootstrap data={data!} />
          <EpisodeViewerInner data={data!} org={org} dataset={dataset} />
        </AnnotationsProvider>
      </FlaggedEpisodesProvider>
    </TimeProvider>
  );
}

/** Wires the loaded episode into the AnnotationsProvider. */
function EpisodeBootstrap({ data }: { data: EpisodeData }) {
  const { setEpisode } = useAnnotations();
  useEffect(() => {
    setEpisode(
      data.episodeId,
      { repoId: data.datasetInfo.repoId },
      data.languageAtoms,
      data.frameTimestamps,
    );
  }, [
    data.episodeId,
    data.datasetInfo.repoId,
    data.languageAtoms,
    data.frameTimestamps,
    setEpisode,
  ]);
  return null;
}

function EpisodeViewerInner({
  data,
  org,
  dataset,
}: {
  data: EpisodeData;
  org?: string;
  dataset?: string;
}) {
  const {
    datasetInfo,
    episodeId,
    videosInfo,
    chartDataGroups,
    episodes,
    task,
  } = data;

  const [videosReady, setVideosReady] = useState(!videosInfo.length);
  const [chartsReady, setChartsReady] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [replayToolbarTarget, setReplayToolbarTarget] =
    useState<HTMLDivElement | null>(null);

  const loadStartRef = useRef(performance.now());

  const router = useRouter();

  const urdfSupported =
    hasURDFSupport(datasetInfo.robot_type) &&
    datasetInfo.codebase_version >= "v3.0";

  // Tab state & lazy stats — read sessionStorage in the initializer so the
  // correct tab renders on the very first frame (no post-mount flash).
  // Safe because EpisodeViewerInner only mounts client-side (behind a loading gate).
  const searchParams = useSearchParams();
  const [activeTab, setActiveTab] = useState<ActiveTab>(() => {
    const requested = searchParams.get("view");
    if (
      TABS.includes(requested as ActiveTab) &&
      (requested !== "urdf" || urdfSupported)
    )
      return requested as ActiveTab;
    if (typeof window !== "undefined") {
      const stored = sessionStorage.getItem("activeTab");
      /// A tab saved on another dataset may not exist here (3D Replay needs a supported robot).
      if (
        TABS.includes(stored as ActiveTab) &&
        (stored !== "urdf" || urdfSupported)
      ) {
        return stored as ActiveTab;
      }
    }
    return urdfSupported && isG1Robot(datasetInfo.robot_type)
      ? "urdf"
      : "episodes";
  });
  const isLoading = activeTab === "episodes" && (!videosReady || !chartsReady);

  useEffect(() => {
    if (!isLoading) {
      console.log(
        `[perf] Loading complete in ${(performance.now() - loadStartRef.current).toFixed(0)}ms (videos: ${videosReady ? "✓" : "…"}, charts: ${chartsReady ? "✓" : "…"})`,
      );
    }
  }, [isLoading, videosReady, chartsReady]);
  const [sidebarFlaggedOnly, setSidebarFlaggedOnly] = useState(() =>
    typeof window !== "undefined"
      ? sessionStorage.getItem("sidebarFlaggedOnly") === "true"
      : false,
  );

  // Eagerly load the URDFViewer bundle + warm the STL geometry cache while
  // the user is on the Episodes tab, so the 3D Replay tab opens faster.
  useEffect(() => {
    if (urdfSupported) {
      void import("@/components/urdf-viewer");
    }
  }, [urdfSupported]);

  useEffect(() => {
    sessionStorage.setItem("activeTab", activeTab);
    sessionStorage.setItem("sidebarFlaggedOnly", String(sidebarFlaggedOnly));
  }, [activeTab, sidebarFlaggedOnly]);

  const handleTabChange = (tab: ActiveTab) => {
    // Keep the selected episode when switching between replay and recording.
    if (tab === "episodes" && urdfEpisode !== episodeId) {
      sessionStorage.setItem("activeTab", tab);
      router.push(`./episode_${urdfEpisode}?view=episodes`);
      return;
    }
    setActiveTab(tab);
    const params = new URLSearchParams(window.location.search);
    params.set("view", tab);
    window.history.replaceState(
      {},
      "",
      `${window.location.pathname}?${params}`,
    );
  };

  // Not `useTime()`: any consumer of it re-renders on every playback tick,
  // which would redraw this whole component ~12×/s. <UrlTimeSync /> handles
  // the one thing here that needs `currentTime` (the ?t= URL writer).
  const { seek, setIsPlaying } = useTimeControls();

  // URDFViewer episode changer and play toggle — populated by URDFViewer on mount
  const urdfChangerRef = useRef<((ep: number) => void) | undefined>(undefined);
  const urdfPlayToggleRef = useRef<(() => void) | undefined>(undefined);
  const [urdfEpisode, setUrdfEpisode] = useState(episodeId);
  useEffect(() => setUrdfEpisode(episodeId), [episodeId]);

  // Pagination state
  const pageSize = 100;
  const [currentPage, setCurrentPage] = useState(1);
  const totalPages = Math.ceil(episodes.length / pageSize);
  const paginatedEpisodes = episodes.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize,
  );

  // Mount-only: UrlTimeSync's replaceState goes through Next's patched
  // history and changes useSearchParams, so depending on it would re-seek
  // every camera to the floored second on each ?t= write. A new episode
  // remounts this component.
  useEffect(() => {
    const timeValue = parseFloat(
      new URLSearchParams(window.location.search).get("t") ?? "",
    );
    if (!isNaN(timeValue)) seek(timeValue);
  }, [seek]);

  // sync with parent window hf.co/spaces
  useEffect(() => {
    postParentMessageWithParams((params: URLSearchParams) => {
      params.set("path", window.location.pathname + window.location.search);
    });
  }, []);

  // Initialize page based on the current episode. Splitting this out from
  // the keyboard listener effect lets the listener attach exactly once.
  useEffect(() => {
    const episodeIndex = episodes.indexOf(episodeId);
    if (episodeIndex !== -1) {
      setCurrentPage(Math.floor(episodeIndex / pageSize) + 1);
    }
  }, [episodes, episodeId, pageSize]);

  // Mirror the values the keydown handler needs into a ref. Without this,
  // `useCallback` would produce a new handler whenever `activeTab` /
  // `episodeId` / `urdfEpisode` changed, and the keydown effect would
  // detach + reattach the listener each time. Now the listener attaches
  // once and reads the latest state via the ref.
  // Vercel rule: advanced-event-handler-refs.
  const keyStateRef = useRef({ activeTab, episodeId, episodes, urdfEpisode });
  keyStateRef.current = { activeTab, episodeId, episodes, urdfEpisode };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const { key } = e;
      const s = keyStateRef.current;
      const inTextEntry = isKeyboardFocusInsideTextEntry(e.target);

      if (key === " ") {
        if (inTextEntry) return;
        e.preventDefault();
        if (s.activeTab === "urdf") {
          urdfPlayToggleRef.current?.();
        } else {
          setIsPlaying((prev: boolean) => !prev);
        }
      } else if (key === "ArrowDown" || key === "ArrowUp") {
        if (inTextEntry) return;
        e.preventDefault();
        if (s.activeTab === "urdf") {
          const nextEp =
            key === "ArrowDown" ? s.urdfEpisode + 1 : s.urdfEpisode - 1;
          const lowest = s.episodes[0];
          const highest = s.episodes[s.episodes.length - 1];
          if (nextEp >= lowest && nextEp <= highest) {
            setUrdfEpisode(nextEp);
            urdfChangerRef.current?.(nextEp);
          }
        } else {
          const nextEpisodeId =
            key === "ArrowDown" ? s.episodeId + 1 : s.episodeId - 1;
          const lowestEpisodeId = s.episodes[0];
          const highestEpisodeId = s.episodes[s.episodes.length - 1];
          if (
            nextEpisodeId >= lowestEpisodeId &&
            nextEpisodeId <= highestEpisodeId
          ) {
            router.push(`./episode_${nextEpisodeId}`);
          }
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // router / setIsPlaying are stable; the rest is read via keyStateRef.
  }, [router, setIsPlaying]);

  // Pagination functions
  const nextPage = () => {
    if (currentPage < totalPages) {
      setCurrentPage((prev) => prev + 1);
    }
  };

  const prevPage = () => {
    if (currentPage > 1) {
      setCurrentPage((prev) => prev - 1);
    }
  };

  const renderTab = (tab: ActiveTab, label: string, title?: string) => (
    <TabButton
      active={activeTab === tab}
      onClick={() => handleTabChange(tab)}
      label={label}
      title={title}
      /// Hovering 3D Replay is a strong hint it's next; get the meshes going.
      onPointerEnter={
        tab === "urdf"
          ? () =>
              void import("@/components/urdf-viewer").then((m) =>
                m.prefetchRobotModel(datasetInfo.robot_type),
              )
          : undefined
      }
    />
  );

  return (
    <div className="visualizer-shell">
      <UrlTimeSync />
      <header className="workspace-header workspace-header-compact">
        <Link href="/" className="brand-link" aria-label="Clio visualizer home">
          <ClioBrand />
        </Link>
        <button
          type="button"
          className="btn episode-picker"
          aria-label="Choose episode"
          aria-controls="episode-list"
          aria-expanded={sidebarOpen}
          title={`Episode ${activeTab === "urdf" ? urdfEpisode : episodeId}, ${datasetInfo.fps} fps. Choose an episode.`}
          onClick={() => setSidebarOpen((v) => !v)}
        >
          <span className="episode-prefix">Episode</span>
          <span className="tabular">
            {String(activeTab === "urdf" ? urdfEpisode : episodeId).padStart(
              2,
              "0",
            )}
          </span>
          <LuChevronDown size={14} aria-hidden="true" />
        </button>
        <nav aria-label="Visualizer views" className="view-tabs">
          {urdfSupported && renderTab("urdf", "Replay")}
          {renderTab("episodes", "Data", "Recorded cameras and signal data")}
        </nav>
        <div ref={setReplayToolbarTarget} className="replay-toolbar-slot" />
        <div className="header-actions">
          <ThemeToggle />
          <Link
            href="/?browse=1"
            className="btn dataset-link"
            aria-label="Datasets"
            title="Open a dataset"
          >
            <LuFolderOpen size={16} aria-hidden="true" />
            <span className="dataset-label">Datasets</span>
          </Link>
        </div>
      </header>

      {/* Body: sidebar + content */}
      <div className="flex flex-1 min-h-0">
        {/* Sidebar — on Episodes and 3D Replay tabs */}
        {
          <Sidebar
            open={sidebarOpen}
            onOpenChange={setSidebarOpen}
            datasetInfo={datasetInfo}
            paginatedEpisodes={paginatedEpisodes}
            episodeId={activeTab === "urdf" ? urdfEpisode : episodeId}
            totalPages={totalPages}
            currentPage={currentPage}
            prevPage={prevPage}
            nextPage={nextPage}
            showFlaggedOnly={sidebarFlaggedOnly}
            onShowFlaggedOnlyChange={setSidebarFlaggedOnly}
            onEpisodeSelect={
              activeTab === "urdf"
                ? (ep) => {
                    setUrdfEpisode(ep);
                    urdfChangerRef.current?.(ep);
                  }
                : undefined
            }
          />
        }

        {/* Main content */}
        <main
          id="workspace-content"
          className={`workspace-content ${isLoading ? "overflow-hidden" : "overflow-y-auto"}`}
        >
          {isLoading && <Loading />}

          {activeTab === "episodes" && (
            <>
              <h1 className="sr-only">Episode {episodeId} data</h1>

              {/* Videos */}
              {videosInfo.length > 0 && (
                <SimpleVideosPlayer
                  videosInfo={videosInfo}
                  onVideosReady={() => setVideosReady(true)}
                />
              )}

              {/* Instruction */}
              {task && (
                <div className="mb-6 panel p-4">
                  <p className="text-xs text-fg-muted">Instruction</p>
                  <div className="mt-1.5 space-y-0.5 text-sm text-fg">
                    {task
                      .split("\n")
                      .map((instruction: string, index: number) => (
                        <p key={index}>{instruction}</p>
                      ))}
                  </div>
                </div>
              )}

              {/* Graph */}
              <div className="mb-4">
                <Suspense fallback={null}>
                  <DataRecharts
                    data={chartDataGroups}
                    onChartsReady={() => setChartsReady(true)}
                  />
                </Suspense>
              </div>

              <PlaybackBar />
            </>
          )}

          {activeTab === "urdf" && (
            <Suspense fallback={<Loading />}>
              <URDFViewer
                toolbarTarget={replayToolbarTarget}
                data={data}
                org={org}
                dataset={dataset}
                episodeChangerRef={urdfChangerRef}
                playToggleRef={urdfPlayToggleRef}
              />
            </Suspense>
          )}
        </main>
      </div>
    </div>
  );
}

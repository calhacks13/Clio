"use client";

import Link from "next/link";
import { LuFilm, LuFlag, LuExternalLink, LuX } from "react-icons/lu";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useFlaggedEpisodes } from "@/context/flagged-episodes-context";

import type { DatasetDisplayInfo } from "@/app/[org]/[dataset]/[episode]/fetch-data";

interface SidebarProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  datasetInfo: DatasetDisplayInfo;
  paginatedEpisodes: number[];
  episodeId: number;
  totalPages: number;
  currentPage: number;
  prevPage: () => void;
  nextPage: () => void;
  showFlaggedOnly: boolean;
  onShowFlaggedOnlyChange: (v: boolean) => void;
  onEpisodeSelect?: (ep: number) => void;
}

const SMALL_SCREEN = "(max-width: 767px)";

function useIsSmallScreen(): boolean {
  const [small, setSmall] = useState(
    () =>
      typeof window !== "undefined" && window.matchMedia(SMALL_SCREEN).matches,
  );
  useEffect(() => {
    const query = window.matchMedia(SMALL_SCREEN);
    const onChange = () => setSmall(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return small;
}

const Sidebar: React.FC<SidebarProps> = ({
  open,
  onOpenChange,
  datasetInfo,
  paginatedEpisodes,
  episodeId,
  totalPages,
  currentPage,
  prevPage,
  nextPage,
  showFlaggedOnly,
  onShowFlaggedOnlyChange,
  onEpisodeSelect,
}) => {
  const isSmall = useIsSmallScreen();
  const closeDrawer = () => {
    if (isSmall) onOpenChange(false);
  };
  useEffect(() => {
    if (!isSmall || !open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onOpenChange(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isSmall, open, onOpenChange]);
  const { flagged, count, toggle } = useFlaggedEpisodes();

  const displayEpisodes = useMemo(() => {
    if (!showFlaggedOnly || count === 0) return paginatedEpisodes;
    return [...flagged].sort((a, b) => a - b);
  }, [paginatedEpisodes, showFlaggedOnly, flagged, count]);

  /// A page holds 100 episodes; without this, opening episode 80 left its highlighted row off screen.
  /// Only scrolls when the row is out of view, so clicking a visible row doesn't make the list jump.
  const navRef = useRef<HTMLUListElement>(null);
  const activeItemRef = useRef<HTMLLIElement>(null);
  useEffect(() => {
    const item = activeItemRef.current?.getBoundingClientRect();
    const nav = navRef.current?.getBoundingClientRect();
    if (!item || !nav) return;
    if (item.top < nav.top || item.bottom > nav.bottom) {
      activeItemRef.current?.scrollIntoView({ block: "center" });
    }
  }, [episodeId, displayEpisodes, open]);

  if (!open) return null;

  const datasetLabel =
    datasetInfo.repoId
      .split("/")
      .pop()
      ?.replace(/_Dataset$/i, "")
      .replace(/_/g, " ") ?? "Dataset";

  return (
    <div className="relative z-20 flex shrink-0 min-h-0">
      {open && isSmall && (
        <div
          className="fixed inset-0 z-20 bg-bg"
          onClick={() => onOpenChange(false)}
          aria-hidden="true"
        />
      )}
      {open && (
        <nav
          className={`episode-sidebar ${isSmall ? "absolute inset-y-0 left-0 z-30 shadow-xl" : ""}`}
          id="episode-list"
          aria-label="Episode list"
        >
          <div className="flex items-center justify-between gap-2 px-1">
            <h2 className="text-sm font-semibold">Episodes</h2>
            <button
              onClick={() => onOpenChange(false)}
              title="Hide episode list"
              aria-label="Hide episode list"
              className="sidebar-icon-button"
            >
              <LuX size={16} aria-hidden="true" />
            </button>
          </div>
          <p className="mt-3 px-1 text-xs leading-relaxed text-fg-muted break-words">
            {datasetLabel}
          </p>
          <div className="mt-3 flex items-center justify-between px-1">
            <span className="text-[11px] text-fg-muted tabular">
              {datasetInfo.total_episodes.toLocaleString()} episodes
            </span>
            {count > 0 && (
              <button
                onClick={() => onShowFlaggedOnlyChange(!showFlaggedOnly)}
                aria-pressed={showFlaggedOnly}
                className={`btn !min-h-7 !px-2 !py-1 !text-[11px] ${showFlaggedOnly ? "btn-flagged" : ""}`}
              >
                <LuFlag size={12} aria-hidden="true" /> {count}
              </button>
            )}
          </div>
          <ul ref={navRef} className="episode-list">
            {displayEpisodes.map((episode) => {
              const active = episode === episodeId;
              const content = (
                <>
                  <LuFilm
                    size={15}
                    className="episode-icon"
                    aria-hidden="true"
                  />
                  <span>Episode {String(episode).padStart(2, "0")}</span>
                </>
              );
              return (
                <li
                  key={episode}
                  ref={active ? activeItemRef : undefined}
                  className={`episode-row ${active ? "is-active" : ""}`}
                >
                  {onEpisodeSelect ? (
                    <button
                      onClick={() => {
                        onEpisodeSelect(episode);
                        closeDrawer();
                      }}
                      aria-current={active ? "true" : undefined}
                      className="episode-select"
                    >
                      {content}
                    </button>
                  ) : (
                    <Link
                      href={`./episode_${episode}?view=episodes`}
                      onClick={closeDrawer}
                      aria-current={active ? "page" : undefined}
                      className="episode-select"
                    >
                      {content}
                    </Link>
                  )}
                  <button
                    onClick={() => toggle(episode)}
                    className={`episode-flag ${flagged.has(episode) ? "is-flagged" : ""}`}
                    aria-label={`${flagged.has(episode) ? "Unflag" : "Flag"} episode ${episode}`}
                    aria-pressed={flagged.has(episode)}
                    title={
                      flagged.has(episode) ? "Unflag episode" : "Flag episode"
                    }
                  >
                    <LuFlag size={13} aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ul>
          {!showFlaggedOnly && totalPages > 1 && (
            <div className="my-3 flex items-center justify-between gap-2">
              <button
                onClick={prevPage}
                className="btn"
                disabled={currentPage === 1}
              >
                Previous
              </button>
              <span className="text-[11px] text-fg-muted tabular">
                {currentPage} / {totalPages}
              </span>
              <button
                onClick={nextPage}
                className="btn"
                disabled={currentPage === totalPages}
              >
                Next
              </button>
            </div>
          )}
          <div className="sidebar-footer">
            <span className="tabular">{datasetInfo.fps} fps</span>
            <a
              href={`https://huggingface.co/datasets/${datasetInfo.repoId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 hover:text-fg"
            >
              Source dataset <LuExternalLink size={12} aria-hidden="true" />
            </a>
          </div>
        </nav>
      )}
    </div>
  );
};

export default Sidebar;

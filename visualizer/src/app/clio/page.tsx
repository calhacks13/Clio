"use client";

import type {
  EpisodeDetailResponse,
  EpisodeMeta,
  EpisodeSummary,
} from "@clio/protocol";
import {
  episodeTails,
  getEpisode,
  listEpisodes,
  NdjsonTail,
} from "@clio-viewer/api";
import Link from "next/link";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { LuChevronRight, LuRadio } from "react-icons/lu";
import { ClioBrand } from "@/components/clio-brand";
import { Spinner, ThemeToggle } from "@/components/ui";
import { missingBatches } from "@/lib/clio/lanes";
import { LIVE_GROWTH_MS, STATUS_EVERY_MS } from "@/lib/clio/source";
import type { EpisodeStatus } from "@/lib/clio/types";

// /clio: the Clio server's recordings, newest first (docs/plans/visualizer.md
// 2.1). Each row names the procedure and start time, its status (live while it
// grew in the last 15 s, else stopped or finished) and missing batches. "Follow
// live" opens /clio/live. The list is read through the /api/clio proxy.

const API_BASE = "/api/clio";
/** A request for "after the end": answers only the file's end, as x-next-from. */
const END_PROBE = Number.MAX_SAFE_INTEGER;
/** Enough of the end of a frames file to hold its last whole frame. */
const LAST_FRAME_BYTES = 64 * 1024;

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

const PILL =
  "inline-flex h-5 shrink-0 items-center rounded-full px-2 text-xs font-medium";

const browserFetch = (input: string, init?: RequestInit) => fetch(input, init);

/** What the list remembers about one recording between reads. */
interface Known {
  summary: EpisodeSummary;
  detail: EpisodeDetailResponse | null;
  /** performance.now() of the last growth seen; -Infinity when none is known. */
  grewAtMs: number;
  /** The age of the newest frame was read (unfinished recordings, once). */
  aged: boolean;
}

interface Row {
  id: string;
  title: string | null;
  startedAtMs: number;
  status: EpisodeStatus;
  missing: number;
}

const changed = (a: EpisodeSummary, b: EpisodeSummary) =>
  a.frameCount !== b.frameCount ||
  a.eventCount !== b.eventCount ||
  a.finished !== b.finished;

/**
 * How long ago (wall-clock ms) the newest frame of an unfinished recording was
 * captured: the server's creation time plus the frame's own `t`. Read once
 * per recording, from the end of its frames file.
 */
async function newestFrameAgeMs(
  summary: EpisodeSummary,
  signal: AbortSignal,
): Promise<number> {
  const createdAtMs = Date.parse(summary.createdAt);
  if (summary.frameCount === 0) return Date.now() - createdAtMs;
  const { url } = episodeTails(
    summary.episodeId,
    browserFetch,
    API_BASE,
  ).frames;
  const probe = new NdjsonTail(url, browserFetch, { from: END_PROBE });
  await probe.read(signal);
  const from = Math.max(0, probe.offset - LAST_FRAME_BYTES);
  const tail = new NdjsonTail(url, browserFetch, {
    from,
    skipFirstLine: from > 0,
  });
  const frames = await tail.read(signal);
  const last = frames.at(-1) as { t?: unknown } | undefined;
  const tMs = typeof last?.t === "number" ? last.t : 0;
  return Date.now() - (createdAtMs + tMs);
}

function rowOf(known: Known, nowMs: number): Row {
  const { summary, detail } = known;
  const meta = detail?.meta;
  const title = meta
    ? (meta.procedure?.title ?? MODE_TITLE[meta.mode])
    : summary.procedureId === null
      ? MODE_TITLE[summary.mode]
      : null;
  const status: EpisodeStatus = summary.finished
    ? "finished"
    : nowMs - known.grewAtMs < LIVE_GROWTH_MS
      ? "live"
      : "stopped";
  const batches = detail?.batches
    ? { ...detail.batches, sent: detail.finish?.batches ?? null }
    : null;
  return {
    id: summary.episodeId,
    title,
    startedAtMs: Date.parse(summary.createdAt),
    status,
    missing: missingBatches(batches),
  };
}

/** Polls the list; reads a recording's detail when it first appears or changes. */
function useRecordings() {
  const known = useRef(new Map<string, Known>());
  const [rows, setRows] = useState<Row[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const abort = new AbortController();
    const { signal } = abort;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const refresh = async (summary: EpisodeSummary) => {
      const id = summary.episodeId;
      const prev = known.current.get(id);
      const entry: Known = prev ?? {
        summary,
        detail: null,
        grewAtMs: Number.NEGATIVE_INFINITY,
        aged: false,
      };
      if (prev && changed(prev.summary, summary)) {
        entry.grewAtMs = performance.now();
      }
      const stale = !prev || changed(prev.summary, summary);
      entry.summary = summary;
      known.current.set(id, entry);
      const age = !entry.aged && !summary.finished;
      if (!stale && entry.detail && !age) return;
      const [detail, ageMs] = await Promise.all([
        getEpisode(id, signal, browserFetch, API_BASE),
        age ? newestFrameAgeMs(summary, signal) : null,
      ]);
      entry.detail = detail;
      if (ageMs !== null) {
        entry.aged = true;
        entry.grewAtMs = Math.max(entry.grewAtMs, performance.now() - ageMs);
      }
    };

    const poll = async () => {
      try {
        const summaries = await listEpisodes(browserFetch, API_BASE, signal);
        // A recording that can't be read keeps its row; the next poll retries.
        await Promise.allSettled(summaries.map(refresh));
        if (signal.aborted) return;
        const now = performance.now();
        setRows(
          summaries.flatMap((s) => {
            const entry = known.current.get(s.episodeId);
            return entry ? [rowOf(entry, now)] : [];
          }),
        );
        setFailed(false);
      } catch {
        if (signal.aborted) return;
        setFailed(true);
      }
      timer = setTimeout(poll, STATUS_EVERY_MS);
    };
    void poll();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { rows, failed, retry };
}

function StatusPill({ status }: { status: EpisodeStatus }) {
  switch (status) {
    case "live":
      return <span className={`${PILL} bg-accent text-[#0F1117]`}>Live</span>;
    case "stopped":
      return (
        <span className={`${PILL} bg-fg-muted text-surface-0`}>Stopped</span>
      );
    case "finished":
      return (
        <span className={`${PILL} bg-fill-strong text-fg-soft`}>Finished</span>
      );
  }
}

export default function ClioRecordingsPage() {
  const { rows, failed, retry } = useRecordings();
  return (
    <div className="min-h-screen bg-bg text-fg">
      <header className="workspace-header">
        <Link href="/" className="brand-link" aria-label="Clio visualizer home">
          <ClioBrand />
          <span className="brand-divider" aria-hidden="true" />
          <span className="brand-context">Recordings</span>
        </Link>
        <div />
        <div className="header-actions">
          <ThemeToggle />
        </div>
      </header>
      <main className="browse-page">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <h1 className="text-[32px] font-semibold leading-tight">
            Recordings
          </h1>
          <Link href="/clio/live" className="btn btn-primary !px-6 !text-sm">
            <LuRadio size={16} aria-hidden="true" />
            Follow live
          </Link>
        </div>
        {failed && (
          <div
            role="alert"
            className="mt-8 flex flex-wrap items-center gap-4 text-sm text-flag-fg"
          >
            Can&apos;t reach the Clio server
            <button type="button" className="btn" onClick={retry}>
              Retry
            </button>
          </div>
        )}
        {rows === null && !failed && (
          <p
            role="status"
            className="mt-8 flex items-center gap-2 text-sm text-fg-muted"
          >
            <Spinner /> Loading recordings…
          </p>
        )}
        {rows !== null && rows.length === 0 && (
          <p className="mt-8 text-sm text-fg-muted">No recordings yet</p>
        )}
        {rows !== null && rows.length > 0 && (
          <ul className="mt-6" aria-label="Recordings">
            {rows.map((row) => (
              <li key={row.id}>
                <Link
                  href={`/clio/${encodeURIComponent(row.id)}`}
                  className="dataset-row"
                >
                  <span className="flex min-w-0 flex-wrap items-baseline gap-x-4 gap-y-1">
                    <span className="min-w-0 break-words font-medium">
                      {row.title ?? " "}
                    </span>
                    <span className="text-xs text-fg-muted tabular">
                      {startFormat.format(row.startedAtMs)}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-3">
                    {row.missing > 0 && (
                      <span className="text-xs font-medium text-flag-fg tabular">
                        {row.missing === 1
                          ? "1 batch missing"
                          : `${row.missing} batches missing`}
                      </span>
                    )}
                    <StatusPill status={row.status} />
                    <LuChevronRight
                      size={16}
                      className="text-fg-muted"
                      aria-hidden="true"
                    />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}

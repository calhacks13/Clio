"use client";

import {
  DatasetExportStatusSchema,
  type DatasetExportStatus,
} from "@clio/protocol";
import { useEffect, useRef, useState } from "react";
import { LuDownload } from "react-icons/lu";
import { Spinner } from "@/components/ui";

const BASE = "/api/clio/datasets/exports";
const SAVED_JOB = "clio-dataset-export";

async function readStatus(response: Response): Promise<DatasetExportStatus> {
  if (!response.ok) {
    const text = await response.text();
    let message = text;
    try {
      message = JSON.parse(text).error?.message ?? text;
    } catch {
      /* plain proxy error */
    }
    throw new Error(message || "Export failed. Try again.");
  }
  return DatasetExportStatusSchema.parse(await response.json());
}

export function DatasetExport({
  episodeIds,
  disabled,
}: {
  episodeIds: string[];
  disabled: boolean;
}) {
  const [name, setName] = useState("clio-dataset");
  const [fps, setFps] = useState(30);
  const [job, setJob] = useState<DatasetExportStatus | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const submitAbort = useRef<AbortController | null>(null);
  const busy =
    submitting ||
    (!!jobId && (!job || job.state === "queued" || job.state === "running"));
  const validName = /^[a-z0-9][a-z0-9_-]{0,63}$/.test(name);
  const invalidName = name.length > 0 && !validName;

  useEffect(() => {
    try {
      setJobId(sessionStorage.getItem(SAVED_JOB));
    } catch {
      /* storage unavailable */
    }
    return () => submitAbort.current?.abort();
  }, []);

  useEffect(() => {
    if (!jobId) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const status = await readStatus(
          await fetch(`${BASE}/${encodeURIComponent(jobId)}`, {
            signal: abort.signal,
            cache: "no-store",
          }),
        );
        if (abort.signal.aborted) return;
        setJob(status);
        setError(null);
        if (status.state === "ready" || status.state === "failed") return;
        timer = setTimeout(poll, 1000);
      } catch (cause) {
        if (abort.signal.aborted) return;
        setError(
          cause instanceof Error
            ? cause.message
            : "Can't check the export. Try again.",
        );
      }
    };
    void poll();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [jobId, attempt]);

  const create = async () => {
    if (busy) return;
    setSubmitting(true);
    setError(null);
    setJob(null);
    setJobId(null);
    try {
      sessionStorage.removeItem(SAVED_JOB);
    } catch {
      /* storage unavailable */
    }
    const abort = new AbortController();
    submitAbort.current = abort;
    try {
      const status = await readStatus(
        await fetch(BASE, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name, fps, episodeIds }),
          signal: abort.signal,
        }),
      );
      if (abort.signal.aborted) return;
      setJob(status);
      setJobId(status.id);
      try {
        sessionStorage.setItem(SAVED_JOB, status.id);
      } catch {
        /* storage unavailable */
      }
    } catch (cause) {
      if (!abort.signal.aborted)
        setError(
          cause instanceof Error ? cause.message : "Export failed. Try again.",
        );
    } finally {
      if (!abort.signal.aborted) setSubmitting(false);
    }
  };

  const reset = () => {
    setJobId(null);
    setJob(null);
    setError(null);
    try {
      sessionStorage.removeItem(SAVED_JOB);
    } catch {
      /* storage unavailable */
    }
  };

  return (
    <section
      aria-labelledby="dataset-export-title"
      className="mt-6 rounded-xl bg-surface-1 p-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="dataset-export-title" className="text-base font-semibold">
          Download dataset
        </h2>
        <span className="text-sm text-fg-muted tabular">
          {episodeIds.length} selected
        </span>
      </div>
      <p className="mt-1 text-sm text-fg-muted">
        LeRobot v3 ZIP with human hand targets, task labels and object
        positions. Video is not included.
      </p>
      <form
        className="mt-4 flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <div className="flex min-w-0 w-full flex-col gap-1.5 text-sm sm:w-auto sm:flex-1">
          <label htmlFor="clio-dataset-name">Dataset name</label>
          <input
            id="clio-dataset-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
            pattern={"[a-z0-9][a-z0-9_\\-]{0,63}"}
            maxLength={64}
            required
            aria-invalid={invalidName}
            aria-describedby={invalidName ? "dataset-name-error" : undefined}
            title="Use lowercase letters, numbers, hyphens or underscores"
            className="w-full rounded-lg bg-fill px-3 py-2 text-fg"
          />
          {invalidName && (
            <span id="dataset-name-error" className="text-xs text-flag-fg">
              Use lowercase letters, numbers, hyphens or underscores. Start with
              a letter or number.
            </span>
          )}
        </div>
        <label className="flex flex-col gap-1.5 text-sm">
          Frame rate
          <select
            value={fps}
            onChange={(e) => setFps(Number(e.target.value))}
            disabled={busy}
            className="rounded-lg bg-fill px-3 py-2 text-fg"
          >
            {[10, 15, 20, 30, 60].map((rate) => (
              <option key={rate} value={rate}>
                {rate} fps
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          className="btn btn-primary !min-h-10 !px-5 !text-sm"
          disabled={
            busy ||
            disabled ||
            !validName ||
            episodeIds.length === 0 ||
            episodeIds.length > 100
          }
        >
          {busy ? <Spinner /> : <LuDownload size={16} aria-hidden="true" />}
          {busy ? "Preparing dataset…" : "Export selected"}
        </button>
      </form>
      {episodeIds.length === 0 && !busy && (
        <p className="mt-3 text-sm text-fg-muted">
          Select finished recordings below.
        </p>
      )}
      {episodeIds.length > 100 && (
        <p role="alert" className="mt-3 text-sm text-flag-fg">
          Select up to 100 recordings per dataset.
        </p>
      )}
      <div aria-live="polite" aria-atomic="true">
        {job?.state === "queued" && !error && (
          <p className="mt-3 text-sm text-fg-muted">
            Waiting for another export to finish…
          </p>
        )}
        {job?.state === "running" && !error && (
          <p className="mt-3 text-sm text-fg-muted">
            Exporting {job.episodeCount}{" "}
            {job.episodeCount === 1 ? "recording" : "recordings"} at {job.fps}{" "}
            fps. You can keep browsing.
          </p>
        )}
        {job?.state === "ready" && !error && (
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <a
              href={`${BASE}/${encodeURIComponent(job.id)}/download`}
              className="btn btn-primary max-w-full !text-sm"
              download
            >
              <LuDownload size={16} className="shrink-0" aria-hidden="true" />
              <span className="min-w-0 break-all">Download {job.name}.zip</span>
            </a>
            <span className="text-sm text-fg-muted">
              {job.episodeCount}{" "}
              {job.episodeCount === 1 ? "recording" : "recordings"} at {job.fps}{" "}
              fps
            </span>
          </div>
        )}
      </div>
      {(error || job?.state === "failed") && (
        <div
          role="alert"
          className="mt-3 flex flex-wrap items-center gap-3 text-sm"
        >
          <p className="min-w-0 break-words text-flag-fg">
            {error || job?.error || "Export failed. Try again."}
          </p>
          {error && jobId && (
            <button
              type="button"
              className="btn"
              onClick={() => setAttempt((n) => n + 1)}
            >
              Retry status
            </button>
          )}
          <button type="button" className="btn" onClick={reset}>
            Start again
          </button>
        </div>
      )}
    </section>
  );
}

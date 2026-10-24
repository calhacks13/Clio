"use client";

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  axisTicks,
  formatRange,
  formatSeconds,
  formatTime,
  HAND_LABEL,
  lostSpans,
  type SourceClass,
  sourceLabel,
  tickRuns,
} from "@/lib/clio/lanes";
import { identityColor, SCENE_COLORS, themed } from "@/lib/clio/object-display";
import type { LaneGap, LaneModel, ObjectLane } from "@/lib/clio/types";
import { useTheme } from "@/utils/theme";

// Per-object lanes on one time axis for the whole episode (DESIGN.md, "Lanes"):
// held spans on top, updates by source in the middle with detector answers
// drawn from observation to arrival, position lost at the bottom. Missing
// ranges shade every lane. Click or drag on the lanes to seek.

const TICK_FILL: Record<SourceClass, string> = {
  detection: "var(--clio-detection)",
  hand: "var(--fg-soft)",
  plan: "var(--fg-faint)",
};

const ROW = 28;
const AXIS = 22;
/** Row geometry: held band, update ticks, lost band. */
const HELD_Y = 3;
const HELD_H = 6;
const TICK_Y = 10;
const TICK_H = 12;
const LOST_Y = 23;
const LOST_H = 4;
const MARK = 8;
/** About one digit's width in the 11px axis labels. */
const AXIS_CHAR_PX = 7;
/** Held spans and detector answers take focus, for their tooltip. */
const FOCUSABLE_MARK =
  "outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent-ring)]";

const GAP_NAME: Record<LaneGap["kind"], string> = {
  not_loaded: "Not loaded",
  hands_not_kept: "Hands not kept",
};

export interface ObjectLanesProps {
  model: LaneModel;
  /** The viewed time. */
  tUs: number;
  /** While live: the newest received time, drawn as the live edge. */
  liveEdgeUs?: number | null;
  /** The episode records location flags; otherwise no loss is drawn. */
  flagsRecorded: boolean;
  selectedId?: string | null;
  onSelect?: (entityId: string) => void;
  onSeek?: (tUs: number) => void;
  className?: string;
}

/**
 * The width of an element, kept up to date. A callback ref, so the observer
 * follows the element when it mounts later or is replaced.
 */
function useWidth<T extends HTMLElement>(): [(el: T | null) => void, number] {
  const [el, setEl] = useState<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!el) {
      setWidth(0);
      return;
    }
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.floor(entry.contentRect.width));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  return [setEl, width];
}

function Legend({ flagsRecorded }: { flagsRecorded: boolean }) {
  const item = (label: string, swatch: React.ReactNode) => (
    <span className="flex items-center gap-1.5">
      <svg width="16" height="10" aria-hidden="true">
        {swatch}
      </svg>
      {label}
    </span>
  );
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-muted">
      {item(
        "Detector",
        <rect x="5" y="0" width="6" height="10" fill={TICK_FILL.detection} />,
      )}
      {item(
        "Hand",
        <rect x="5" y="0" width="6" height="10" fill={TICK_FILL.hand} />,
      )}
      {item(
        "Plan",
        <rect x="5" y="0" width="6" height="10" fill={TICK_FILL.plan} />,
      )}
      {item(
        "Held",
        <rect x="0" y="2" width="16" height={HELD_H} fill="var(--fg-soft)" />,
      )}
      {item(
        "Inferred",
        <line
          x1="0"
          x2="16"
          y1="5"
          y2="5"
          stroke="var(--fg-muted)"
          strokeWidth={HELD_H}
          strokeDasharray="6 3"
        />,
      )}
      {flagsRecorded &&
        item(
          "Lost",
          <rect
            x="0"
            y="3"
            width="16"
            height={LOST_H}
            fill="var(--fg-muted)"
          />,
        )}
    </div>
  );
}

/** One lane's marks, with `y` at the top of its row. */
function LaneMarks({
  lane,
  y,
  x,
  usPerPx,
  endUs,
  flagsRecorded,
}: {
  lane: ObjectLane;
  y: number;
  x: (tUs: number) => number;
  usPerPx: number;
  endUs: number;
  flagsRecorded: boolean;
}) {
  const runs = tickRuns(lane.ticks, usPerPx);
  const lost = flagsRecorded ? lostSpans(lane, endUs) : [];
  const answers = [...lane.detections, ...lane.misses];
  const midY = y + TICK_Y + TICK_H / 2;
  return (
    <g>
      {lane.held.map((span) => {
        const x0 = x(span.startUs);
        const width = Math.max(2, x(span.endUs) - x0);
        const by = span.hand ? HAND_LABEL[span.hand] : "Hand unknown";
        const inferred = span.origin === "inferred";
        const label = `Held ${formatRange(span.startUs, span.endUs)}${span.open ? ", still held" : ""}. ${by}. ${inferred ? "Inferred from pinch" : "Recorded"}`;
        return (
          <g
            key={`h${span.startUs}`}
            tabIndex={0}
            role="img"
            aria-label={label}
            className={FOCUSABLE_MARK}
          >
            <title>{label}</title>
            {inferred ? (
              <line
                x1={x0}
                x2={x0 + width}
                y1={y + HELD_Y + HELD_H / 2}
                y2={y + HELD_Y + HELD_H / 2}
                stroke="var(--fg-muted)"
                strokeWidth={HELD_H}
                strokeDasharray="6 3"
              />
            ) : (
              <rect
                x={x0}
                y={y + HELD_Y}
                width={width}
                height={HELD_H}
                fill="var(--fg-soft)"
              />
            )}
          </g>
        );
      })}
      {runs.map((run) => {
        const x0 = x(run.startUs);
        const width = Math.max(2, x(run.endUs) - x0);
        const when =
          run.count > 1
            ? `${formatRange(run.startUs, run.endUs)}, ${run.count} updates`
            : formatTime(run.startUs);
        return (
          <rect
            key={`t${run.startUs}${run.sourceId}`}
            x={Math.max(0, x0 - (run.count > 1 ? 0 : 1))}
            y={y + TICK_Y}
            width={width}
            height={TICK_H}
            fill={TICK_FILL[run.source]}
          >
            <title>{`${sourceLabel(run.sourceId)} ${when}`}</title>
          </rect>
        );
      })}
      {answers.map((answer) => {
        const x0 = x(answer.observedUs);
        const x1 = x(answer.availableUs);
        const color = answer.found
          ? "var(--clio-detection)"
          : "var(--fg-muted)";
        const label = `Detector ${answer.found ? "found" : "missed"} at ${formatTime(answer.availableUs)}, camera frame at ${formatTime(answer.observedUs)}, ${formatSeconds(answer.availableUs - answer.observedUs)} latency${answer.found ? `, confidence ${answer.confidence.toFixed(2)}` : ""}. Finder: ${answer.source}`;
        return (
          <g
            key={`d${answer.eventSequence}`}
            tabIndex={0}
            role="img"
            aria-label={label}
            className={FOCUSABLE_MARK}
          >
            <title>{label}</title>
            <line
              x1={x0}
              x2={x1}
              y1={midY}
              y2={midY}
              stroke="var(--fg-muted)"
              strokeWidth={1}
            />
            {answer.found ? (
              <circle cx={x1} cy={midY} r={MARK / 2} fill={color} />
            ) : (
              <rect
                x={x1 - MARK / 2}
                y={midY - MARK / 2}
                width={MARK}
                height={MARK}
                fill={color}
              />
            )}
          </g>
        );
      })}
      {lost.map((span) => (
        <rect
          key={`l${span.startUs}`}
          x={x(span.startUs)}
          y={y + LOST_Y}
          width={Math.max(2, x(span.endUs) - x(span.startUs))}
          height={LOST_H}
          fill="var(--fg-muted)"
        >
          <title>{`Position lost ${formatRange(span.startUs, span.endUs)}`}</title>
        </rect>
      ))}
    </g>
  );
}

export default function ObjectLanes({
  model,
  tUs,
  liveEdgeUs = null,
  flagsRecorded,
  selectedId = null,
  onSelect,
  onSeek,
  className = "",
}: ObjectLanesProps) {
  const theme = useTheme();
  const [trackRef, width] = useWidth<HTMLDivElement>();
  const spanUs = Math.max(1, model.endUs - model.startUs);
  const usPerPx = width > 0 ? spanUs / width : 1;
  const x = useCallback(
    (t: number) => ((t - model.startUs) / spanUs) * width,
    [model.startUs, spanUs, width],
  );
  const height = AXIS + model.lanes.length * ROW;
  const seekEndUs = liveEdgeUs ?? model.endUs;

  // The marks change with new data or a resize, not with the playhead.
  const marks = useMemo(() => {
    if (width <= 0) return null;
    const ticks = axisTicks(model.startUs, model.endUs, width);
    const named = model.gaps.filter(
      (gap, i) =>
        x(gap.endUs) - x(gap.startUs) >= 72 &&
        model.gaps.findIndex((g) => g.kind === gap.kind) === i,
    );
    const inNamedGap = (t: number) =>
      named.some((g) => t >= g.startUs && t <= g.endUs);
    // A label that would run past the right end is left out, not clipped.
    const fits = (tick: { tUs: number; label: string }) =>
      x(tick.tUs) + 3 + tick.label.length * AXIS_CHAR_PX <= width;
    return (
      <>
        {model.gaps.map((gap) => (
          <rect
            key={`g${gap.kind}${gap.startUs}`}
            x={x(gap.startUs)}
            y={0}
            width={Math.max(1, x(gap.endUs) - x(gap.startUs))}
            height={height}
            fill="var(--fill-strong)"
          >
            <title>{`${GAP_NAME[gap.kind]} ${formatRange(gap.startUs, gap.endUs)}`}</title>
          </rect>
        ))}
        {model.lanes.map((lane, i) => (
          <line
            key={`r${lane.entityId}`}
            x1={0}
            x2={width}
            y1={AXIS + i * ROW + 0.5}
            y2={AXIS + i * ROW + 0.5}
            stroke="var(--line-subtle)"
          />
        ))}
        {ticks
          .filter((tick) => !inNamedGap(tick.tUs) && fits(tick))
          .map((tick) => (
            <text
              key={`a${tick.tUs}`}
              x={x(tick.tUs) + 3}
              y={14}
              fontSize={11}
              fill="var(--fg-faint)"
              className="tabular"
            >
              {tick.label}
            </text>
          ))}
        {named.map((gap) => (
          <text
            key={`n${gap.kind}`}
            x={x(gap.startUs) + 6}
            y={14}
            fontSize={11}
            fontWeight={500}
            fill="var(--fg-muted)"
          >
            {GAP_NAME[gap.kind]}
          </text>
        ))}
        {model.lanes.map((lane, i) => (
          <LaneMarks
            key={lane.entityId}
            lane={lane}
            y={AXIS + i * ROW}
            x={x}
            usPerPx={usPerPx}
            endUs={model.endUs}
            flagsRecorded={flagsRecorded}
          />
        ))}
      </>
    );
  }, [model, width, height, x, usPerPx, flagsRecorded]);

  const dragging = useRef(false);
  const seekAt = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!onSeek || width <= 0) return;
    const box = e.currentTarget.getBoundingClientRect();
    const t = model.startUs + ((e.clientX - box.left) / width) * spanUs;
    onSeek(Math.round(Math.min(seekEndUs, Math.max(model.startUs, t))));
  };

  const vars = {
    "--clio-detection": themed(SCENE_COLORS.detection, theme),
  } as React.CSSProperties;
  const playX = Math.round(x(Math.min(tUs, seekEndUs))) + 0.5;

  return (
    <section
      className={`flex min-w-0 flex-col gap-3 ${className}`}
      style={vars}
      aria-label="Object lanes"
    >
      <Legend flagsRecorded={flagsRecorded} />
      {model.lanes.length === 0 ? (
        <p className="py-4 text-sm text-fg-muted">No objects in this episode</p>
      ) : (
        <div className="flex min-w-0">
          <ul className="w-24 shrink-0 sm:w-36" style={{ paddingTop: AXIS }}>
            {model.lanes.map((lane, i) => {
              const selected = lane.entityId === selectedId;
              const title = flagsRecorded
                ? lane.label
                : `${lane.label}\nTracking loss not recorded`;
              return (
                <li key={lane.entityId} style={{ height: ROW }}>
                  <button
                    type="button"
                    onClick={() => onSelect?.(lane.entityId)}
                    aria-pressed={selected}
                    title={title}
                    className={`flex h-full w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-[13px] font-medium text-fg-soft transition-colors ${selected ? "bg-[var(--accent-soft)] text-fg" : "hover:bg-fill"}`}
                  >
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ background: themed(identityColor(i), theme) }}
                      aria-hidden="true"
                    />
                    <span className="truncate">{lane.label}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          <div ref={trackRef} className="min-w-0 flex-1">
            {width > 0 && (
              <svg
                width={width}
                height={height}
                className="block touch-none select-none"
                role="group"
                aria-label={`Lanes from ${formatRange(model.startUs, model.endUs)}`}
                onPointerDown={(e) => {
                  if (e.button !== 0) return;
                  dragging.current = true;
                  e.currentTarget.setPointerCapture(e.pointerId);
                  seekAt(e);
                }}
                onPointerMove={(e) => {
                  if (dragging.current) seekAt(e);
                }}
                onPointerUp={() => {
                  dragging.current = false;
                }}
                onPointerCancel={() => {
                  dragging.current = false;
                }}
                style={{ cursor: onSeek ? "col-resize" : undefined }}
              >
                {marks}
                {liveEdgeUs !== null && (
                  <line
                    x1={Math.min(x(liveEdgeUs), width - 1)}
                    x2={Math.min(x(liveEdgeUs), width - 1)}
                    y1={0}
                    y2={height}
                    stroke="var(--accent)"
                    strokeWidth={2}
                  />
                )}
                <line
                  x1={playX}
                  x2={playX}
                  y1={0}
                  y2={height}
                  stroke="var(--playhead)"
                  strokeWidth={1}
                />
              </svg>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

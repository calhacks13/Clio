"use client";

import React, { useEffect, useMemo, useRef } from "react";
import { currentRowIndex, eventRows, formatTime } from "@/lib/clio/lanes";
import type { Capture } from "@clio-viewer/capture/model";

// The episode's events as one line each (the headset viewer's event-log.ts),
// plus pick-ups and put-downs. The row at or before the viewed time is marked
// and kept in view; clicking a row seeks to it.

export interface EventListProps {
  capture: Capture;
  /** The source's revision: rows are rebuilt only when it changes. */
  revision: number;
  tUs: number;
  onSeek?: (tUs: number) => void;
  className?: string;
}

export default function EventList({
  capture,
  revision,
  tUs,
  onSeek,
  className = "",
}: EventListProps) {
  // eslint-disable-next-line react-hooks/exhaustive-deps -- revision marks new records in the same capture
  const rows = useMemo(() => eventRows(capture), [capture, revision]);
  const current = currentRowIndex(rows, tUs);
  const listRef = useRef<HTMLOListElement>(null);
  // The playhead moves every frame but the current row rarely changes, so the
  // rows are built only when they or the current index change.
  const items = useMemo(
    () =>
      rows.map((row, i) => (
        <EventRowItem
          key={row.key}
          tUs={row.tUs}
          label={row.label}
          text={row.text}
          inferred={row.inferred}
          isCurrent={i === current}
          future={i > current}
          onSeek={onSeek}
        />
      )),
    [rows, current, onSeek],
  );

  // Keep the current row visible inside the list, without scrolling the page.
  useEffect(() => {
    const list = listRef.current;
    const row = list?.children[current] as HTMLElement | undefined;
    if (!list || !row) return;
    // The list is positioned, so it is the row's offsetParent.
    const top = row.offsetTop;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (top + row.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = top + row.offsetHeight - list.clientHeight;
    }
  }, [current]);

  if (rows.length === 0) {
    return (
      <p className={`text-sm text-fg-muted ${className}`}>No events yet</p>
    );
  }
  return (
    <ol
      ref={listRef}
      className={`relative min-h-0 overflow-y-auto ${className}`}
      aria-label="Events"
    >
      {items}
    </ol>
  );
}

interface EventRowItemProps {
  tUs: number;
  label: string;
  text: string;
  inferred: boolean;
  isCurrent: boolean;
  future: boolean;
  onSeek?: (tUs: number) => void;
}

// Plain props, so a row whose content and place are unchanged skips rendering
// when the rows are rebuilt for new records.
const EventRowItem = React.memo(function EventRowItem({
  tUs,
  label,
  text,
  inferred,
  isCurrent,
  future,
  onSeek,
}: EventRowItemProps) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onSeek?.(tUs)}
        aria-current={isCurrent ? "true" : undefined}
        className={`grid w-full grid-cols-[3.25rem_minmax(0,1fr)] gap-x-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors ${isCurrent ? "bg-fill-strong" : "hover:bg-fill"}`}
      >
        <span className="text-xs leading-5 text-fg-faint tabular">
          {formatTime(tUs)}
        </span>
        <span
          className={`min-w-0 leading-5 ${future ? "text-fg-muted" : "text-fg-soft"}`}
        >
          <span className="font-medium text-fg">{label}</span>
          {inferred && (
            <span className="ml-1.5 text-xs text-fg-muted">Inferred</span>
          )}
          <span className="ml-2">{text}</span>
        </span>
      </button>
    </li>
  );
});

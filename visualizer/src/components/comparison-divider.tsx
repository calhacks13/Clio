"use client";

import { memo, useCallback, useEffect, useRef } from "react";
import { LuGripVertical } from "react-icons/lu";
import {
  COMPARISON_DIVIDER_SIZE,
  clampComparisonSplit,
  comparisonSplitAt,
  comparisonSplitBounds,
} from "@/lib/replay-comparison";

const STORAGE_KEY = "clio-comparison-split";
const STACKED_QUERY = "(max-width: 559px)";

type SplitGeometry = { start: number; span: number; stacked: boolean };

function savedSplit() {
  try {
    const value = sessionStorage.getItem(STORAGE_KEY);
    const percent = value === null ? 50 : Number(value);
    return Number.isFinite(percent) ? percent : 50;
  } catch {
    return 50;
  }
}

export const ComparisonDivider = memo(function ComparisonDivider() {
  const separator = useRef<HTMLDivElement>(null);
  const percent = useRef(50);
  const geometry = useRef<SplitGeometry>({ start: 0, span: 0, stacked: false });
  const dragging = useRef(false);
  const grabOffset = useRef(0);
  const pending = useRef<number | null>(null);
  const frame = useRef<number | null>(null);
  const frozenSignals = useRef<{ element: HTMLElement; width: string } | null>(
    null,
  );

  const measure = useCallback(() => {
    const stage = separator.current?.parentElement;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const stacked = window.matchMedia(STACKED_QUERY).matches;
    geometry.current = {
      start: stacked ? rect.top : rect.left,
      span: stacked ? rect.height : rect.width,
      stacked,
    };
    const { min, max } = comparisonSplitBounds(geometry.current.span);
    separator.current?.setAttribute(
      "aria-orientation",
      stacked ? "horizontal" : "vertical",
    );
    separator.current?.setAttribute("aria-valuemin", String(Math.round(min)));
    separator.current?.setAttribute("aria-valuemax", String(Math.round(max)));
  }, []);

  // Pointer movement only writes once per paint; React and layout reads stay off this path.
  const apply = useCallback((next: number) => {
    const element = separator.current;
    const stage = element?.parentElement;
    if (!element || !stage) return;
    const value = clampComparisonSplit(next, geometry.current.span);
    percent.current = value;
    stage.style.setProperty("--comparison-ratio", String(value / 100));
    const rounded = Math.round(value);
    if (element.getAttribute("aria-valuenow") !== String(rounded)) {
      element.setAttribute("aria-valuenow", String(rounded));
      element.setAttribute(
        "aria-valuetext",
        `${rounded}% Replay, ${100 - rounded}% Data`,
      );
    }
  }, []);

  const flush = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    if (pending.current === null) return;
    const next = pending.current;
    pending.current = null;
    apply(next);
  }, [apply]);

  const remember = useCallback(() => {
    try {
      sessionStorage.setItem(STORAGE_KEY, String(percent.current));
    } catch {
      /* The layout still works when storage is blocked. */
    }
  }, []);

  const releaseSignals = useCallback(() => {
    const frozen = frozenSignals.current;
    if (!frozen) return;
    frozen.element.style.width = frozen.width;
    frozenSignals.current = null;
  }, []);

  const stopDragging = useCallback(() => {
    if (!dragging.current) return;
    dragging.current = false;
    flush();
    separator.current?.parentElement?.removeAttribute("data-resizing");
    separator.current?.classList.remove("is-dragging");
    // Reflow the dense plots once after the drag instead of on every pointer move.
    releaseSignals();
    remember();
  }, [flush, releaseSignals, remember]);

  useEffect(() => {
    const stage = separator.current?.parentElement;
    if (!stage) return;
    percent.current = savedSplit();
    const resize = () => {
      stopDragging();
      measure();
      apply(percent.current);
    };
    const observer = new ResizeObserver(resize);
    const query = window.matchMedia(STACKED_QUERY);
    observer.observe(stage);
    query.addEventListener("change", resize);
    window.addEventListener("blur", stopDragging);
    resize();
    return () => {
      observer.disconnect();
      query.removeEventListener("change", resize);
      window.removeEventListener("blur", stopDragging);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
      pending.current = null;
      dragging.current = false;
      releaseSignals();
      stage.style.removeProperty("--comparison-ratio");
      stage.removeAttribute("data-resizing");
    };
  }, [apply, measure, releaseSignals, stopDragging]);

  const reset = () => {
    flush();
    measure();
    apply(50);
    remember();
  };

  return (
    <div
      ref={separator}
      role="separator"
      tabIndex={0}
      className="comparison-divider"
      aria-label="Resize Replay and Data panes"
      aria-controls="comparison-replay comparison-data"
      aria-orientation="vertical"
      aria-valuemin={20}
      aria-valuemax={80}
      aria-valuenow={50}
      aria-valuetext="50% Replay, 50% Data"
      title="Drag or use arrow keys to resize. Double-click to reset."
      onDoubleClick={reset}
      onPointerDown={(event) => {
        if (event.button !== 0 || dragging.current) return;
        event.preventDefault();
        event.stopPropagation();
        measure();
        const { start, span, stacked } = geometry.current;
        const center =
          start +
          COMPARISON_DIVIDER_SIZE / 2 +
          ((span - COMPARISON_DIVIDER_SIZE) * percent.current) / 100;
        grabOffset.current = (stacked ? event.clientY : event.clientX) - center;
        const signals =
          !stacked &&
          event.currentTarget.parentElement?.querySelector<HTMLElement>(
            ".comparison-signals",
          );
        if (signals) {
          const width = signals.getBoundingClientRect().width;
          frozenSignals.current = {
            element: signals,
            width: signals.style.width,
          };
          signals.style.width = `${width}px`;
        }
        dragging.current = true;
        event.currentTarget.classList.add("is-dragging");
        event.currentTarget.parentElement?.setAttribute(
          "data-resizing",
          "true",
        );
        event.currentTarget.setPointerCapture(event.pointerId);
        event.currentTarget.focus({ preventScroll: true });
      }}
      onPointerMove={(event) => {
        if (!dragging.current) return;
        const { start, span, stacked } = geometry.current;
        pending.current = comparisonSplitAt(
          (stacked ? event.clientY : event.clientX) - grabOffset.current,
          start,
          span,
        );
        if (frame.current === null)
          frame.current = requestAnimationFrame(flush);
      }}
      onPointerUp={(event) => {
        stopDragging();
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={stopDragging}
      onLostPointerCapture={stopDragging}
      onKeyDown={(event) => {
        let next: number;
        const step = event.shiftKey ? 10 : 2;
        const { stacked, span } = geometry.current;
        const bounds = comparisonSplitBounds(span);
        if (event.key === (stacked ? "ArrowUp" : "ArrowLeft"))
          next = percent.current - step;
        else if (event.key === (stacked ? "ArrowDown" : "ArrowRight"))
          next = percent.current + step;
        else if (event.key === "Home") next = bounds.min;
        else if (event.key === "End") next = bounds.max;
        else if (event.key === "Enter") next = 50;
        else return;
        event.preventDefault();
        event.stopPropagation();
        flush();
        apply(next);
        remember();
      }}
    >
      <span className="comparison-divider-grip" aria-hidden="true">
        <LuGripVertical size={18} />
      </span>
    </div>
  );
});

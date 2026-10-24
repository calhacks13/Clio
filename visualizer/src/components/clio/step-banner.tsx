"use client";

import React from "react";
import { stepInfoAt } from "@/lib/clio/lanes";
import type { Capture } from "@clio-viewer/capture/model";

// The lesson step running at the viewed time, with its instruction as the
// headset showed it. Nothing before the first step.

export interface StepBannerProps {
  capture: Capture;
  tUs: number;
  className?: string;
}

export default function StepBanner({
  capture,
  tUs,
  className = "",
}: StepBannerProps) {
  const step = stepInfoAt(capture, tUs);
  if (!step) return null;
  return (
    <section
      className={`flex min-w-0 items-baseline gap-3 ${className}`}
      aria-label="Current step"
      aria-live="polite"
    >
      <span className="shrink-0 text-xs font-medium text-fg-muted tabular">
        {step.count
          ? `Step ${step.number} of ${step.count}`
          : `Step ${step.number}`}
      </span>
      <p className="min-w-0 text-[15px] font-medium leading-snug text-fg">
        {step.instruction}
      </p>
    </section>
  );
}

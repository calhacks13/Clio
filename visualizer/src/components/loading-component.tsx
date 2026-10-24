"use client";

import { ClioBrand } from "@/components/clio-brand";

export default function Loading() {
  return (
    <div
      className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-6 bg-bg text-fg"
      role="status"
      aria-live="polite"
    >
      <ClioBrand />
      <div className="flex items-center gap-3 text-sm text-fg-muted">
        <span
          className="h-4 w-4 animate-spin rounded-full border-2 border-line border-t-fg"
          aria-hidden="true"
        />
        Opening recording…
      </div>
    </div>
  );
}

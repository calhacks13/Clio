"use client";

import dynamic from "next/dynamic";

// /clio/live: follows the newest Clio recording and switches when a newer one
// starts; the address stays the same until Pin. The viewer needs WebGL and the
// browser's clock, so it loads on the client only.
const ClioReplayViewer = dynamic(
  () => import("@/components/clio/clio-replay-viewer"),
  { ssr: false },
);

export default function ClioLivePage() {
  return <ClioReplayViewer follow="live" />;
}

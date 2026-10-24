"use client";

import dynamic from "next/dynamic";
import { useParams } from "next/navigation";

// /clio/<id>: one Clio recording, followed while it grows; it never switches
// to another. The viewer needs WebGL and the browser's clock, so it loads on
// the client only.
const ClioReplayViewer = dynamic(
  () => import("@/components/clio/clio-replay-viewer"),
  { ssr: false },
);

/** The id as the server names it; an id that does not decode is left as it is. */
function decoded(id: string): string {
  try {
    return decodeURIComponent(id);
  } catch {
    return id;
  }
}

export default function ClioEpisodePage() {
  const { episodeId } = useParams<{ episodeId: string }>();
  const id = decoded(episodeId);
  return <ClioReplayViewer key={id} follow="pinned" episodeId={id} />;
}

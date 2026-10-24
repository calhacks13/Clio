"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import {
  ClioDerivedSource,
  type DerivedState,
  emptyDerivedState,
} from "@/lib/clio/derived";

// The compiled documents of the episode a Clio page shows, read beside its
// ClioSource and never through it: a new episode gets a new loader, and the
// raw source's polling is left exactly as it is.

const NONE = emptyDerivedState(null);
const noneSnapshot = () => NONE;
const noSubscribe = () => () => {};

export function useClioDerived(episodeId: string | null): DerivedState {
  const loader = useMemo(
    () => (episodeId ? new ClioDerivedSource({ episodeId }) : null),
    [episodeId],
  );
  useEffect(() => {
    if (!loader) return;
    loader.start();
    return () => loader.stop();
  }, [loader]);
  return useSyncExternalStore(
    loader?.subscribe ?? noSubscribe,
    loader?.getSnapshot ?? noneSnapshot,
    loader?.getSnapshot ?? noneSnapshot,
  );
}

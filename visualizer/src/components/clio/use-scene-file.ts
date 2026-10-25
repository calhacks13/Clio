"use client";

import type { Fetch } from "@clio-viewer/api";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import {
  type FileRef,
  type FileState,
  idleFile,
  LazyFile,
} from "@/lib/clio/scene-files";

// One binary file a layer draws (the room scan, an object's model), read through the proxy while
// the layer is mounted (scene-files.ts, LazyFile): a new version of the file gets a new reader, and
// unmounting stops the read and disposes what was parsed. The dev harness serves the files from
// memory through SceneFetchContext instead of a server.

/** Where scene files are fetched from; the browser's fetch when not provided. */
export const SceneFetchContext = createContext<Fetch | null>(null);

const noSubscribe = () => () => {};

/**
 * The file `file` names, parsed by `parse`, or idle while `file` is null. `parse` and `dispose`
 * must keep their identity (module-level functions): a new one would not read the file again.
 */
export function useSceneFile<T>(
  file: FileRef | null,
  parse: (bytes: ArrayBuffer) => Promise<T>,
  dispose: (value: T) => void,
): FileState<T> {
  const fetch = useContext(SceneFetchContext) ?? undefined;
  const url = file?.url ?? null;
  const key = file?.key ?? null;
  const loader = useMemo(
    () => (url && key ? new LazyFile<T>({ url, parse, dispose, fetch }) : null),
    // key covers the url and the file's version
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, parse, dispose, fetch],
  );
  useEffect(() => {
    if (!loader) return;
    loader.start();
    return () => loader.stop();
  }, [loader]);
  return useSyncExternalStore(
    loader?.subscribe ?? noSubscribe,
    loader?.getSnapshot ?? idleFile<T>,
    loader?.getSnapshot ?? idleFile<T>,
  );
}

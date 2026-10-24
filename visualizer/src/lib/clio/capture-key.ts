import type { Capture } from "@clio-viewer/capture/model";

// The Clio viewer mounts what draws a Capture (the 3D scene, the lanes, the
// event list, the inspector) once per capture: a new episode, or a rebuild of
// the same one, unmounts all of it. Drawing a new capture into the mounted
// components kept the old one reachable, about 100 MB for a 10-minute episode
// at 90 Hz: react-three-fiber keeps the first frame subscribers in its store's
// initial state, and closures that live as long as a component (dispose
// effects, callback refs, a ResizeObserver) keep the render scope they were
// made in, with the capture of that render. Unmounting drops them, and the
// layers' cleanups dispose their three.js objects.

const keys = new WeakMap<Capture, string>();
let made = 0;

/** The React key of what draws `capture`: the same for one capture, different for every other. */
export function captureKey(capture: Capture): string {
  let key = keys.get(capture);
  if (key === undefined) {
    key = `capture-${++made}`;
    keys.set(capture, key);
  }
  return key;
}

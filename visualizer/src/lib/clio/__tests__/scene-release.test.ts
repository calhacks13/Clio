import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import * as THREE from "three";
import { buildCaptureFromClio } from "@clio-viewer/capture/from-clio";
import type { Capture } from "@clio-viewer/capture/model";
import { syntheticEpisode } from "../__fixtures__/synthetic-episode";
import { captureKey } from "../capture-key";

// What the Clio viewer's 3D scene holds when it moves to another capture (a
// newer episode on /clio/live, or a rebuild of the same one), without a
// browser. The layers ClioScene draws (SceneLayers) render into a
// react-three-fiber root through a stand-in renderer, one root per capture
// key, as the viewer's <Canvas> is: the viewer mounts what draws a capture
// under captureKey, so the same key re-renders the canvas and a new key
// unmounts it and mounts another. Drawing a new capture into the same canvas
// kept the old one reachable (about 100 MB for 10 minutes at 90 Hz). drei's
// Html, Grid and OrbitControls need a DOM and are left out.

mock.module("@react-three/drei", () => ({
  Html: () => null,
  Grid: () => null,
  OrbitControls: () => null,
}));

const { advance, createRoot, extend } = await import("@react-three/fiber");
const { SceneLayers } = await import("@/components/clio/clio-scene");

type Root = ReturnType<typeof createRoot>;
type Store = ReturnType<Root["render"]>;

const START_EPOCH_MS = Date.UTC(2026, 9, 24, 12);
/** react-three-fiber lets an unmounted root go 500 ms after the unmount. */
const ROOT_RELEASE_MS = 600;

const clock = { getTimeUs: () => 2_000_000, subscribe: () => () => {} };

const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
let previousActEnvironment: boolean | undefined;
beforeAll(() => {
  previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  // <Canvas> registers the three.js classes; a bare root has to.
  extend(THREE as unknown as Parameters<typeof extend>[0]);
});
afterAll(() => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

function captureOf(episodeId: string, startEpochMs = START_EPOCH_MS): Capture {
  return buildCaptureFromClio(syntheticEpisode({ episodeId, startEpochMs }));
}

/** A renderer that draws nothing: the layers only need `render`. */
const fakeRenderer = () =>
  ({
    render() {},
    setSize() {},
    setPixelRatio() {},
    dispose() {},
    domElement: {},
  }) as unknown as THREE.WebGLRenderer;

const fakeCanvas = () =>
  ({
    style: {},
    addEventListener() {},
    removeEventListener() {},
  }) as unknown as HTMLCanvasElement;

/** The viewer's scene slot: one react-three-fiber root per capture key. */
class SceneSlot {
  key: string | null = null;
  root: Root | null = null;
  store: Store | null = null;
  mounted = 0;

  async show(capture: Capture, revision: number): Promise<void> {
    const key = captureKey(capture);
    if (key !== this.key) {
      await this.clear();
      const root = createRoot(fakeCanvas());
      await root.configure({
        gl: fakeRenderer(),
        size: { width: 640, height: 480, top: 0, left: 0 },
        frameloop: "never",
      });
      this.root = root;
      this.key = key;
      this.mounted++;
    }
    const root = this.root as Root;
    await act(async () => {
      this.store = root.render(
        createElement(SceneLayers, {
          capture,
          clock,
          revision,
          theme: "dark",
          debug: false,
          handsKeptFromUs: null,
          framesLoadedToUs: null,
          selectedId: null,
        }),
      );
    });
    // One frame, so every layer reads the capture as it draws.
    await act(async () => advance(performance.now()));
  }

  async clear(): Promise<void> {
    const root = this.root;
    if (!root) return;
    await act(async () => root.unmount());
    this.root = null;
    this.store = null;
    this.key = null;
  }
}

/** Every geometry and material drawn by the slot's current scene. */
function drawnResources(
  slot: SceneSlot,
): (THREE.BufferGeometry | THREE.Material)[] {
  const found = new Set<THREE.BufferGeometry | THREE.Material>();
  if (!slot.store) throw new Error("no scene mounted");
  slot.store.getState().scene.traverse((object) => {
    const drawn = object as Partial<THREE.Mesh>;
    if (drawn.geometry) found.add(drawn.geometry);
    const materials = drawn.material;
    for (const m of Array.isArray(materials)
      ? materials
      : materials
        ? [materials]
        : []) {
      found.add(m);
    }
  });
  return [...found];
}

/** Collects garbage until `ref` is cleared, or gives up after a few rounds. */
async function released(ref: WeakRef<object>): Promise<boolean> {
  for (let i = 0; i < 20 && ref.deref() !== undefined; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    Bun.gc(true);
  }
  return ref.deref() === undefined;
}

describe("the scene on a switch of capture", () => {
  test("a capture keeps its key across revisions; another capture, or a rebuild of the same episode, gets a new one", () => {
    const a = captureOf("ep-20261024-120000-aaaa");
    const rebuilt = captureOf("ep-20261024-120000-aaaa");
    expect(captureKey(a)).toBe(captureKey(a));
    expect(captureKey(rebuilt)).not.toBe(captureKey(a));
    expect(captureKey(captureOf("ep-20261024-120100-bbbb"))).not.toBe(
      captureKey(a),
    );
  });

  test("new records for the same capture re-render the scene in place", async () => {
    const slot = new SceneSlot();
    const capture = captureOf("ep-20261024-120000-aaaa");
    await slot.show(capture, 0);
    await slot.show(capture, 1);
    expect(slot.mounted).toBe(1);
    await slot.clear();
  });

  test("the old capture is released and its scene's three.js objects are disposed", async () => {
    const slot = new SceneSlot();
    // Captures are made inside functions, so no local variable here holds them.
    const { old, resources } = await (async () => {
      const a = captureOf("ep-20261024-120000-aaaa");
      await slot.show(a, 0);
      await slot.show(a, 1);
      return { old: new WeakRef(a), resources: drawnResources(slot) };
    })();
    expect(resources.length).toBeGreaterThan(10);
    const disposed = new Set<object>();
    for (const r of resources) {
      r.addEventListener("dispose", () => disposed.add(r));
    }

    await (async () => {
      const b = captureOf("ep-20261024-120100-bbbb", START_EPOCH_MS + 60_000);
      await slot.show(b, 2);
      await slot.show(b, 3);
    })();
    expect(slot.mounted).toBe(2);
    expect(resources.filter((r) => !disposed.has(r))).toEqual([]);

    await new Promise((resolve) => setTimeout(resolve, ROOT_RELEASE_MS));
    expect(await released(old)).toBe(true);
    await slot.clear();
  });
});

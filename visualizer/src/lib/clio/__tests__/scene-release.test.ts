import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import * as THREE from "three";
import type { Fetch } from "@clio-viewer/api";
import { buildCaptureFromClio, rosFromW } from "@clio-viewer/capture/from-clio";
import type { Capture, Vec3 } from "@clio-viewer/capture/model";
import type { SceneLayersProps } from "@/components/clio/clio-scene";
import { BACKDROP_LAYER } from "@/components/clio/layers/gltf";
import { SOLID_PROGRAM } from "@/components/clio/layers/solid";
import { SceneFetchContext } from "@/components/clio/use-scene-file";
import { syntheticDerived } from "../__fixtures__/synthetic-derived";
import {
  SYNTHETIC_TIMES,
  syntheticEpisode,
} from "../__fixtures__/synthetic-episode";
import {
  nodePoint,
  syntheticRoom,
  syntheticScene,
  withRoom,
} from "../__fixtures__/synthetic-scene";
import { captureKey } from "../capture-key";
import { compiledObjectAt } from "../compiled-objects";
import { modelFiles, roomFile } from "../scene-files";
import { modelPlacement, modelPointInRos } from "../scene-display";

// What the Clio viewer's 3D scene holds when it moves to another capture (a
// newer episode on /clio/live, or a rebuild of the same one), without a
// browser. The layers ClioScene draws (SceneLayers) render into a
// react-three-fiber root through a stand-in renderer, one root per capture
// key, as the viewer's <Canvas> is: the viewer mounts what draws a capture
// under captureKey, so the same key re-renders the canvas and a new key
// unmounts it and mounts another. Drawing a new capture into the same canvas
// kept the old one reachable (about 100 MB for 10 minutes at 90 Hz). drei's
// Html, Grid and OrbitControls need a DOM and are left out. The compiled case
// checks that objects follow tracks.json, vanish where it has no position and
// that their extent boxes and shape points are disposed with the rest. The
// rebuilt case reads the room scan and the generated models through the
// scene's fetch, as the viewer does through the proxy, and checks where they
// land, that a hidden toggle reads nothing and that both are disposed. The
// environment's raised planes are solid tops on the backdrop layer while no
// room is drawn, and only outlines while one is.

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

  async show(
    capture: Capture,
    revision: number,
    extra: Partial<SceneLayersProps> = {},
    fetch: Fetch | null = null,
  ): Promise<void> {
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
        createElement(
          SceneFetchContext.Provider,
          { value: fetch },
          createElement(SceneLayers, {
            capture,
            clock,
            revision,
            theme: "dark",
            debug: false,
            handsKeptFromUs: null,
            framesLoadedToUs: null,
            selectedId: null,
            ...extra,
          }),
        ),
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

/** The solid materials' meshes in the slot's scene, by program: the raised tops and the table tops. */
function solidMeshes(slot: SceneSlot, program: string): THREE.Mesh[] {
  const found: THREE.Mesh[] = [];
  slot.store?.getState().scene.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const material = object.material as THREE.Material;
    if (material.customProgramCacheKey() === program) found.push(object);
  });
  return found;
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

describe("the scene with a compiled episode", () => {
  const episode = syntheticEpisode({
    episodeId: "ep-20261024-120000-cccc",
    startEpochMs: START_EPOCH_MS,
    recordedGrasps: true,
  });
  const capture = buildCaptureFromClio(episode);
  const compiled = syntheticDerived(episode);
  const docs = { tracks: compiled.tracks, shapes: compiled.shapes };
  const at = (tUs: number) => ({
    getTimeUs: () => tUs,
    subscribe: () => () => {},
  });

  test("objects follow the compiled series and vanish where it has no position", async () => {
    const slot = new SceneSlot();
    const syringe = () => {
      const scene = slot.store?.getState().scene;
      if (!scene) throw new Error("no scene mounted");
      return scene.getObjectByName("syringe") as THREE.Object3D;
    };
    // Mid-carry, inside the grid: at the compiled position.
    const carriedUs = 4_000_000;
    await slot.show(capture, 0, { ...docs, clock: at(carriedUs) });
    const expected = compiledObjectAt(compiled.tracks, "syringe", carriedUs);
    if (!expected) throw new Error("the syringe is compiled mid-carry");
    expect(syringe().visible).toBe(true);
    expect(syringe().position.toArray()).toEqual(expected.position);
    // While the headset had lost it, the compiled position is null: nothing is
    // drawn, not the raw pose the compile rejected.
    const { start, end } = SYNTHETIC_TIMES.dropout;
    const lostUs = Math.round(((start + end) / 2) * 1000);
    await slot.show(capture, 1, { ...docs, clock: at(lostUs) });
    expect(compiledObjectAt(compiled.tracks, "syringe", lostUs)).toBeNull();
    expect(syringe().visible).toBe(false);
    // Past the grid's end the compiled object shows nothing, where the raw
    // path keeps the last pose.
    const afterUs = capture.endUs + 2_000_000;
    await slot.show(capture, 2, { ...docs, clock: at(afterUs) });
    expect(syringe().visible).toBe(false);
    await slot.show(capture, 3, { clock: at(afterUs) });
    expect(syringe().visible).toBe(true);
    await slot.clear();
  });

  test("raised planes are solid tops and, with the table top, draw on the backdrop layer", async () => {
    const slot = new SceneSlot();
    const environment = compiled.environment;
    await slot.show(capture, 0, {
      environment,
      backdrop: true,
      clock: at(4_000_000),
    });
    // The table and the shelf; not the floor or the wall.
    const raised = solidMeshes(slot, SOLID_PROGRAM.biased);
    expect(raised.length).toBe(2);
    const tops = solidMeshes(slot, SOLID_PROGRAM.plain);
    // The workspace top (hidden: the compiled table replaces it) and the compiled table's.
    expect(tops.length).toBe(2);
    for (const mesh of [...raised, ...tops]) {
      expect(mesh.layers.mask).toBe(1 << BACKDROP_LAYER);
      const material = mesh.material as THREE.Material;
      expect(material.transparent).toBe(false);
    }
    for (const mesh of raised) expect(mesh.visible).toBe(true);
    // Without a backdrop everything stays on the default layer.
    await slot.show(capture, 1, {
      environment,
      backdrop: false,
      clock: at(4_000_000),
    });
    for (const mesh of [...raised, ...tops]) expect(mesh.layers.mask).toBe(1);
    const resources = drawnResources(slot);
    const disposed = new Set<object>();
    for (const r of resources) {
      r.addEventListener("dispose", () => disposed.add(r));
    }
    await slot.clear();
    expect(resources.filter((r) => !disposed.has(r))).toEqual([]);
  });

  test("the extent boxes and shape points are disposed with the rest", async () => {
    const slot = new SceneSlot();
    await slot.show(capture, 0, { ...docs, clock: at(4_000_000) });
    const resources = drawnResources(slot);
    expect(resources.some((r) => r instanceof THREE.PointsMaterial)).toBe(true);
    // The syringe's extent box and its shape's box.
    expect(
      resources.filter((r) => r instanceof THREE.EdgesGeometry).length,
    ).toBeGreaterThanOrEqual(2);
    const disposed = new Set<object>();
    for (const r of resources) {
      r.addEventListener("dispose", () => disposed.add(r));
    }
    await slot.clear();
    expect(resources.filter((r) => !disposed.has(r))).toEqual([]);
  });
});

describe("the scene with the room scan and generated models", () => {
  const episode = syntheticEpisode({
    episodeId: "ep-20261024-120000-dddd",
    startEpochMs: START_EPOCH_MS,
    recordedGrasps: true,
  });
  const id = episode.meta.episodeId;
  const capture = buildCaptureFromClio(episode);
  const compiled = syntheticDerived(episode);
  const room = syntheticRoom(episode);
  const scene = syntheticScene(episode, compiled.manifest);
  const state = {
    episodeId: id,
    environment: withRoom(compiled.environment, room),
    compiledAt: compiled.manifest.compiledAt,
    scene: scene.doc,
  };
  const at = (tUs: number) => ({
    getTimeUs: () => tUs,
    subscribe: () => () => {},
  });

  /** The proxy URLs answered from memory, every request kept. */
  function files() {
    const served = new Map<string, Uint8Array>([
      [`/api/clio/episodes/${id}/derived/room.glb`, room.glb],
      ...Object.entries(scene.files).map(
        ([name, bytes]) =>
          [`/api/clio/episodes/${id}/scene/${name}`, bytes] as const,
      ),
    ]);
    const requests: string[] = [];
    const fetch: Fetch = async (input) => {
      requests.push(input);
      const bytes = served.get(input);
      return bytes
        ? new Response(bytes.slice().buffer)
        : new Response("Not found", { status: 404 });
    };
    return { fetch, requests };
  }

  /** Lets the reads and parses finish, then draws a frame. */
  async function settle(slot: SceneSlot, until: () => boolean): Promise<void> {
    for (let i = 0; i < 50 && !until(); i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
    }
    await act(async () => advance(performance.now()));
    if (!until()) throw new Error("the scene files never arrived");
    expect(slot.store).not.toBeNull();
  }

  const find = (slot: SceneSlot, name: string) =>
    slot.store?.getState().scene.getObjectByName(name) ?? null;
  /** A point in the scene's ROS group's frame (the layers' root). */
  const inRos = (
    slot: SceneSlot,
    object: THREE.Object3D,
    local: THREE.Vector3,
  ) => {
    const scene = slot.store?.getState().scene;
    const ros = scene?.children[0];
    if (!ros) throw new Error("no ROS group");
    scene.updateMatrixWorld(true);
    return ros.worldToLocal(object.localToWorld(local.clone())).toArray();
  };
  const expectClose = (
    actual: readonly number[],
    expected: readonly number[],
  ) => actual.forEach((v, i) => expect(v).toBeCloseTo(expected[i], 5));

  test("the room scan lands in W through the turn, and a model on its object's compiled position", async () => {
    const slot = new SceneSlot();
    const { fetch } = files();
    const tUs = 11_000_000;
    await slot.show(
      capture,
      0,
      {
        tracks: compiled.tracks,
        shapes: compiled.shapes,
        room: roomFile(state, true),
        models: modelFiles(state, true),
        clock: at(tUs),
      },
      fetch,
    );
    await settle(
      slot,
      () => Boolean(find(slot, "room-scan")) && Boolean(find(slot, "barrel")),
    );

    // A furniture volume's corner, by its node transform in W.
    const couch = find(slot, "mesh-3") as THREE.Mesh;
    const position = couch.geometry.getAttribute("position");
    const corner = new THREE.Vector3().fromBufferAttribute(position, 0);
    expectClose(
      inRos(slot, couch, corner),
      rosFromW(nodePoint(room.nodes[2], corner.toArray() as Vec3)),
    );

    // A model vertex: the compiled position, then the placement, then the GLB.
    const syringe = compiledObjectAt(compiled.tracks, "syringe", tUs);
    if (!syringe) throw new Error("the syringe is compiled at 11 s");
    const barrel = find(slot, "barrel") as THREE.Mesh;
    const v = new THREE.Vector3().fromBufferAttribute(
      barrel.geometry.getAttribute("position"),
      3,
    );
    const model = scene.doc.objects[0];
    expectClose(
      inRos(slot, barrel, v),
      modelPointInRos(
        syringe.position,
        modelPlacement(model),
        v.toArray() as Vec3,
      ),
    );
    await slot.clear();
  });

  test("with the room drawn, raised planes keep only their outlines", async () => {
    const slot = new SceneSlot();
    const { fetch } = files();
    await slot.show(
      capture,
      0,
      {
        environment: state.environment,
        room: roomFile(state, true),
        clock: at(11_000_000),
      },
      fetch,
    );
    await settle(slot, () => Boolean(find(slot, "room-scan")));
    // The scan's own surfaces are solid too; the planes' tops are there but hidden.
    const planeTops = solidMeshes(slot, SOLID_PROGRAM.biased).filter((mesh) => {
      for (let p: THREE.Object3D | null = mesh; p; p = p.parent) {
        if (p.name === "room-scan") return false;
      }
      return true;
    });
    expect(planeTops.length).toBe(2);
    for (const mesh of planeTops) {
      expect(mesh.visible).toBe(false);
      expect(mesh.layers.mask).toBe(1 << BACKDROP_LAYER);
    }
    await slot.clear();
  });

  test("a model hides where its object's compiled position is null", async () => {
    const slot = new SceneSlot();
    const { fetch } = files();
    const props = {
      tracks: compiled.tracks,
      shapes: compiled.shapes,
      models: modelFiles(state, true),
    };
    await slot.show(capture, 0, { ...props, clock: at(4_000_000) }, fetch);
    await settle(slot, () => Boolean(find(slot, "barrel")));
    const visible = (o: THREE.Object3D | null) => {
      let shown = true;
      for (let p = o; p; p = p.parent) shown &&= p.visible;
      return shown;
    };
    expect(visible(find(slot, "barrel"))).toBe(true);
    const { start, end } = SYNTHETIC_TIMES.dropout;
    await slot.show(
      capture,
      1,
      { ...props, clock: at(Math.round(((start + end) / 2) * 1000)) },
      fetch,
    );
    expect(visible(find(slot, "barrel"))).toBe(false);
    await slot.clear();
  });

  test("nothing is read while the Room and Models toggles are off, or without a compiled series", async () => {
    const slot = new SceneSlot();
    const { fetch, requests } = files();
    await slot.show(
      capture,
      0,
      {
        tracks: compiled.tracks,
        room: roomFile(state, false),
        models: modelFiles(state, false),
        clock: at(11_000_000),
      },
      fetch,
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(requests).toEqual([]);
    // Models are placed from the compiled series only: without it, none is drawn.
    await slot.show(
      capture,
      1,
      { models: modelFiles(state, true), clock: at(11_000_000) },
      fetch,
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(requests).toEqual([]);
    expect(find(slot, "barrel")).toBeNull();
    await slot.clear();
  });

  test("the room and the models are disposed when hidden and with the scene", async () => {
    const slot = new SceneSlot();
    const { fetch } = files();
    const props = {
      tracks: compiled.tracks,
      shapes: compiled.shapes,
      room: roomFile(state, true),
      models: modelFiles(state, true),
      clock: at(11_000_000),
    };
    await slot.show(capture, 0, props, fetch);
    await settle(
      slot,
      () => Boolean(find(slot, "room-scan")) && Boolean(find(slot, "barrel")),
    );
    const under = (roots: (THREE.Object3D | null | undefined)[]) => {
      const found = new Set<THREE.BufferGeometry | THREE.Material>();
      for (const root of roots) {
        root?.traverse((object) => {
          const drawn = object as Partial<THREE.Mesh>;
          if (drawn.geometry) found.add(drawn.geometry);
          const m = drawn.material;
          for (const material of Array.isArray(m) ? m : m ? [m] : []) {
            found.add(material);
          }
        });
      }
      return [...found];
    };
    const room = under([find(slot, "room-scan")]);
    // The models' own: the objects' outline materials go with the objects.
    const models = under(
      ["syringe", "cup_a", "indicator"].map((n) =>
        find(slot, n)?.getObjectByName("model"),
      ),
    ).filter((r) => !(r instanceof THREE.LineBasicMaterial && r.transparent));
    expect(room.filter((r) => r instanceof THREE.EdgesGeometry).length).toBe(5);
    expect(
      models.filter((r) => r instanceof THREE.MeshLambertMaterial).length,
    ).toBeGreaterThanOrEqual(3);
    const all = [...room, ...models];
    const disposed = new Set<object>();
    for (const r of all) r.addEventListener("dispose", () => disposed.add(r));

    // Models off: theirs go, the room stays.
    await slot.show(
      capture,
      1,
      { ...props, models: modelFiles(state, false) },
      fetch,
    );
    for (const m of models) expect(disposed.has(m)).toBe(true);
    expect(find(slot, "barrel")).toBeNull();
    expect(find(slot, "room-scan")).not.toBeNull();

    await slot.clear();
    expect(all.filter((r) => !disposed.has(r))).toEqual([]);
  });
});

"use client";

import { Grid, OrbitControls } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import type {
  EnvironmentDoc,
  BodyDoc,
  RetargetDoc,
  ShapesDoc,
  TracksDoc,
} from "@clio/protocol";
import type { Fetch } from "@clio-viewer/api";
import type { Capture } from "@clio-viewer/capture/model";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { DirectionalLight, HemisphereLight, NoToneMapping } from "three";
import { SCENE_COLORS, themed } from "@/lib/clio/object-display";
import type { FileRef, ModelFile } from "@/lib/clio/scene-files";
import { ROS_TO_RENDER } from "@/lib/scene";
import { useTheme, type Theme } from "@/utils/theme";
import { DetectionsLayer } from "./layers/detections";
import {
  EnvironmentLayer,
  raisedPlanes,
  workspaceBounds,
} from "./layers/environment";
import { BACKDROP_LAYER } from "./layers/gltf";
import { HandsLayer } from "./layers/hands";
import { HeadLayer } from "./layers/head";
import { ObjectsLayer } from "./layers/objects";
import { BodyLayer } from "./layers/body";
import { RobotLayer } from "./layers/robot";
import { RoomLayer } from "./layers/room";
import { SceneFetchContext } from "./use-scene-file";

// The Clio episode in 3D at one recording time. Every layer draws the Capture's ROS frame (z up,
// meters) inside the single group below, which turns ROS into the renderer's y-up frame at scale 1;
// no layer converts coordinates again. The canvas renders on demand: a new time from the clock, new
// records (a revision), a theme or selection change, or the camera moving. A scene draws one
// capture for its whole life: the viewer mounts a new one for a new capture (capture-key.ts).
// Compiled documents (derived.ts), when there are any, add the detected planes and retargeted
// robot arms, and the objects follow their compiled series, extents and shapes instead of the raw
// estimates; they are in W like the raw episode and reach ROS once, in derived-display.ts and
// compiled-objects.ts.
//
// The Quest room scan (layers/room.tsx) and each object's generated model (layers/model.tsx) are
// binary files read only while their toggle is on (scene-files.ts). The room is solid context: its
// surfaces, and the detected raised planes drawn solid when there is no room (environment.tsx), go
// on the backdrop layer, and so, while there is a backdrop, do the grid and the rest of the
// environment's context, tested against the room's depth so a wall hides the grid lines beyond it
// (layers/solid.ts). BackdropPass draws that layer first and everything measured over it with a
// fresh depth buffer, so the room never hides the hands, the head, the objects or the robots; the
// grid also fades out nearer, around the table, so it does not lie across the whole room.

/** Where the scene reads the viewed time: integer microseconds of recording time. */
export interface SceneClock {
  getTimeUs(): number;
  /** Calls `onChange` whenever the time changes; returns the unsubscribe. */
  subscribe(onChange: () => void): () => void;
}

/** What every layer gets. */
export interface LayerProps {
  capture: Capture;
  clock: SceneClock;
  /** Bumps when records arrive, so layers pick up new objects. */
  revision: number;
  theme: Theme;
  debug: boolean;
}

export interface ClioSceneProps {
  capture: Capture;
  revision: number;
  clock: SceneClock;
  /** Hand samples before this time were let go (live retention): no hands are drawn there. */
  handsKeptFromUs?: number | null;
  /**
   * Frames after this time were not loaded (a replay stopped by the frames cap): no hands or head
   * are drawn there.
   */
  framesLoadedToUs?: number | null;
  /** Shows the origin axes and the "table corner" and "floor from calibration" labels. */
  debug?: boolean;
  selectedId?: string | null;
  onSelect?: (entityId: string) => void;
  /** Sizes and places the canvas's box; it fills its parent by default. Labels need it positioned. */
  className?: string;
  /** The compiled environment: planes, table and floor. Without it, the calibrated context. */
  environment?: EnvironmentDoc | null;
  /** The compiled object series: objects follow it, with their extents, instead of the raw estimates. */
  tracks?: TracksDoc | null;
  /** Each object's measured shape, riding with its compiled position. */
  shapes?: ShapesDoc | null;
  /** Retargeted robots, one document per profile. */
  retarget?: readonly RetargetDoc[];
  /** Draws the retargeted robots (default true). */
  showRobot?: boolean;
  /** The G1 posed from the head and hands. */
  body?: BodyDoc | null;
  /** The room scan to draw (scene-files.ts, roomFile); null draws none. */
  room?: FileRef | null;
  /** Generated models by object id (scene-files.ts, modelFiles). */
  models?: ReadonlyMap<string, ModelFile>;
  /** Fetches the room scan and the models; the browser's fetch by default (the dev harness serves them). */
  sceneFetch?: Fetch;
}

const NO_RETARGET: readonly RetargetDoc[] = [];
const NO_MODELS: ReadonlyMap<string, ModelFile> = new Map();
/** How far from the camera the grid fades out, without and with the room drawn around it. */
const GRID_FADE = 4;
const GRID_FADE_IN_ROOM = 2.2;

/**
 * A SceneClock showing `tUs`. It is the same object for the component's life, so passing it does
 * not re-render the scene; it tells its subscribers when `tUs` changes and the canvas draws a frame.
 */
export function useSceneClock(tUs: number): SceneClock {
  const state = useRef({ tUs, listeners: new Set<() => void>() });
  const clock = useMemo<SceneClock>(
    () => ({
      getTimeUs: () => state.current.tUs,
      subscribe: (onChange) => {
        const { listeners } = state.current;
        listeners.add(onChange);
        return () => {
          listeners.delete(onChange);
        };
      },
    }),
    [],
  );
  useLayoutEffect(() => {
    if (state.current.tUs === tUs) return;
    state.current.tUs = tUs;
    for (const onChange of state.current.listeners) onChange();
  }, [tUs]);
  return clock;
}

/** Renders a frame whenever the time, the records or what is shown changes. */
function Invalidator({
  clock,
  deps,
}: {
  clock: SceneClock;
  deps: readonly unknown[];
}) {
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => clock.subscribe(() => invalidate()), [clock, invalidate]);
  useEffect(() => {
    invalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invalidate, ...deps]);
  return null;
}

/** ROS (x, y, z) in the renderer's frame: (x, z, -y). Only for the camera, outside the group. */
const toRender = ([x, y, z]: readonly number[]): [number, number, number] => [
  x,
  z,
  -y,
];

export default function ClioScene({
  capture,
  revision,
  clock,
  handsKeptFromUs = null,
  framesLoadedToUs = null,
  debug = false,
  selectedId = null,
  onSelect,
  className,
  environment = null,
  tracks = null,
  shapes = null,
  retarget = NO_RETARGET,
  showRobot = true,
  body = null,
  room = null,
  models = NO_MODELS,
  sceneFetch,
}: ClioSceneProps) {
  const theme = useTheme();
  // Frame the table from behind and above the learner, who stands at ROS x < 0 facing +x.
  // With a posed G1 the learner's spot holds a solid robot, which would fill a view from behind it:
  // frame the robot and the table together from a three-quarter view off the learner's right.
  const posed = body !== null;
  const view = useMemo(() => {
    const { center, size } = workspaceBounds(capture);
    const reach = Math.max(size[0], size[1], 0.4);
    if (posed) {
      const span = Math.max(reach, 0.9);
      const target = [center[0] - 0.3 * span, center[1], center[2] + 0.2];
      return {
        target: toRender(target),
        position: toRender([
          target[0] + 0.9 * span,
          target[1] - 1.85 * span,
          target[2] + 0.95 * span,
        ]),
      };
    }
    return {
      target: toRender(center),
      position: toRender([
        center[0] - 1.35 * reach,
        center[1] - 0.55 * reach,
        center[2] + 1.15 * reach,
      ]),
    };
  }, [capture, posed]);
  const camera = useMemo(
    () => ({ position: view.position, fov: 45, near: 0.01, far: 50 }),
    // The camera is placed once; CameraRig aims it below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const layer: LayerProps = { capture, clock, revision, theme, debug };
  // Context draws as a backdrop while there is a room, or a detected top drawn solid without one.
  const backdrop = useMemo(
    () =>
      room !== null ||
      (environment !== null && raisedPlanes(environment, capture).length > 0),
    [room, environment, capture],
  );

  return (
    <div className={className ?? "relative h-full w-full"}>
      <Canvas
        frameloop="demand"
        flat
        camera={camera}
        gl={{ toneMapping: NoToneMapping }}
      >
        <color
          attach="background"
          args={[themed(SCENE_COLORS.canvas, theme)]}
        />
        <Invalidator
          clock={clock}
          deps={[
            capture,
            revision,
            theme,
            debug,
            selectedId,
            handsKeptFromUs,
            framesLoadedToUs,
            environment,
            tracks,
            shapes,
            retarget,
            showRobot,
            body,
            room,
            models,
          ]}
        />
        {backdrop && <BackdropPass />}
        <CameraRig position={view.position} target={view.target} />
        {/* The table plane: ROS z = 0 is the renderer's y = 0. */}
        <Grid
          args={[4, 4]}
          cellSize={0.05}
          cellThickness={0.5}
          cellColor={themed(SCENE_COLORS.gridCell, theme)}
          sectionSize={0.25}
          sectionThickness={1}
          sectionColor={themed(SCENE_COLORS.gridSection, theme)}
          fadeDistance={room ? GRID_FADE_IN_ROOM : GRID_FADE}
          infiniteGrid
          layers={backdrop ? BACKDROP_LAYER : 0}
        />
        <SceneFetchContext.Provider value={sceneFetch ?? null}>
          <SceneLayers
            {...layer}
            handsKeptFromUs={handsKeptFromUs}
            framesLoadedToUs={framesLoadedToUs}
            selectedId={selectedId}
            onSelect={onSelect}
            environment={environment}
            tracks={tracks}
            shapes={shapes}
            retarget={retarget}
            showRobot={showRobot}
            body={body}
            room={room}
            models={models}
            backdrop={backdrop}
          />
        </SceneFetchContext.Provider>
        <OrbitControls makeDefault target={view.target} />
      </Canvas>
    </div>
  );
}

export interface SceneLayersProps extends LayerProps {
  handsKeptFromUs: number | null;
  framesLoadedToUs: number | null;
  selectedId: string | null;
  onSelect?: (entityId: string) => void;
  environment?: EnvironmentDoc | null;
  tracks?: TracksDoc | null;
  shapes?: ShapesDoc | null;
  retarget?: readonly RetargetDoc[];
  showRobot?: boolean;
  body?: BodyDoc | null;
  room?: FileRef | null;
  models?: ReadonlyMap<string, ModelFile>;
  /** Context draws on the backdrop layer (ClioScene decides; the room needs it). */
  backdrop?: boolean;
}

/** Every layer of one capture, inside the group that turns ROS into the renderer's frame. */
export function SceneLayers({
  handsKeptFromUs,
  framesLoadedToUs,
  selectedId,
  onSelect,
  environment = null,
  tracks = null,
  shapes = null,
  retarget = NO_RETARGET,
  showRobot = true,
  body = null,
  room = null,
  models = NO_MODELS,
  backdrop = room !== null,
  ...layer
}: SceneLayersProps) {
  // The posed G1 stands where the learner stood; a made-up example arm there only gets in its way.
  // Arms of a real robot profile still draw beside it.
  const arms = useMemo(
    () => (body ? retarget.filter((doc) => !doc.profile.example) : retarget),
    [body, retarget],
  );
  return (
    <group quaternion={ROS_TO_RENDER}>
      <SceneLights theme={layer.theme} />
      {room && (
        <RoomLayer file={room} theme={layer.theme} debug={layer.debug} />
      )}
      <EnvironmentLayer
        {...layer}
        environment={environment}
        backdrop={backdrop}
        fillRaised={room === null}
      />
      <HeadLayer {...layer} framesLoadedToUs={framesLoadedToUs} />
      <HandsLayer
        {...layer}
        handsKeptFromUs={handsKeptFromUs}
        framesLoadedToUs={framesLoadedToUs}
      />
      <ObjectsLayer
        {...layer}
        selectedId={selectedId}
        onSelect={onSelect}
        tracks={tracks}
        shapes={shapes}
        models={models}
      />
      <DetectionsLayer {...layer} />
      {showRobot && arms.length > 0 && (
        <RobotLayer {...layer} retarget={arms} />
      )}
      {showRobot && body && <BodyLayer {...layer} body={body} />}
    </group>
  );
}

/**
 * The light the room scan and the generated models are shaded by; every other layer is unlit. A
 * bright sky-to-ground fill and a soft key from behind the learner's left shoulder, on both layers,
 * so surfaces read by their facing without going dark. In ROS: z up.
 */
function SceneLights({ theme }: { theme: Theme }) {
  const lights = useMemo(() => {
    const fill = new HemisphereLight();
    fill.position.set(0, 0, 1);
    const key = new DirectionalLight();
    key.position.set(-1.2, 0.8, 2.4);
    for (const light of [fill, key]) light.layers.enable(BACKDROP_LAYER);
    return { fill, key };
  }, []);
  useEffect(
    () => () => {
      lights.fill.dispose();
      lights.key.dispose();
    },
    [lights],
  );
  // Up-facing surfaces near their own color, walls a little below, the ground side not dark.
  const dark = theme === "dark";
  lights.fill.color.set("#ffffff");
  lights.fill.groundColor.set(dark ? "#b4b9c2" : "#f0f2f5");
  lights.fill.intensity = 2.9;
  lights.key.intensity = 0.6;
  return (
    <>
      <primitive object={lights.fill} />
      <primitive object={lights.key} />
    </>
  );
}

/**
 * Draws the backdrop layer (the room scan or the solid detected tops, with the grid and the
 * environment's context) first, then everything else over it with a cleared depth buffer, so
 * context never hides measured data. Mounted only while there is a backdrop; it takes over
 * react-three-fiber's render for that time.
 */
function BackdropPass() {
  useFrame(({ gl, scene, camera }) => {
    const { background } = scene;
    const autoClear = gl.autoClear;
    camera.layers.set(BACKDROP_LAYER);
    gl.render(scene, camera);
    gl.autoClear = false;
    gl.clearDepth();
    // A color background would clear the room away again.
    scene.background = null;
    camera.layers.set(0);
    gl.render(scene, camera);
    scene.background = background;
    gl.autoClear = autoClear;
  }, 1);
  return null;
}

/** Points the camera at the table. */
function CameraRig({
  position,
  target,
}: {
  position: [number, number, number];
  target: [number, number, number];
}) {
  const camera = useThree((s) => s.camera);
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    camera.position.set(...position);
    camera.lookAt(...target);
    invalidate();
  }, [camera, invalidate, position, target]);
  return null;
}

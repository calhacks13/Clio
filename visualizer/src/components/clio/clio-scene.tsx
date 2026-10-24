"use client";

import { Grid, OrbitControls } from "@react-three/drei";
import { Canvas, useThree } from "@react-three/fiber";
import type { Capture } from "@clio-viewer/capture/model";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { NoToneMapping } from "three";
import { SCENE_COLORS, themed } from "@/lib/clio/object-display";
import { ROS_TO_RENDER } from "@/lib/scene";
import { useTheme, type Theme } from "@/utils/theme";
import { DetectionsLayer } from "./layers/detections";
import { EnvironmentLayer, workspaceBounds } from "./layers/environment";
import { HandsLayer } from "./layers/hands";
import { HeadLayer } from "./layers/head";
import { ObjectsLayer } from "./layers/objects";

// The Clio episode in 3D at one recording time. Every layer draws the Capture's ROS frame (z up,
// meters) inside the single group below, which turns ROS into the renderer's y-up frame at scale 1;
// no layer converts coordinates again. The canvas renders on demand: a new time from the clock, new
// records (a revision), a theme or selection change, or the camera moving. A scene draws one
// capture for its whole life: the viewer mounts a new one for a new capture (capture-key.ts).

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
}

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
}: ClioSceneProps) {
  const theme = useTheme();
  // Frame the table from behind and above the learner, who stands at ROS x < 0 facing +x.
  const view = useMemo(() => {
    const { center, size } = workspaceBounds(capture);
    const reach = Math.max(size[0], size[1], 0.4);
    return {
      target: toRender(center),
      position: toRender([
        center[0] - 1.35 * reach,
        center[1] - 0.55 * reach,
        center[2] + 1.15 * reach,
      ]),
    };
  }, [capture]);
  const camera = useMemo(
    () => ({ position: view.position, fov: 45, near: 0.01, far: 50 }),
    // The camera is placed once; CameraRig aims it below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const layer: LayerProps = { capture, clock, revision, theme, debug };

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
          ]}
        />
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
          fadeDistance={4}
          infiniteGrid
        />
        <SceneLayers
          {...layer}
          handsKeptFromUs={handsKeptFromUs}
          framesLoadedToUs={framesLoadedToUs}
          selectedId={selectedId}
          onSelect={onSelect}
        />
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
}

/** Every layer of one capture, inside the group that turns ROS into the renderer's frame. */
export function SceneLayers({
  handsKeptFromUs,
  framesLoadedToUs,
  selectedId,
  onSelect,
  ...layer
}: SceneLayersProps) {
  return (
    <group quaternion={ROS_TO_RENDER}>
      <EnvironmentLayer {...layer} />
      <HeadLayer {...layer} framesLoadedToUs={framesLoadedToUs} />
      <HandsLayer
        {...layer}
        handsKeptFromUs={handsKeptFromUs}
        framesLoadedToUs={framesLoadedToUs}
      />
      <ObjectsLayer {...layer} selectedId={selectedId} onSelect={onSelect} />
      <DetectionsLayer {...layer} />
    </group>
  );
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

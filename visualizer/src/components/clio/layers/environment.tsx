"use client";

import { Html } from "@react-three/drei";
import type { EnvironmentDoc, SurfaceKind } from "@clio/protocol";
import { WORKSPACE } from "@clio-viewer/capture/from-clio";
import type { Capture, Vec3 } from "@clio-viewer/capture/model";
import { useEffect, useMemo } from "react";
import {
  AxesHelper,
  BoxGeometry,
  BufferGeometry,
  DoubleSide,
  EdgesGeometry,
  Float32BufferAttribute,
  LineBasicMaterial,
  LineLoop,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  Vector3,
} from "three";
import {
  type CompiledPlane,
  type CompiledTable,
  compiledFloor,
  compiledPlanes,
  compiledTable,
} from "@/lib/clio/derived-display";
import {
  calibratedFloor,
  SCENE_COLORS,
  themed,
} from "@/lib/clio/object-display";
import type { LayerProps } from "../clio-scene";

// Context: the workspace (the calibrated table, its corner at the origin) and the floor from
// calibration, both as subdued as the grid. Their labels and the origin axes appear in Debug.
// A compiled environment (environment.json) takes over the table and floor and adds every plane
// the headset detected, as outlines in the same subdued color; without one, the workspace box and
// the calibrated floor stay as they are.

const FLOOR_SIZE = 3;
const FLOOR_STEP = 0.5;
const DEFAULT_SIZE: [number, number, number] = [0.4, 0.6, 0.01];

/** The workspace box's center and size in ROS (the table's top face at z = 0). */
export function workspaceBounds(capture: Capture): {
  center: Vec3;
  size: [number, number, number];
} {
  const entity = capture.entities.get(WORKSPACE);
  const size =
    entity?.geometry.type === "box" ? entity.geometry.size : DEFAULT_SIZE;
  const p = entity?.pose?.translation ?? [size[0] / 2, -size[1] / 2, 0];
  return { center: [p[0], p[1], 0], size: [size[0], size[1], size[2]] };
}

/** Lines every FLOOR_STEP across a FLOOR_SIZE square in the xy plane, centered on 0. */
function floorLines(): BufferGeometry {
  const half = FLOOR_SIZE / 2;
  const points: number[] = [];
  for (let v = -half; v <= half + 1e-9; v += FLOOR_STEP) {
    points.push(-half, v, 0, half, v, 0, v, -half, 0, v, half, 0);
  }
  return new BufferGeometry().setAttribute(
    "position",
    new Float32BufferAttribute(points, 3),
  );
}

const muted = "text-[11px] font-medium text-fg-muted whitespace-nowrap";

/** Debug labels for compiled context. */
const TABLE_LABEL: Record<CompiledTable["source"], string> = {
  calibration: "table from calibration",
  plan: "table from plan",
  planes: "table from detected plane",
};
const PLANE_LABEL: Record<SurfaceKind, string> = {
  table: "detected table",
  floor: "detected floor",
  wall: "detected wall",
  ceiling: "detected ceiling",
  couch: "detected couch",
  other: "detected plane",
};

/** A closed outline through ROS points. */
function outline(points: readonly Vec3[]): BufferGeometry {
  return new BufferGeometry().setAttribute(
    "position",
    new Float32BufferAttribute(points.flat(), 3),
  );
}

interface CompiledParts {
  table: CompiledTable | null;
  top: Mesh | null;
  edge: LineLoop | null;
  planes: { plane: CompiledPlane; line: LineLoop }[];
  /** The table's and the planes' outlines share it. */
  line: LineBasicMaterial;
}

function compiledParts(environment: EnvironmentDoc): CompiledParts {
  const line = new LineBasicMaterial();
  const table = compiledTable(environment);
  let top: Mesh | null = null;
  let edge: LineLoop | null = null;
  if (table) {
    const [a, b, c, d] = table.corners;
    // Just under the grid, as the workspace top is.
    const under = (p: Vec3) => [p[0], p[1], p[2] - 0.001];
    const quad = new BufferGeometry().setAttribute(
      "position",
      new Float32BufferAttribute(
        [a, b, c, a, c, d].flatMap((p) => under(p)),
        3,
      ),
    );
    top = new Mesh(quad, new MeshBasicMaterial({ side: DoubleSide }));
    edge = new LineLoop(outline(table.corners), line);
  }
  const planes = compiledPlanes(environment).map((plane) => ({
    plane,
    line: new LineLoop(outline(plane.outline), line),
  }));
  return { table, top, edge, planes, line };
}

function disposeCompiled(parts: CompiledParts): void {
  parts.top?.geometry.dispose();
  (parts.top?.material as MeshBasicMaterial | undefined)?.dispose();
  parts.edge?.geometry.dispose();
  for (const { line } of parts.planes) line.geometry.dispose();
  parts.line.dispose();
}

export function EnvironmentLayer({
  capture,
  theme,
  debug,
  environment = null,
}: LayerProps & {
  /** The compiled environment, when the episode has one. */
  environment?: EnvironmentDoc | null;
}) {
  const { center, size } = workspaceBounds(capture);
  const compiled = useMemo(
    () => (environment ? compiledParts(environment) : null),
    [environment],
  );
  useEffect(
    () => () => {
      if (compiled) disposeCompiled(compiled);
    },
    [compiled],
  );
  // The compiled floor (also from calibration) when there is one.
  const floor =
    (environment && compiledFloor(environment)) ??
    calibratedFloor(capture.space);
  const [sx, sy, sz] = size;
  const parts = useMemo(() => {
    const top = new Mesh(new PlaneGeometry(sx, sy), new MeshBasicMaterial());
    const box = new BoxGeometry(sx, sy, sz);
    const edges = new LineSegments(
      new EdgesGeometry(box),
      new LineBasicMaterial(),
    );
    box.dispose();
    const floorGrid = new LineSegments(floorLines(), new LineBasicMaterial());
    const axes = new AxesHelper(0.1);
    return { top, edges, floorGrid, axes };
  }, [sx, sy, sz]);

  useEffect(
    () => () => {
      for (const part of [parts.top, parts.edges, parts.floorGrid]) {
        part.geometry.dispose();
        (part.material as MeshBasicMaterial).dispose();
      }
      parts.axes.dispose();
    },
    [parts],
  );

  const { top, edges, floorGrid, axes } = parts;
  (top.material as MeshBasicMaterial).color.set(
    themed(SCENE_COLORS.table, theme),
  );
  // A compiled table replaces the workspace box.
  const workspaceShown = !compiled?.table;
  top.visible = workspaceShown;
  edges.visible = workspaceShown;
  if (compiled) {
    (compiled.top?.material as MeshBasicMaterial | undefined)?.color.set(
      themed(SCENE_COLORS.table, theme),
    );
    compiled.line.color.set(themed(SCENE_COLORS.gridSection, theme));
  }
  // Just under the grid, so the grid's lines stay visible on the table.
  top.position.set(center[0], center[1], -0.001);
  (edges.material as LineBasicMaterial).color.set(
    themed(SCENE_COLORS.gridSection, theme),
  );
  edges.position.set(center[0], center[1], -sz / 2);
  (floorGrid.material as LineBasicMaterial).color.set(
    themed(SCENE_COLORS.gridSection, theme),
  );
  if (floor) {
    floorGrid.position.set(...floor.point);
    floorGrid.quaternion.copy(
      new Quaternion().setFromUnitVectors(
        new Vector3(0, 0, 1),
        new Vector3(...floor.normal),
      ),
    );
  }
  floorGrid.visible = floor !== null;

  return (
    <group>
      <primitive object={top} />
      <primitive object={edges} />
      <primitive object={floorGrid} />
      {compiled?.top && <primitive object={compiled.top} />}
      {compiled?.edge && <primitive object={compiled.edge} />}
      {compiled?.planes.map(({ plane, line }) => (
        <primitive key={plane.id} object={line} />
      ))}
      {debug && (
        <>
          <primitive object={axes} />
          <Html
            position={[0, 0, 0.02]}
            pointerEvents="none"
            zIndexRange={[20, 0]}
          >
            <span className={muted}>table corner</span>
          </Html>
          {floor && (
            <Html
              position={floor.point}
              pointerEvents="none"
              zIndexRange={[20, 0]}
            >
              <span className={muted}>floor from calibration</span>
            </Html>
          )}
          {compiled?.table && (
            // At the far corner, clear of a detected table plane's label.
            <Html
              position={compiled.table.corners[2]}
              pointerEvents="none"
              zIndexRange={[20, 0]}
            >
              <span className={muted}>
                {TABLE_LABEL[compiled.table.source]}
              </span>
            </Html>
          )}
          {compiled?.planes.map(({ plane }) => (
            <Html
              key={plane.id}
              position={plane.center}
              pointerEvents="none"
              zIndexRange={[20, 0]}
            >
              <span className={muted}>{PLANE_LABEL[plane.kind]}</span>
            </Html>
          ))}
        </>
      )}
    </group>
  );
}

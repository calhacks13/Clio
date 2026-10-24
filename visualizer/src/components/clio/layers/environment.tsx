"use client";

import { Html } from "@react-three/drei";
import { WORKSPACE } from "@clio-viewer/capture/from-clio";
import type { Capture, Vec3 } from "@clio-viewer/capture/model";
import { useEffect, useMemo } from "react";
import {
  AxesHelper,
  BoxGeometry,
  BufferGeometry,
  EdgesGeometry,
  Float32BufferAttribute,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  Vector3,
} from "three";
import {
  calibratedFloor,
  SCENE_COLORS,
  themed,
} from "@/lib/clio/object-display";
import type { LayerProps } from "../clio-scene";

// Context: the workspace (the calibrated table, its corner at the origin) and the floor from
// calibration, both as subdued as the grid. Their labels and the origin axes appear in Debug.

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

export function EnvironmentLayer({ capture, theme, debug }: LayerProps) {
  const { center, size } = workspaceBounds(capture);
  const floor = calibratedFloor(capture.space);
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
        </>
      )}
    </group>
  );
}

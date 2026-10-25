import type { SceneModel, TracksDoc } from "@clio/protocol";
import { rosFromW, rosQuatFromW } from "@clio-viewer/capture/from-clio";
import type { Quat, Vec3 } from "@clio-viewer/capture/model";
import { compiledObjectAt } from "./compiled-objects";
import type { InspectorRow } from "./lanes";
import { rotate } from "./object-display";

// What the scene and the inspector read from the room scan and the rebuilt scene
// (docs/room-scene.md). Both are in the workspace frame W (y up). The room scan's GLB nodes carry
// their own transforms in W, so the room layer draws them inside one group turned by W_TO_ROS_QUAT
// (the rotation B of INTEGRATION.md, what rosFromW does to a vector) within the scene's ROS group.
// A generated model rides on its object's compiled position: its placement (an offset from that
// position and a yaw, in W) reaches ROS once here, and its GLB (meters, +y up, origin at the bottom
// center) sits inside the same W_TO_ROS_QUAT turn. Pure: no DOM or three.js.

/**
 * W to ROS as a unit quaternion [x, y, z, w]: B = [[0,0,-1],[-1,0,0],[0,1,0]], so rotating a W
 * vector by it gives rosFromW of that vector.
 */
export const W_TO_ROS_QUAT: Quat = [0.5, -0.5, -0.5, 0.5];

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

function normalized(q: readonly number[]): Quat {
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

/** A model's placement in ROS: where its origin sits from the tracked position, and its turn. */
export interface ModelPlacement {
  /** From the object's compiled position to the model origin, ROS axes. */
  offset: Vec3;
  /** The model's rotation in ROS (B R Bᵀ of its yaw in W). */
  rotation: Quat;
}

/** The placement of `model` in ROS. rosFromW is linear, so it applies to the offset as is. */
export function modelPlacement(model: SceneModel): ModelPlacement {
  return {
    offset: rosFromW(model.placement.offset),
    rotation: rosQuatFromW(normalized(model.placement.rotation)),
  };
}

/**
 * Where a point of the model's GLB (its own frame: meters, +y up) lands in ROS when the object is
 * at `positionRos`: the chain of groups the objects layer draws, written out. The GLB's axes are
 * W's, turned by W_TO_ROS_QUAT, then by the placement's rotation, then moved to the origin.
 */
export function modelPointInRos(
  positionRos: Vec3,
  placement: ModelPlacement,
  local: Vec3,
): Vec3 {
  const turned = rotate(placement.rotation, rotate(W_TO_ROS_QUAT, local));
  return add(add(positionRos, placement.offset), turned);
}

/**
 * The model origin in ROS at `tUs`: the object's compiled position at the grid frame in force,
 * plus the placement's offset. Null where the compiled position is null (nothing is drawn), as for
 * the object itself.
 */
export function modelOriginAt(
  tracks: TracksDoc,
  model: SceneModel,
  tUs: number,
): Vec3 | null {
  const at = compiledObjectAt(tracks, model.id, tUs);
  return at ? add(at.position, modelPlacement(model).offset) : null;
}

const BACKEND_LABEL: Record<SceneModel["backend"], string> = {
  primitive: "Primitive",
  triposr: "TripoSR",
  command: "Image to 3D",
};

const SIZE_SOURCE: Record<
  SceneModel["sizeSource"],
  { value: string; basis: InspectorRow["basis"]; title: string }
> = {
  shape: {
    value: "Measured shape",
    basis: "measured",
    title: "Scaled to the box around the fused depth samples",
  },
  extent: {
    value: "Estimated size",
    basis: "derived",
    title: "Scaled to the estimated width and height across the camera",
  },
  radius: {
    value: "Plan radius",
    basis: "measured",
    title: "Scaled to the radius the lesson plan gives the object",
  },
};

const ROTATION_SOURCE: Record<
  SceneModel["placement"]["rotationSource"],
  { value: string; basis: InspectorRow["basis"]; title: string }
> = {
  shape: {
    value: "Measured shape",
    basis: "measured",
    title: "Turned to the yaw of the fused shape's box",
  },
  view: {
    value: "Facing the camera",
    basis: "inferred",
    title: "Turned to face the camera that saw it: a guess",
  },
  none: {
    value: "Not turned",
    basis: "generated",
    title: "No measurement says how it is turned",
  },
};

const cm = (m: number) => Math.round(m * 100);

/** The model's fitted bounds, x by height by z, in whole centimeters. */
export const formatModelSize = (size: readonly number[]): string =>
  `${cm(size[0])} x ${cm(size[1])} x ${cm(size[2])} cm`;

/**
 * The inspector's rows for an object's generated model: how it was made (generated), which
 * measurement scaled and turned it (at that measurement's level), and its note.
 */
export function modelRows(model: SceneModel): InspectorRow[] {
  const backend = BACKEND_LABEL[model.backend];
  const made = model.model !== null;
  const rows: InspectorRow[] = [
    {
      label: "Model (generated)",
      value: made
        ? model.generator
          ? `${backend}, ${model.generator}`
          : backend
        : "None",
      basis: "generated",
      title: made
        ? model.generator
          ? `${backend} model made by ${model.generator}`
          : `${backend} model made offline from the measured size and the crops' color`
        : "No model could be made",
    },
  ];
  if (made) {
    const size = SIZE_SOURCE[model.sizeSource];
    rows.push({
      label: "Sized by",
      value: size.value,
      basis: size.basis,
      title: `${size.title}: ${formatModelSize(model.size)}`,
    });
    const turn = ROTATION_SOURCE[model.placement.rotationSource];
    rows.push({
      label: "Turned by",
      value: turn.value,
      basis: turn.basis,
      title: turn.title,
    });
  }
  if (model.note) {
    rows.push({ label: null, value: model.note, basis: "generated" });
  }
  return rows;
}

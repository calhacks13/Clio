import type {
  CompiledObjectShape,
  CompiledObjectTrack,
  TracksDoc,
} from "@clio/protocol";
import { rosFromW, rosQuatFromW } from "@clio-viewer/capture/from-clio";
import type { Handedness, Quat, Vec3 } from "@clio-viewer/capture/model";
import { gridFrameAt } from "./derived-display";

// What the scene and the inspector read from a compiled episode's objects: each object's state at
// the grid frame in force at one recording time `tUs` (tracks.json), its estimated metric extent and
// its measured shape (shapes.json). Compiled documents are in the workspace frame W (y up), like
// the raw episode; everything here comes out in the Capture's ROS frame (z up, meters), converted
// once with rosFromW and rosQuatFromW, so layers/objects.tsx draws it as it draws raw data. Once a
// compile exists its series is authoritative: a null here means nothing is drawn, never a stale or
// raw pose. Pure: no DOM or three.js.

/** One object at one grid frame, in ROS. */
export interface CompiledObjectPose {
  position: Vec3;
  /** Null where the orientation is unknown. */
  rotation: Quat | null;
  /** The estimate in force was measured within policy.staleMs; false draws the muted color. */
  tracked: boolean;
  interpolated: boolean;
  held: boolean;
  heldBy: Handedness | null;
}

/**
 * The object at the grid frame at or before `tUs` (grid times are ms, `tUs` is µs), or null before
 * the first frame, more than one grid step after the last, for an object the document does not
 * have, and where its compiled position is null.
 */
export function compiledObjectAt(
  tracks: TracksDoc,
  objectId: string,
  tUs: number,
): CompiledObjectPose | null {
  const track = tracks.objects.find((o) => o.id === objectId);
  if (!track) return null;
  const i = gridFrameAt(tracks.t, tracks.fps, tUs);
  if (i < 0) return null;
  const position = track.position[i];
  if (!position) return null;
  const rotation = track.orientation[i] ?? null;
  return {
    position: rosFromW(position),
    rotation: rotation ? rosQuatFromW(rotation) : null,
    tracked: track.tracked[i] ?? false,
    interpolated: track.interpolated[i] ?? false,
    held: track.held[i] ?? false,
    heldBy: track.heldBy[i] ?? null,
  };
}

/**
 * How the held span covering `tUs` was found: recorded (grasp and release events) or inferred, as
 * DESIGN.md draws the held ring solid or in segments. Null outside every span. The end is exclusive;
 * a null end is still held at the end of the episode.
 */
export function heldOriginAt(
  track: CompiledObjectTrack,
  tUs: number,
): "recorded" | "inferred" | null {
  const tMs = tUs / 1000;
  for (const span of track.heldSpans) {
    if (tMs >= span.startT && (span.endT === null || tMs < span.endT)) {
      return span.origin;
    }
  }
  return null;
}

/**
 * The estimated extent as a ROS box size [x, y, z] with z up: the measured width across the camera
 * and height up it. Depth across the camera is unknown, so the box reuses the width. Null without
 * an extent (not estimable, or a compiler before 0.6.0).
 */
export function extentSize(
  track: CompiledObjectTrack,
): [number, number, number] | null {
  const extent = track.extent;
  if (!extent) return null;
  return [extent.width, extent.width, extent.height];
}

export interface ShapeInRos {
  /** Fused depth samples as offsets from the object's tracked position, ROS axes. */
  points: Vec3[];
  box: {
    /** Offset from the tracked position, ROS axes. */
    center: Vec3;
    /** Along the box's own ROS x, y, z: positive lengths. */
    size: Vec3;
    rotation: Quat;
  } | null;
}

/**
 * A compiled shape in ROS. The offsets go through rosFromW, which is linear with no translation, so
 * it applies to offsets as to positions. The box's size is a vector of lengths along its own axes:
 * the same axis permutation applies, with absolute values so the lengths stay positive.
 */
export function shapeInRos(shape: CompiledObjectShape): ShapeInRos {
  const points = shape.points.map((p) => rosFromW(p));
  if (!shape.box) return { points, box: null };
  const { center, rotation, size } = shape.box;
  const permuted = rosFromW(size);
  return {
    points,
    box: {
      center: rosFromW(center),
      size: [
        Math.abs(permuted[0]),
        Math.abs(permuted[1]),
        Math.abs(permuted[2]),
      ],
      rotation: rosQuatFromW(rotation),
    },
  };
}

const cm = (m: number) => Math.round(m * 100);

/** The inspector's "Size (estimated)" value: width x height in whole centimeters. */
export function formatExtent(extent: {
  width: number;
  height: number;
}): string {
  return `${cm(extent.width)} x ${cm(extent.height)} cm`;
}

const count = new Intl.NumberFormat("en-US");
/** A whole number with thousands separators, as the inspector writes counts. */
export const formatCount = (n: number): string => count.format(n);
const plural = (n: number, word: string) =>
  `${formatCount(n)} ${word}${n === 1 ? "" : "s"}`;

/** The inspector's "Shape (measured)" value: how many fused points, over how many frames. */
export function formatShape(shape: {
  points: readonly Vec3[];
  frames: number;
}): string {
  return `${plural(shape.points.length, "point")}, ${plural(shape.frames, "frame")}`;
}

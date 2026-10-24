import {
  detectionsFor,
  type DetectionMark,
} from "@clio-viewer/capture/clio-events";
import { rosFromW } from "@clio-viewer/capture/from-clio";
import {
  type Capture,
  type CaptureSpace,
  type Entity,
  entityAt,
  type EstimateType,
  type Handedness,
  type HeldSpan,
  heldSpanAt,
  type ObjectKind,
  type Quat,
  trail,
  type Vec3,
} from "@clio-viewer/capture/model";

// What the scene, the lanes and the inspector show for each object at one recording time `tUs`:
// where it stands, whether its orientation is known, its recent path, the span holding it, how old
// its newest update is and where that update came from. Pure: no DOM or three.js. Positions are in
// the Capture's ROS frame (z up, meters). Colors follow DESIGN.md ("Clio episode viewer").

type Theme = "light" | "dark";

export interface ThemedColor {
  light: string;
  dark: string;
}

/** Object identity colors, in the order objects first appear, cycling after seven. */
export const OBJECT_COLORS: readonly ThemedColor[] = [
  { light: "#0F7C80", dark: "#5AD1C5" }, // teal
  { light: "#3B8A3E", dark: "#7FD483" }, // green
  { light: "#A07400", dark: "#F2C94C" }, // gold
  { light: "#C2417A", dark: "#FF8FC0" }, // magenta
  { light: "#2F6FDE", dark: "#8AB4FF" }, // blue
  { light: "#8B5E3C", dark: "#D9A66F" }, // brown
  { light: "#66791A", dark: "#C4D66B" }, // olive
];

/** Hands read as the person, not as tracked objects. */
export const HAND_COLORS: Record<Handedness, ThemedColor> = {
  left: { light: "#4F6D8F", dark: "#9DB7D5" },
  right: { light: "#8F5A6B", dark: "#D9A3B5" },
};

/** The color roles the 3D scene uses besides identity and hand colors. */
export const SCENE_COLORS = {
  canvas: { light: "#F4F6FA", dark: "#14171D" },
  detection: { light: "#6D4AD8", dark: "#B49CFF" },
  heldRing: { light: "#0F1117", dark: "#EDF0F5" },
  muted: { light: "#5B6472", dark: "#A5AFBF" },
  /** The table top, one step off the canvas. */
  table: { light: "#FFFFFF", dark: "#1F232C" },
  gridCell: { light: "#E0E6EE", dark: "#252B35" },
  gridSection: { light: "#CDD6E2", dark: "#303742" },
} satisfies Record<string, ThemedColor>;

export const themed = (color: ThemedColor, theme: Theme): string =>
  color[theme];

/** The identity color of the object drawn `index`-th (see `drawnObjects`). */
export const identityColor = (index: number): ThemedColor =>
  OBJECT_COLORS[
    ((index % OBJECT_COLORS.length) + OBJECT_COLORS.length) %
      OBJECT_COLORS.length
  ];

/** How far back an object's trail reaches. */
export const TRAIL_US = 3_000_000;
const TRAIL_POINTS = 240;
const DEFAULT_RADIUS = 0.03;

/**
 * The objects to draw, in the order they first appeared in the capture (its entity order). Hidden
 * objects, such as a plan's mistake zone, are left out unless asked for. An object's index here is
 * its identity color index, for the scene and the lanes alike.
 */
export function drawnObjects(
  capture: Capture,
  { includeHidden = false }: { includeHidden?: boolean } = {},
): Entity[] {
  const objects: Entity[] = [];
  for (const entity of capture.entities.values()) {
    if (entity.role !== "object") continue;
    if (entity.extensions?.hidden && !includeHidden) continue;
    objects.push(entity);
  }
  return objects;
}

export interface ObjectDisplay {
  entityId: string;
  name: string;
  kind: ObjectKind | null;
  hidden: boolean;
  radius: number;
  /** Index into OBJECT_COLORS (via identityColor); -1 for a hidden object. */
  colorIndex: number;
  /** Where to draw it: the newest valid position at or before `tUs`. Null before its first one. */
  position: Vec3 | null;
  /** Null when the newest update recorded no orientation. */
  rotation: Quat | null;
  orientationKnown: boolean;
  /** The newest update says the position is not valid (only episodes with location flags). */
  lost: boolean;
  /** Valid positions in the last TRAIL_US up to `tUs`, as polylines; never anything later. */
  trail: Vec3[][];
  /** The span holding it at `tUs`, recorded or inferred. */
  held: HeldSpan | null;
  /** Time of the newest update at or before `tUs`. */
  updatedUs: number | null;
  /** Derived: `tUs` minus `updatedUs`. */
  ageUs: number | null;
  /** The newest update's source, e.g. "clio-layout", "clio-grip" or "clio-detector". */
  sourceId: string | null;
  estimate: EstimateType | null;
  /** Only detector and marker updates carry a measured confidence; null otherwise. */
  confidence: number | null;
  /** The newest object finder answer that had arrived by `tUs`, found or not. */
  detection: DetectionMark | null;
}

export interface DisplayOptions {
  includeHidden?: boolean;
  trailUs?: number;
  trailPoints?: number;
}

/** The newest detector answer about the object that had arrived by `tUs`. */
function lastDetection(
  capture: Capture,
  entityId: string,
  tUs: number,
): DetectionMark | null {
  const marks = detectionsFor(capture, entityId);
  let lo = 0;
  let hi = marks.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (marks[mid].availableUs <= tUs) lo = mid + 1;
    else hi = mid;
  }
  return marks[lo - 1] ?? null;
}

function display(
  capture: Capture,
  entity: Entity,
  colorIndex: number,
  tUs: number,
  options: DisplayOptions,
): ObjectDisplay {
  const base = {
    entityId: entity.id,
    name: entity.name,
    kind: entity.extensions?.kind ?? null,
    hidden: entity.extensions?.hidden ?? false,
    radius: entity.extensions?.radius_m ?? DEFAULT_RADIUS,
    colorIndex,
    held: heldSpanAt(capture, entity.id, tUs),
    detection: lastDetection(capture, entity.id, tUs),
  };
  const series = capture.poses.get(entity.id);
  const at = series ? entityAt(series, tUs) : null;
  if (series && at) {
    const updatedUs = at.sample.t_us;
    return {
      ...base,
      position: at.position,
      rotation: at.rotation,
      orientationKnown: at.rotation !== null,
      lost: at.lost,
      trail: trail(
        series,
        tUs,
        options.trailUs ?? TRAIL_US,
        options.trailPoints ?? TRAIL_POINTS,
      ),
      updatedUs,
      ageUs: tUs - updatedUs,
      sourceId: at.sample.source_id,
      estimate: at.sample.estimate_type,
      confidence: at.sample.confidence,
    };
  }
  // A static entity with a pose of its own (a Capture package's prop) stands there throughout.
  const pose = entity.motion === "static" ? entity.pose : null;
  return {
    ...base,
    position: pose?.translation ?? null,
    rotation: pose?.rotation ?? null,
    orientationKnown: pose !== null,
    lost: false,
    trail: [],
    updatedUs: null,
    ageUs: null,
    sourceId: null,
    estimate: null,
    confidence: null,
  };
}

/** Every drawn object as it stood at `tUs`, in drawing (identity color) order. */
export function objectsAt(
  capture: Capture,
  tUs: number,
  options: DisplayOptions = {},
): ObjectDisplay[] {
  const out: ObjectDisplay[] = [];
  let colorIndex = 0;
  for (const entity of drawnObjects(capture, options)) {
    const hidden = entity.extensions?.hidden ?? false;
    out.push(display(capture, entity, hidden ? -1 : colorIndex, tUs, options));
    if (!hidden) colorIndex++;
  }
  return out;
}

/** One object at `tUs` (for the inspector), or null if the capture has no such object. */
export function objectAt(
  capture: Capture,
  entityId: string,
  tUs: number,
  options: DisplayOptions = {},
): ObjectDisplay | null {
  const entity = capture.entities.get(entityId);
  if (!entity || entity.role !== "object") return null;
  const hidden = entity.extensions?.hidden ?? false;
  const colorIndex = hidden
    ? -1
    : drawnObjects(capture).findIndex((e) => e.id === entityId);
  return display(capture, entity, colorIndex, tUs, options);
}

/** A plane in the ROS frame: a point on it and its unit normal (pointing up, out of the floor). */
export interface Plane {
  point: Vec3;
  normal: Vec3;
}

/** Rotates v by the unit quaternion q = [x, y, z, w]. */
export function rotate(q: readonly number[], v: Vec3): Vec3 {
  const [x, y, z, w] = q;
  // v + 2w(q × v) + 2 q × (q × v)
  const cx = y * v[2] - z * v[1];
  const cy = z * v[0] - x * v[2];
  const cz = x * v[1] - y * v[0];
  return [
    v[0] + 2 * (w * cx + y * cz - z * cy),
    v[1] + 2 * (w * cy + z * cx - x * cz),
    v[2] + 2 * (w * cz + x * cy - y * cx),
  ];
}

/**
 * The floor from calibration: WebXR local-floor's y = 0 plane, brought into the workspace W through
 * `worldFromWorkspace` and then into ROS once. The point is the floor straight below the workspace
 * origin. Null when the capture records no space (a Capture package).
 */
export function calibratedFloor(space: CaptureSpace | null): Plane | null {
  if (!space) return null;
  const [px, py, pz, qx, qy, qz, qw] = space.worldFromWorkspace;
  const norm = Math.hypot(qx, qy, qz, qw);
  if (
    !Number.isFinite(norm) ||
    norm === 0 ||
    ![px, py, pz].every(Number.isFinite)
  )
    return null;
  // W from local-floor is the inverse rotation: the conjugate.
  const inverse = [-qx / norm, -qy / norm, -qz / norm, qw / norm];
  const normalW = rotate(inverse, [0, 1, 0]);
  // The workspace origin sits at local-floor p; the floor below it is p with y = 0.
  const pointW = rotate(inverse, [0, -py, 0]);
  return { point: rosFromW(pointW), normal: rosFromW(normalW) };
}

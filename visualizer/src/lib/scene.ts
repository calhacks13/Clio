import { Matrix4, Quaternion, Vector3 } from "three";

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];
export type Pose = { translation: Vec3; rotation: Quat };
export type SceneFrame = Pose & { id: string; parent: string };
export type SceneObject = Pose & {
  id: string;
  name: string;
  frame: string;
  scale: Vec3;
  geometry:
    | { type: "box"; size: Vec3; color: string }
    | { type: "glb"; dataUrl: string };
};
export type SceneDocument = {
  schemaVersion: 1;
  convention: "ros-rep-103";
  units: "meters";
  frames: SceneFrame[];
  objects: SceneObject[];
  preset?: string;
  originDescription?: string;
  note?: string;
};
export const IDENTITY_POSE: Pose = {
  translation: [0, 0, 0],
  rotation: [0, 0, 0, 1],
};
export const EMPTY_SCENE: SceneDocument = {
  schemaVersion: 1,
  convention: "ros-rep-103",
  units: "meters",
  frames: [{ id: "base_link", parent: "world", ...IDENTITY_POSE }],
  objects: [],
};

// Public poses are Z-up meters. Upstream Three.js displays Y-up and enlarges arms.
export const ROS_TO_RENDER = new Quaternion().setFromAxisAngle(
  new Vector3(1, 0, 0),
  -Math.PI / 2,
);
export function poseMatrix(pose: Pose): Matrix4 {
  return new Matrix4().compose(
    new Vector3(...pose.translation),
    new Quaternion(...pose.rotation).normalize(),
    new Vector3(1, 1, 1),
  );
}
export function frameMatrix(doc: SceneDocument, id: string): Matrix4 {
  if (id === "world") return new Matrix4();
  const visited = new Set<string>();
  const chain: SceneFrame[] = [];
  let next = id;
  while (next !== "world") {
    if (visited.has(next)) throw new Error(`Frame cycle at ${next}.`);
    visited.add(next);
    const frame = doc.frames.find((f) => f.id === next);
    if (!frame) throw new Error(`Unknown frame: ${next}.`);
    chain.unshift(frame);
    next = frame.parent;
  }
  return chain.reduce(
    (matrix, frame) => matrix.multiply(poseMatrix(frame)),
    new Matrix4(),
  );
}
export function objectMatrix(doc: SceneDocument, object: SceneObject): Matrix4 {
  return frameMatrix(doc, object.frame)
    .multiply(poseMatrix(object))
    .scale(new Vector3(...object.scale));
}
export function robotDisplayMatrix(
  doc: SceneDocument,
  displayScale: number,
): Matrix4 {
  const display = new Matrix4().compose(
    new Vector3(),
    ROS_TO_RENDER,
    new Vector3(displayScale, displayScale, displayScale),
  );
  return display.multiply(frameMatrix(doc, "base_link"));
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected a JSON object.");
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 200)
    throw new Error(`${label} must be nonempty text (up to 200 characters).`);
  return value;
}
function vector(value: unknown, label: string, length: number): number[] {
  if (
    !Array.isArray(value) ||
    value.length !== length ||
    !value.every((n) => typeof n === "number" && Number.isFinite(n))
  )
    throw new Error(`${label} must contain ${length} finite numbers.`);
  return value;
}
function pose(value: Record<string, unknown>): Pose {
  const translation = vector(value.translation, "translation", 3) as Vec3;
  const rotation = vector(value.rotation, "rotation [x,y,z,w]", 4) as Quat;
  if (Math.abs(Math.hypot(...rotation) - 1) > 0.001)
    throw new Error("Rotation must be a unit quaternion [x,y,z,w].");
  return { translation, rotation };
}
export function parseScene(input: unknown): SceneDocument {
  const root = record(input);
  if (
    root.schemaVersion !== 1 ||
    root.convention !== "ros-rep-103" ||
    root.units !== "meters"
  )
    throw new Error(
      'Use schemaVersion 1, convention "ros-rep-103", and units "meters".',
    );
  if (
    !Array.isArray(root.frames) ||
    root.frames.length > 100 ||
    !Array.isArray(root.objects) ||
    root.objects.length > 100
  )
    throw new Error(
      "Scene must have frames and objects arrays with at most 100 entries each.",
    );
  const frames = root.frames.map((value) => {
    const f = record(value);
    return {
      id: text(f.id, "Frame id"),
      parent: text(f.parent, "Parent frame"),
      ...pose(f),
    };
  });
  const ids = new Set(["world"]);
  for (const f of frames) {
    if (ids.has(f.id)) throw new Error(`Duplicate frame: ${f.id}.`);
    ids.add(f.id);
  }
  if (!ids.has("base_link"))
    throw new Error("Include a base_link frame for the robot placement.");
  const objectIds = new Set<string>(["base_link"]);
  const objects: SceneObject[] = root.objects.map((value) => {
    const o = record(value);
    const id = text(o.id, "Object id");
    if (objectIds.has(id)) throw new Error(`Duplicate object: ${id}.`);
    objectIds.add(id);
    const g = record(o.geometry);
    let geometry: SceneObject["geometry"];
    if (g.type === "box") {
      const size = vector(g.size, "Box size", 3) as Vec3;
      if (size.some((v) => v <= 0))
        throw new Error("Box dimensions must be positive meters.");
      if (typeof g.color !== "string" || !/^#[0-9a-f]{6}$/i.test(g.color))
        throw new Error("Box color must be a six-digit hex color.");
      geometry = { type: "box", size, color: g.color };
    } else if (g.type === "glb") {
      if (
        typeof g.dataUrl !== "string" ||
        !/^data:model\/gltf-binary;base64,[A-Za-z0-9+/]+={0,2}$/.test(
          g.dataUrl,
        ) ||
        g.dataUrl.length > 36_000_000
      )
        throw new Error(
          "GLB assets must be embedded base64 data URLs (up to 25 MB).",
        );
      geometry = { type: "glb", dataUrl: g.dataUrl };
    } else throw new Error("Supported geometry types are box and glb.");
    const scale = vector(o.scale, "Scale", 3) as Vec3;
    if (scale.some((v) => v <= 0)) throw new Error("Scale must be positive.");
    const frame = text(o.frame, "Object frame");
    if (!ids.has(frame)) throw new Error(`Unknown object frame: ${frame}.`);
    return {
      id,
      name: text(o.name, "Object name"),
      frame,
      scale,
      geometry,
      ...pose(o),
    };
  });
  const doc: SceneDocument = {
    schemaVersion: 1,
    convention: "ros-rep-103",
    units: "meters",
    frames,
    objects,
    ...(root.preset === undefined
      ? {}
      : { preset: text(root.preset, "Preset") }),
    ...(root.originDescription === undefined
      ? {}
      : {
          originDescription: text(root.originDescription, "Origin description"),
        }),
    ...(root.note === undefined ? {} : { note: text(root.note, "Scene note") }),
  };
  for (const f of frames) frameMatrix(doc, f.id);
  return doc;
}

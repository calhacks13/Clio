"use client";

import { Html } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import type { SurfaceKind } from "@clio/protocol";
import type { Vec3 } from "@clio-viewer/capture/model";
import { useEffect } from "react";
import {
  Box3,
  type BufferGeometry,
  type DataTexture,
  DoubleSide,
  EdgesGeometry,
  FrontSide,
  type Group,
  LineBasicMaterial,
  LineSegments,
  type Material,
  type Mesh,
  MeshLambertMaterial,
  Vector3,
} from "three";
import { SCENE_COLORS, themed } from "@/lib/clio/object-display";
import type { FileRef } from "@/lib/clio/scene-files";
import type { Theme } from "@/utils/theme";
import { useSceneFile } from "../use-scene-file";
import {
  disposeTree,
  meshesOf,
  onBackdrop,
  parseGlb,
  W_TO_ROS,
  windToward,
} from "./gltf";
import { grainTexture, solidLook } from "./solid";

// The Quest room scan (Space Setup, read by WebXR mesh detection) the compile keeps as room.glb, in
// W: one root node per mesh named by its id, its transform the mesh pose in W and its extras
// {kind, label, global}. It is context, measured before the episode, so it never hides measured
// data: it draws on the backdrop layer, under everything else (gltf.ts). Every surface is solid
// (solid.ts): opaque, with a fine matte grain, flat shaded so each face reads by its facing. The
// global mesh (the walls and the floor) is wound to face the room's middle and drawn front faces
// only, so a wall between the camera and the room (seen from behind) is not drawn: from outside the
// room the near walls drop away like a dollhouse's and the far walls and the floor stay, with the
// mesh's creases as faint edges. Furniture volumes (tables, couches, shelves) are solid blocks a
// step lighter than the walls, edged in a stronger line, labelled in Debug. Every node keeps its own
// transform: the whole file sits in one group turned from W to ROS, inside the scene's ROS group.

/** A crease sharper than this between two triangles draws as an edge. */
const SURFACE_CREASE_DEG = 40;
const VOLUME_CREASE_DEG = 30;
const SURFACE_EDGE_OPACITY = 0.7;

/** One mesh of the scan, as its extras name it. */
export interface RoomPart {
  id: string;
  kind: SurfaceKind;
  label: string | null;
  global: boolean;
  mesh: Mesh;
  edges: LineSegments;
  /**
   * The middle of its bounds in W, where its Debug label goes: clear of a detected plane's label,
   * which sits on the plane, often the volume's top.
   */
  labelAt: Vec3;
}

export interface RoomScanView {
  root: Group;
  parts: RoomPart[];
  materials: {
    surface: MeshLambertMaterial;
    surfaceEdge: LineBasicMaterial;
    volume: MeshLambertMaterial;
    volumeEdge: LineBasicMaterial;
  };
  /** The grain both surfaces carry, released with the scan. */
  grain: DataTexture;
}

const KINDS = new Set<string>([
  "table",
  "floor",
  "wall",
  "ceiling",
  "couch",
  "other",
]);

/** The node extras of a mesh, read from the node that holds it (the mesh or its parent group). */
function extrasOf(mesh: Mesh, root: Group) {
  let node: Mesh["parent"] = mesh;
  while (node && node !== root && node.userData.kind === undefined) {
    node = node.parent;
  }
  const data = node?.userData ?? {};
  return {
    id: node && node !== root ? node.name : mesh.name,
    kind: (KINDS.has(data.kind) ? data.kind : "other") as SurfaceKind,
    label: typeof data.label === "string" ? data.label : null,
    global: data.global === true,
  };
}

/**
 * The parsed scan, ready to draw: its own solid materials (colored by the layer for the theme),
 * each global mesh wound to face its middle, and edges for every mesh. The surfaces write their
 * depth a little behind themselves (solid.ts), so their own edges never flicker on them.
 */
export function prepareRoomScan(root: Group): RoomScanView {
  const grain = grainTexture();
  const materials = {
    // Front faces only: the dollhouse cut.
    surface: new MeshLambertMaterial({ side: FrontSide, flatShading: true }),
    surfaceEdge: new LineBasicMaterial({
      transparent: true,
      opacity: SURFACE_EDGE_OPACITY,
    }),
    // A volume is closed; both sides, in case a scan winds it inward.
    volume: new MeshLambertMaterial({ side: DoubleSide, flatShading: true }),
    volumeEdge: new LineBasicMaterial(),
  };
  solidLook(materials.surface, grain, { depthBias: true });
  solidLook(materials.volume, grain, { depthBias: true });
  root.updateMatrixWorld(true);
  const replaced = new Set<Material>();
  const wound = new Set<BufferGeometry>();
  const parts: RoomPart[] = [];
  for (const mesh of meshesOf(root)) {
    const extras = extrasOf(mesh, root);
    for (const m of Array.isArray(mesh.material)
      ? mesh.material
      : [mesh.material]) {
      replaced.add(m);
    }
    const { geometry } = mesh;
    if (extras.global && !wound.has(geometry)) {
      wound.add(geometry);
      geometry.computeBoundingBox();
      const middle = (geometry.boundingBox as Box3).getCenter(new Vector3());
      windToward(geometry, middle);
    }
    mesh.material = extras.global ? materials.surface : materials.volume;
    const edges = new LineSegments(
      new EdgesGeometry(
        geometry,
        extras.global ? SURFACE_CREASE_DEG : VOLUME_CREASE_DEG,
      ),
      extras.global ? materials.surfaceEdge : materials.volumeEdge,
    );
    mesh.add(edges);
    const bounds = new Box3().setFromObject(mesh);
    const center = bounds.getCenter(new Vector3());
    parts.push({
      ...extras,
      mesh,
      edges,
      labelAt: [center.x, center.y, center.z],
    });
  }
  // The file's own materials (none, or GLTFLoader's default) are never drawn.
  for (const m of replaced) m.dispose();
  onBackdrop(root);
  return { root, parts, materials, grain };
}

/** room.glb as the room layer draws it; a file that is not a GLB throws, so it reads as invalid. */
export async function loadRoomScan(bytes: ArrayBuffer): Promise<RoomScanView> {
  return prepareRoomScan(await parseGlb(bytes));
}

/** Releases the scan's geometries (the edges' too), materials and grain. */
export function disposeRoomScan(scan: RoomScanView): void {
  disposeTree(scan.root);
  scan.grain.dispose();
}

const muted = "text-[11px] font-medium text-fg-muted whitespace-nowrap";

/** Debug label of a furniture volume: its WebXR label, else its kind. */
const partLabel = (part: RoomPart) => `scanned ${part.label ?? part.kind}`;

export function RoomLayer({
  file,
  theme,
  debug,
}: {
  /** The compile's room.glb (scene-files.ts, roomFile). */
  file: FileRef;
  theme: Theme;
  debug: boolean;
}) {
  const { value: scan } = useSceneFile(file, loadRoomScan, disposeRoomScan);
  const invalidate = useThree((s) => s.invalidate);
  // The file arrives after the frame that mounted the layer.
  useEffect(() => {
    invalidate();
  }, [scan, invalidate]);
  if (!scan) return null;
  const { surface, surfaceEdge, volume, volumeEdge } = scan.materials;
  surface.color.set(themed(SCENE_COLORS.roomSurface, theme));
  surfaceEdge.color.set(themed(SCENE_COLORS.gridSection, theme));
  volume.color.set(themed(SCENE_COLORS.roomVolume, theme));
  volumeEdge.color.set(themed(SCENE_COLORS.roomVolumeEdge, theme));
  return (
    <group quaternion={W_TO_ROS} name="room-scan">
      <primitive object={scan.root} />
      {debug &&
        scan.parts
          .filter((part) => !part.global)
          .map((part) => (
            <Html
              key={part.id}
              position={part.labelAt}
              pointerEvents="none"
              zIndexRange={[20, 0]}
            >
              <span className={muted}>{partLabel(part)}</span>
            </Html>
          ))}
    </group>
  );
}

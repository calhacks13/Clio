"use client";

import { Html } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import type {
  CompiledObjectShape,
  CompiledObjectTrack,
  ShapesDoc,
  TracksDoc,
} from "@clio/protocol";
import type { Entity, Quat, Vec3 } from "@clio-viewer/capture/model";
import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  EdgesGeometry,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineLoop,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  Points,
  PointsMaterial,
  SphereGeometry,
  TorusGeometry,
} from "three";
import {
  compiledObjectAt,
  extentSize,
  heldOriginAt,
  shapeInRos,
} from "@/lib/clio/compiled-objects";
import {
  drawnObjects,
  identityColor,
  objectAt,
  type ObjectDisplay,
  SCENE_COLORS,
  themed,
} from "@/lib/clio/object-display";
import type { LayerProps } from "../clio-scene";
import { fillSegments } from "./head";

// Each drawn object at the viewed time: a dot, its radius ring flat on the table, a 3 s trail and a
// name label in its identity color. A held span puts a ring 12 mm outside the radius ring, solid
// when recorded and in even segments when inferred. A known rotation adds a tick toward the
// object's forward (+x) axis; an unknown one draws no heading at all. A lost position (episodes
// with location flags) stays where it was last valid, in the muted color.
//
// With a compiled episode (tracks.json) the position, heading, held ring and tracked state come
// from the object's compiled series instead, which is authoritative once it exists: where it has
// no position, nothing is drawn, never the raw pose the compile rejected. Its estimated extent
// draws as a wireframe box centered on the position (the tracked point is inside the object, not
// under it), and its measured shape (shapes.json) as points riding with the object, with the box
// fitted around them. The trail still follows the raw estimates.

const DOT_RADIUS = 0.012;
const HELD_GAP = 0.012;
const HELD_TUBE = 0.0022;
const HELD_SEGMENTS = 16;
const TRAIL_POINTS = 240;
const EXTENT_OPACITY = 0.5;
/** World size of one fused depth sample, about a 6 mm dot. */
const SHAPE_POINT_SIZE = 0.006;
const SHAPE_OPACITY = 0.85;

// Only the dot takes clicks. Lines are hit-tested within 1 m by default, and three.js raycasts
// hidden objects too, so the ring, tick, held ring, boxes and points would catch clicks meant for
// other objects.
const noRaycast = () => {};

function circle(radius: number, segments = 64): BufferGeometry {
  const points: number[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    points.push(Math.cos(a) * radius, Math.sin(a) * radius, 0);
  }
  return new BufferGeometry().setAttribute(
    "position",
    new Float32BufferAttribute(points, 3),
  );
}

interface Track {
  group: Group;
  heading: Group;
  dot: Mesh;
  ring: LineLoop;
  tick: LineSegments;
  heldSolid: Mesh;
  heldInferred: Group;
  trail: LineSegments;
  identity: MeshBasicMaterial;
  identityLine: LineBasicMaterial;
  held: MeshBasicMaterial;
}

function buildTrack(radius: number): Track {
  const identity = new MeshBasicMaterial();
  const identityLine = new LineBasicMaterial();
  const held = new MeshBasicMaterial();
  const group = new Group();
  group.visible = false;
  const dot = new Mesh(new SphereGeometry(DOT_RADIUS, 16, 12), identity);
  const ring = new LineLoop(circle(radius), identityLine);
  // The heading turns with the object's rotation; the ring stays flat on the table.
  const heading = new Group();
  const tick = new LineSegments(
    new BufferGeometry().setAttribute(
      "position",
      new Float32BufferAttribute([0, 0, 0, radius, 0, 0], 3),
    ),
    identityLine,
  );
  heading.add(tick);
  const ringRadius = radius + HELD_GAP;
  const heldSolid = new Mesh(
    new TorusGeometry(ringRadius, HELD_TUBE, 6, 72),
    held,
  );
  const heldInferred = new Group();
  const arc = new TorusGeometry(
    ringRadius,
    HELD_TUBE,
    6,
    6,
    Math.PI / HELD_SEGMENTS,
  );
  for (let i = 0; i < HELD_SEGMENTS; i++) {
    const segment = new Mesh(arc, held);
    segment.rotation.z = (i / HELD_SEGMENTS) * Math.PI * 2;
    heldInferred.add(segment);
  }
  group.add(dot, ring, heading, heldSolid, heldInferred);
  for (const part of [ring, heading, heldSolid, heldInferred])
    part.traverse((o) => {
      o.raycast = noRaycast;
    });
  const trailGeometry = new BufferGeometry();
  trailGeometry.setAttribute(
    "position",
    new BufferAttribute(new Float32Array(TRAIL_POINTS * 2 * 3), 3),
  );
  const trail = new LineSegments(trailGeometry, identityLine);
  trail.frustumCulled = false;
  return {
    group,
    heading,
    dot,
    ring,
    tick,
    heldSolid,
    heldInferred,
    trail,
    identity,
    identityLine,
    held,
  };
}

function disposeTrack(track: Track): void {
  const geometries = new Set<BufferGeometry>();
  track.group.traverse((o) => {
    if (o instanceof Mesh || o instanceof LineSegments || o instanceof LineLoop)
      geometries.add(o.geometry);
  });
  geometries.add(track.trail.geometry);
  for (const g of geometries) g.dispose();
  track.identity.dispose();
  track.identityLine.dispose();
  track.held.dispose();
}

/** What the compile adds to an object: its extent box, its shape's points and the shape's box. */
interface CompiledView {
  /** Rides inside the object's group, so everything here moves with it. */
  group: Group;
  extent: LineSegments | null;
  points: Points | null;
  shapeBox: LineSegments | null;
  /** The edges of both boxes, in the identity color at half opacity. */
  line: LineBasicMaterial;
  dots: PointsMaterial | null;
}

/** The twelve edges of a box of `size` about its origin, so the object inside stays visible. */
function wireBox(
  size: readonly [number, number, number],
  material: LineBasicMaterial,
): LineSegments {
  const box = new BoxGeometry(size[0], size[1], size[2]);
  const edges = new EdgesGeometry(box);
  box.dispose();
  const lines = new LineSegments(edges, material);
  lines.raycast = noRaycast;
  return lines;
}

/** Null when the compile measured nothing of the object: no extent, no points, no box. */
function buildCompiled(
  track: CompiledObjectTrack | null,
  shape: CompiledObjectShape | null,
): CompiledView | null {
  const size = track ? extentSize(track) : null;
  const ros = shape ? shapeInRos(shape) : null;
  const hasPoints = ros !== null && ros.points.length > 0;
  if (!size && !ros?.box && !hasPoints) return null;
  const line = new LineBasicMaterial({
    transparent: true,
    opacity: EXTENT_OPACITY,
  });
  const group = new Group();
  const extent = size ? wireBox(size, line) : null;
  if (extent) group.add(extent);
  let points: Points | null = null;
  let dots: PointsMaterial | null = null;
  if (ros && hasPoints) {
    dots = new PointsMaterial({
      size: SHAPE_POINT_SIZE,
      sizeAttenuation: true,
      transparent: true,
      opacity: SHAPE_OPACITY,
    });
    const geometry = new BufferGeometry().setAttribute(
      "position",
      new Float32BufferAttribute(ros.points.flat(), 3),
    );
    points = new Points(geometry, dots);
    points.raycast = noRaycast;
    group.add(points);
  }
  let shapeBox: LineSegments | null = null;
  if (ros?.box) {
    shapeBox = wireBox(ros.box.size, line);
    shapeBox.position.set(...ros.box.center);
    shapeBox.quaternion.set(...ros.box.rotation);
    group.add(shapeBox);
  }
  return { group, extent, points, shapeBox, line, dots };
}

function disposeCompiled(view: CompiledView): void {
  view.extent?.geometry.dispose();
  view.points?.geometry.dispose();
  view.shapeBox?.geometry.dispose();
  view.line.dispose();
  view.dots?.dispose();
}

/** What one frame draws of an object, from the compiled series or the raw estimates. */
interface Drawn {
  position: Vec3;
  rotation: Quat | null;
  /** The held ring: solid for a recorded span, segments for an inferred one, none outside. */
  held: "recorded" | "inferred" | null;
  /** The muted color: position lost (raw) or not tracked (compiled). */
  muted: boolean;
}

function fromCompiled(
  tracks: TracksDoc,
  track: CompiledObjectTrack,
  tUs: number,
): Drawn | null {
  const at = compiledObjectAt(tracks, track.id, tUs);
  if (!at) return null;
  return {
    position: at.position,
    rotation: at.rotation,
    held: at.held ? (heldOriginAt(track, tUs) ?? "recorded") : null,
    muted: !at.tracked,
  };
}

function fromRaw(at: ObjectDisplay | null): Drawn | null {
  if (!at?.position) return null;
  const origin = at.held?.origin;
  return {
    position: at.position,
    rotation: at.rotation,
    held:
      origin === "runtime"
        ? "recorded"
        : origin === "inferred"
          ? "inferred"
          : null,
    muted: at.lost,
  };
}

function ObjectTrack({
  entity,
  colorIndex,
  capture,
  clock,
  theme,
  selected,
  onSelect,
  tracks,
  shapes,
}: LayerProps & {
  entity: Entity;
  colorIndex: number;
  selected: boolean;
  onSelect?: (entityId: string) => void;
  tracks: TracksDoc | null;
  shapes: ShapesDoc | null;
}) {
  const radius = entity.extensions?.radius_m ?? 0.03;
  const track = useMemo(() => buildTrack(radius), [radius]);
  // Named for inspection (scene-release.test.ts and the browser's scene tools).
  track.group.name = entity.id;
  useEffect(() => () => disposeTrack(track), [track]);
  // The object's compiled series and shape, when the compile has them.
  const compiledTrack = useMemo(
    () => tracks?.objects.find((o) => o.id === entity.id) ?? null,
    [tracks, entity.id],
  );
  const shape = useMemo(
    () => shapes?.objects.find((o) => o.id === entity.id) ?? null,
    [shapes, entity.id],
  );
  const compiled = useMemo(
    () => buildCompiled(compiledTrack, shape),
    [compiledTrack, shape],
  );
  useEffect(() => {
    if (!compiled) return;
    return () => disposeCompiled(compiled);
  }, [compiled]);
  const label = useRef<HTMLButtonElement | null>(null);
  // The label mounts after the canvas's first frame (Html renders through a portal), so it asks for
  // another frame to be shown or hidden.
  const invalidate = useThree((s) => s.invalidate);
  const labelRef = useCallback(
    (element: HTMLButtonElement | null) => {
      label.current = element;
      if (element) invalidate();
    },
    [invalidate],
  );
  const identity = themed(identityColor(colorIndex), theme);
  const muted = themed(SCENE_COLORS.muted, theme);
  track.held.color.set(themed(SCENE_COLORS.heldRing, theme));

  useFrame(() => {
    const tUs = clock.getTimeUs();
    const raw = objectAt(capture, entity.id, tUs, {
      trailPoints: TRAIL_POINTS,
    });
    const at =
      tracks && compiledTrack
        ? fromCompiled(tracks, compiledTrack, tUs)
        : fromRaw(raw);
    const { group } = track;
    group.visible = at !== null;
    track.trail.visible = group.visible;
    if (label.current)
      label.current.style.display = group.visible ? "" : "none";
    if (!at) return;
    group.position.set(...at.position);
    // An unknown orientation never keeps a heading from another time.
    track.heading.visible = at.rotation !== null;
    if (at.rotation) track.heading.quaternion.set(...at.rotation);
    track.heldSolid.visible = at.held === "recorded";
    track.heldInferred.visible = at.held === "inferred";
    const color = at.muted ? muted : identity;
    track.identity.color.set(color);
    track.identityLine.color.set(color);
    if (compiled) {
      compiled.line.color.set(color);
      compiled.dots?.color.set(color);
    }
    if (label.current) label.current.style.color = color;
    const attribute = track.trail.geometry.getAttribute(
      "position",
    ) as BufferAttribute;
    const n = fillSegments(raw?.trail ?? [], attribute.array as Float32Array);
    attribute.needsUpdate = true;
    track.trail.geometry.setDrawRange(0, n);
  });

  return (
    <>
      <primitive
        object={track.group}
        onClick={
          onSelect
            ? (e: { stopPropagation(): void }) => {
                // An object with no position yet sits hidden at the origin.
                if (!track.group.visible) return;
                e.stopPropagation();
                onSelect(entity.id);
              }
            : undefined
        }
      >
        {compiled && <primitive object={compiled.group} />}
        <Html
          position={[0, 0, DOT_RADIUS + 0.012]}
          pointerEvents="none"
          zIndexRange={[20, 0]}
        >
          <button
            ref={labelRef}
            type="button"
            tabIndex={onSelect ? 0 : -1}
            aria-pressed={selected}
            onClick={() => onSelect?.(entity.id)}
            title={entity.name}
            className={`pointer-events-auto block max-w-40 -translate-x-1/2 -translate-y-full truncate rounded-full px-2 py-0.5 text-xs font-medium leading-4 ${
              selected ? "bg-[var(--accent-soft)]" : "bg-surface-0"
            } ${onSelect ? "cursor-pointer" : "cursor-default"}`}
            style={{ color: identity, display: "none" }}
          >
            {entity.name}
          </button>
        </Html>
      </primitive>
      <primitive object={track.trail} />
    </>
  );
}

export function ObjectsLayer({
  selectedId,
  onSelect,
  tracks,
  shapes,
  ...layer
}: LayerProps & {
  selectedId: string | null;
  onSelect?: (entityId: string) => void;
  /** The compiled object series; null draws the raw estimates. */
  tracks: TracksDoc | null;
  /** The compiled shapes; null draws none. */
  shapes: ShapesDoc | null;
}) {
  const { capture, revision } = layer;
  // New objects can appear while a live episode streams in.
  const entities = useMemo(
    () => drawnObjects(capture),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [capture, revision],
  );
  return (
    <group>
      {entities.map((entity, index) => (
        <ObjectTrack
          key={entity.id}
          {...layer}
          entity={entity}
          colorIndex={index}
          selected={entity.id === selectedId}
          onSelect={onSelect}
          tracks={tracks}
          shapes={shapes}
        />
      ))}
    </group>
  );
}

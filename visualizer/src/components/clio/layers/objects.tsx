"use client";

import { Html } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import type { Entity } from "@clio-viewer/capture/model";
import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  BufferAttribute,
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineLoop,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  SphereGeometry,
  TorusGeometry,
} from "three";
import {
  drawnObjects,
  identityColor,
  objectAt,
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

const DOT_RADIUS = 0.012;
const HELD_GAP = 0.012;
const HELD_TUBE = 0.0022;
const HELD_SEGMENTS = 16;
const TRAIL_POINTS = 240;

// Only the dot takes clicks. Lines are hit-tested within 1 m by default, and three.js raycasts
// hidden objects too, so the ring, tick and held ring would catch clicks meant for other objects.
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

function ObjectTrack({
  entity,
  colorIndex,
  capture,
  clock,
  theme,
  selected,
  onSelect,
}: LayerProps & {
  entity: Entity;
  colorIndex: number;
  selected: boolean;
  onSelect?: (entityId: string) => void;
}) {
  const radius = entity.extensions?.radius_m ?? 0.03;
  const track = useMemo(() => buildTrack(radius), [radius]);
  useEffect(() => () => disposeTrack(track), [track]);
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
    const at = objectAt(capture, entity.id, clock.getTimeUs(), {
      trailPoints: TRAIL_POINTS,
    });
    const { group } = track;
    group.visible = !!at?.position;
    track.trail.visible = group.visible;
    if (label.current)
      label.current.style.display = group.visible ? "" : "none";
    if (!at?.position) return;
    group.position.set(...at.position);
    // An unknown orientation never keeps a heading from another time.
    track.heading.visible = at.rotation !== null;
    if (at.rotation) track.heading.quaternion.set(...at.rotation);
    track.heldSolid.visible = at.held?.origin === "runtime";
    track.heldInferred.visible = at.held?.origin === "inferred";
    const color = at.lost ? muted : identity;
    track.identity.color.set(color);
    track.identityLine.color.set(color);
    if (label.current) label.current.style.color = color;
    const attribute = track.trail.geometry.getAttribute(
      "position",
    ) as BufferAttribute;
    const n = fillSegments(at.trail, attribute.array as Float32Array);
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
  ...layer
}: LayerProps & {
  selectedId: string | null;
  onSelect?: (entityId: string) => void;
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
        />
      ))}
    </group>
  );
}

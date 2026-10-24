"use client";

import { useFrame } from "@react-three/fiber";
import { entityAt, trail } from "@clio-viewer/capture/model";
import { useEffect, useMemo } from "react";
import {
  BufferAttribute,
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  SphereGeometry,
} from "three";
import { SCENE_COLORS, themed, TRAIL_US } from "@/lib/clio/object-display";
import type { LayerProps } from "../clio-scene";

// The headset at the viewed time, as a small view frustum looking along its forward axis (+x in
// ROS: the headset's -z in W), with a trail of its recent path. Both in the muted color. Past the
// loaded frames it draws nothing rather than the last loaded pose.

const TRAIL_POINTS = 240;
// Apex at the eyes, base 6 cm ahead.
const FRUSTUM = { depth: 0.06, halfWidth: 0.035, halfHeight: 0.025 };

function frustum(): BufferGeometry {
  const { depth: d, halfWidth: w, halfHeight: h } = FRUSTUM;
  const corners = [
    [d, w, h],
    [d, -w, h],
    [d, -w, -h],
    [d, w, -h],
  ];
  const points: number[] = [];
  corners.forEach((corner, i) => {
    const next = corners[(i + 1) % corners.length];
    points.push(0, 0, 0, ...corner, ...corner, ...next);
  });
  return new BufferGeometry().setAttribute(
    "position",
    new Float32BufferAttribute(points, 3),
  );
}

/** Writes polylines into a LineSegments buffer as segment pairs; returns the vertex count. */
export function fillSegments(
  lines: readonly (readonly number[])[][],
  out: Float32Array,
): number {
  const max = out.length / 3;
  let n = 0;
  for (const line of lines) {
    for (let i = 1; i < line.length && n + 2 <= max; i++, n += 2) {
      out.set(line[i - 1], n * 3);
      out.set(line[i], n * 3 + 3);
    }
  }
  return n;
}

export function HeadLayer({
  capture,
  clock,
  theme,
  framesLoadedToUs,
}: LayerProps & { framesLoadedToUs: number | null }) {
  const parts = useMemo(() => {
    const head = new Group();
    const material = new LineBasicMaterial();
    const dot = new Mesh(
      new SphereGeometry(0.008, 12, 8),
      new MeshBasicMaterial(),
    );
    head.add(new LineSegments(frustum(), material), dot);
    head.visible = false;
    const geometry = new BufferGeometry();
    geometry.setAttribute(
      "position",
      new BufferAttribute(new Float32Array(TRAIL_POINTS * 2 * 3), 3),
    );
    const path = new LineSegments(geometry, new LineBasicMaterial());
    path.frustumCulled = false;
    return { head, material, dot, path };
  }, []);
  useEffect(
    () => () => {
      parts.head.traverse((o) => {
        if (o instanceof Mesh || o instanceof LineSegments) {
          o.geometry.dispose();
          (o.material as MeshBasicMaterial).dispose();
        }
      });
      parts.path.geometry.dispose();
      (parts.path.material as LineBasicMaterial).dispose();
    },
    [parts],
  );

  const color = themed(SCENE_COLORS.muted, theme);
  parts.material.color.set(color);
  (parts.dot.material as MeshBasicMaterial).color.set(color);
  (parts.path.material as LineBasicMaterial).color.set(color);

  useFrame(() => {
    const tUs = clock.getTimeUs();
    const series = capture.headset();
    const loaded = framesLoadedToUs === null || tUs <= framesLoadedToUs;
    const at = series && loaded ? entityAt(series, tUs) : null;
    const { head, path } = parts;
    head.visible = !!at?.position;
    path.visible = head.visible;
    if (!series || !at?.position) return;
    head.position.set(...at.position);
    if (at.rotation) head.quaternion.set(...at.rotation);
    else head.quaternion.identity();
    head.children[0].visible = at.rotation !== null;
    const attribute = path.geometry.getAttribute("position") as BufferAttribute;
    const n = fillSegments(
      trail(series, tUs, TRAIL_US, TRAIL_POINTS),
      attribute.array as Float32Array,
    );
    attribute.needsUpdate = true;
    path.geometry.setDrawRange(0, n);
  });

  return (
    <group>
      <primitive object={parts.head} />
      <primitive object={parts.path} />
    </group>
  );
}

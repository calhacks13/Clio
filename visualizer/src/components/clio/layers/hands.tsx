"use client";

import { useFrame } from "@react-three/fiber";
import {
  HAND_BONES,
  HAND_JOINTS,
  type Handedness,
  handAt,
} from "@clio-viewer/capture/model";
import { useEffect, useMemo } from "react";
import {
  BufferAttribute,
  BufferGeometry,
  Group,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  MeshBasicMaterial,
  SphereGeometry,
} from "three";
import { HAND_COLORS, themed } from "@/lib/clio/object-display";
import type { LayerProps } from "../clio-scene";

// Both hands at the viewed time: the 25 recorded joints (OpenXR slots 1 to 25; the palm, slot 0,
// is never recorded) and the bones between them. An untracked hand, or a time outside the kept
// hand samples or the loaded frames, draws nothing: there is no ghost at the last pose.

const JOINT_RADIUS = 0.0045;
const HIDDEN = new Matrix4().makeScale(0, 0, 0);

interface HandView {
  group: Group;
  joints: InstancedMesh;
  bones: LineSegments;
}

function handView(): HandView {
  const joints = new InstancedMesh(
    new SphereGeometry(JOINT_RADIUS, 10, 8),
    new MeshBasicMaterial(),
    HAND_JOINTS,
  );
  joints.frustumCulled = false;
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    "position",
    new BufferAttribute(new Float32Array(HAND_BONES.length * 2 * 3), 3),
  );
  const bones = new LineSegments(geometry, new LineBasicMaterial());
  bones.frustumCulled = false;
  const group = new Group();
  group.add(joints, bones);
  group.visible = false;
  return { group, joints, bones };
}

export function HandsLayer({
  capture,
  clock,
  theme,
  handsKeptFromUs,
  framesLoadedToUs,
}: LayerProps & {
  handsKeptFromUs: number | null;
  framesLoadedToUs: number | null;
}) {
  const views = useMemo(
    () =>
      ({ left: handView(), right: handView() }) as Record<Handedness, HandView>,
    [],
  );
  useEffect(
    () => () => {
      for (const view of Object.values(views)) {
        view.joints.geometry.dispose();
        (view.joints.material as MeshBasicMaterial).dispose();
        view.joints.dispose();
        view.bones.geometry.dispose();
        (view.bones.material as LineBasicMaterial).dispose();
      }
    },
    [views],
  );

  for (const side of ["left", "right"] as const) {
    const color = themed(HAND_COLORS[side], theme);
    (views[side].joints.material as MeshBasicMaterial).color.set(color);
    (views[side].bones.material as LineBasicMaterial).color.set(color);
  }

  useFrame(() => {
    const tUs = clock.getTimeUs();
    const kept =
      (handsKeptFromUs === null || tUs >= handsKeptFromUs) &&
      (framesLoadedToUs === null || tUs <= framesLoadedToUs);
    const matrix = new Matrix4();
    for (const side of ["left", "right"] as const) {
      const view = views[side];
      const sample = kept ? handAt(capture, side, tUs) : null;
      view.group.visible = sample !== null;
      if (!sample) continue;
      const p = sample.positions;
      const valid = (j: number) => j > 0 && !Number.isNaN(p[j * 3]);
      for (let j = 0; j < HAND_JOINTS; j++) {
        if (valid(j))
          matrix.makeTranslation(p[j * 3], p[j * 3 + 1], p[j * 3 + 2]);
        view.joints.setMatrixAt(j, valid(j) ? matrix : HIDDEN);
      }
      view.joints.instanceMatrix.needsUpdate = true;
      const attribute = view.bones.geometry.getAttribute(
        "position",
      ) as BufferAttribute;
      const out = attribute.array as Float32Array;
      HAND_BONES.forEach(([a, b], i) => {
        // A bone with an untracked end collapses onto its other end (or the origin), drawing nothing.
        const from = valid(a) ? a : valid(b) ? b : -1;
        const to = valid(b) ? b : from;
        for (const [k, j] of [
          [0, from],
          [1, to],
        ] as const) {
          for (let c = 0; c < 3; c++)
            out[i * 6 + k * 3 + c] = j < 0 ? 0 : p[j * 3 + c];
        }
      });
      attribute.needsUpdate = true;
    }
  });

  return (
    <group>
      <primitive object={views.left.group} />
      <primitive object={views.right.group} />
    </group>
  );
}

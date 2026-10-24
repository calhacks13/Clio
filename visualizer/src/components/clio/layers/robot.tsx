"use client";

import { Html } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import type { RetargetDoc } from "@clio/protocol";
import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  BufferAttribute,
  BufferGeometry,
  Group,
  InstancedMesh,
  Line,
  LineDashedMaterial,
  LineSegments,
  Matrix4,
  MeshBasicMaterial,
  SphereGeometry,
} from "three";
import { armBase, armsAt, gripperLines } from "@/lib/clio/derived-display";
import { SCENE_COLORS, themed } from "@/lib/clio/object-display";
import type { LayerProps } from "../clio-scene";

// Each retargeted robot arm (retarget-<profile>.json) at the grid frame in force at the viewed
// time: dashed links between consecutive joint origins, small joint markers and a gripper at the
// tool, open or closed as the pinch was. The arm is solved by inverse kinematics from the hand, not
// measured, so it takes the inferred look (DESIGN.md): the muted color, dashed. An arm with no
// solution at that time (null q) is not drawn. The label names the robot and says "Retargeted".

const JOINT_RADIUS = 0.006;
const HIDDEN = new Matrix4().makeScale(0, 0, 0);
const LINK_DASH = { dashSize: 0.012, gapSize: 0.008 };
const GRIPPER_DASH = { dashSize: 0.006, gapSize: 0.004 };

interface ArmView {
  group: Group;
  links: Line;
  joints: InstancedMesh;
  gripper: LineSegments;
}

/** Room for the longest chain the arm has at any frame. */
function maxLinks(arm: RetargetDoc["arms"][number]): number {
  let n = 0;
  for (const links of arm.links) n = Math.max(n, links?.length ?? 0);
  return n;
}

function armView(
  points: number,
  materials: {
    link: LineDashedMaterial;
    gripper: LineDashedMaterial;
    joint: MeshBasicMaterial;
  },
): ArmView {
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    "position",
    new BufferAttribute(new Float32Array(Math.max(points, 2) * 3), 3),
  );
  const links = new Line(geometry, materials.link);
  links.frustumCulled = false;
  const joints = new InstancedMesh(
    new SphereGeometry(JOINT_RADIUS, 10, 8),
    materials.joint,
    Math.max(points, 1),
  );
  joints.frustumCulled = false;
  const gripperGeometry = new BufferGeometry();
  gripperGeometry.setAttribute(
    "position",
    new BufferAttribute(new Float32Array(6 * 3), 3),
  );
  const gripper = new LineSegments(gripperGeometry, materials.gripper);
  gripper.frustumCulled = false;
  const group = new Group();
  group.add(links, joints, gripper);
  group.visible = false;
  return { group, links, joints, gripper };
}

function RetargetedRobot({
  doc,
  clock,
  theme,
}: Pick<LayerProps, "clock" | "theme"> & { doc: RetargetDoc }) {
  const parts = useMemo(() => {
    const materials = {
      link: new LineDashedMaterial(LINK_DASH),
      gripper: new LineDashedMaterial(GRIPPER_DASH),
      joint: new MeshBasicMaterial(),
    };
    const arms = doc.arms.map((arm) => armView(maxLinks(arm), materials));
    return { materials, arms };
  }, [doc]);
  useEffect(
    () => () => {
      for (const arm of parts.arms) {
        arm.links.geometry.dispose();
        arm.joints.geometry.dispose();
        arm.joints.dispose();
        arm.gripper.geometry.dispose();
      }
      for (const material of Object.values(parts.materials)) {
        material.dispose();
      }
    },
    [parts],
  );
  const label = useRef<HTMLSpanElement | null>(null);
  // The label mounts after the canvas's first frame (Html renders through a portal), so it asks for
  // another frame to be shown or hidden.
  const invalidate = useThree((s) => s.invalidate);
  const labelRef = useCallback(
    (element: HTMLSpanElement | null) => {
      label.current = element;
      if (element) invalidate();
    },
    [invalidate],
  );
  const color = themed(SCENE_COLORS.muted, theme);
  for (const material of Object.values(parts.materials)) {
    material.color.set(color);
  }
  const base = doc.arms[0] ? armBase(doc.arms[0]) : null;

  useFrame(() => {
    const poses = armsAt(doc, clock.getTimeUs());
    const matrix = new Matrix4();
    poses.forEach((pose, i) => {
      const view = parts.arms[i];
      view.group.visible = pose !== null;
      if (!pose) return;
      const attribute = view.links.geometry.getAttribute(
        "position",
      ) as BufferAttribute;
      const out = attribute.array as Float32Array;
      const n = Math.min(pose.links.length, out.length / 3);
      for (let j = 0; j < n; j++) out.set(pose.links[j], j * 3);
      attribute.needsUpdate = true;
      view.links.geometry.setDrawRange(0, n);
      view.links.computeLineDistances();
      for (let j = 0; j < view.joints.count; j++) {
        if (j < n) matrix.makeTranslation(...pose.links[j]);
        view.joints.setMatrixAt(j, j < n ? matrix : HIDDEN);
      }
      view.joints.instanceMatrix.needsUpdate = true;
      const fingers =
        pose.gripper === null ? null : gripperLines(pose.links, pose.gripper);
      view.gripper.visible = fingers !== null;
      if (fingers) {
        const grip = view.gripper.geometry.getAttribute(
          "position",
        ) as BufferAttribute;
        fingers.forEach((p, j) => (grip.array as Float32Array).set(p, j * 3));
        grip.needsUpdate = true;
        view.gripper.computeLineDistances();
      }
    });
    if (label.current) {
      const shown = poses.some((pose) => pose !== null);
      label.current.style.display = shown ? "" : "none";
    }
  });

  return (
    <group>
      {parts.arms.map((arm, i) => (
        <primitive key={i} object={arm.group} />
      ))}
      {base && (
        <Html
          position={[base[0], base[1], base[2] + 0.03]}
          pointerEvents="none"
          zIndexRange={[20, 0]}
        >
          <span
            ref={labelRef}
            title={
              doc.profile.example
                ? "Solved from the hand, not measured. An example robot, not real hardware"
                : "Solved from the hand, not measured"
            }
            className="pointer-events-auto flex -translate-x-1/2 -translate-y-full items-center gap-2 whitespace-nowrap rounded-full bg-surface-0 px-2 py-0.5 text-xs font-medium leading-4 text-fg-muted"
            style={{ display: "none" }}
          >
            <span>Retargeted</span>
            <span className="text-fg-soft">{doc.profile.robot}</span>
          </span>
        </Html>
      )}
    </group>
  );
}

/** Every retargeted robot of the episode, one per profile. */
export function RobotLayer({
  clock,
  theme,
  retarget,
}: LayerProps & { retarget: readonly RetargetDoc[] }) {
  return (
    <group>
      {retarget.map((doc, i) => (
        <RetargetedRobot
          key={`${doc.profile.id}-${i}`}
          doc={doc}
          clock={clock}
          theme={theme}
        />
      ))}
    </group>
  );
}

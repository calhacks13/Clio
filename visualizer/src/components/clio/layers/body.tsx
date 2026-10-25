"use client";

import { Html } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import type { BodyDoc } from "@clio/protocol";
import { useCallback, useEffect, useState } from "react";
import {
  type BufferGeometry,
  Group,
  LoaderUtils,
  LoadingManager,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  Quaternion,
} from "three";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import URDFLoader, { type URDFRobot } from "urdf-loader";
import { bodyAt } from "@/lib/clio/derived-display";
import { themed } from "@/lib/clio/object-display";
import type { LayerProps } from "../clio-scene";

// The whole Unitree G1 of body-g1.json at the viewed time (blended between grid frames): the real
// URDF and its meshes (the bucket the dataset viewer uses), its pelvis placed and its joints set
// from the document, so the robot does the task where the learner did it. It is drawn at the
// learner's size (1 / the document's scale), so its head and palms sit on the measured head and
// hands; it is solid and lit in the dataset viewer's G1 colors, because a wireframe of 87 meshes
// hides the motion it is there to show. Only the head and hands were measured; the pelvis, legs,
// waist, elbows and fingers are posed by rule, so the label says "Inferred" and names the robot
// (DESIGN.md). A frame with no pose hides it.

const URDF_BASE_URL =
  process.env.NEXT_PUBLIC_URDF_BASE_URL ??
  "https://huggingface.co/buckets/lerobot/robot-urdfs/resolve";

/** The G1's own axes (x forward, y left, z up) are the scene's ROS axes, so the pose needs one turn: W into ROS. */
const ROS_FROM_W = new Quaternion().setFromRotationMatrix(
  new Matrix4().set(0, 0, -1, 0, -1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1),
);

/** Dark carbon shells and light gray trim, the dataset viewer's G1 (urdf-viewer.tsx). */
const G1_COLORS = {
  shell: { light: "#1F2937", dark: "#4B5563" },
  trim: { light: "#9CA3AF", dark: "#C4C9D1" },
};

/** The dataset viewer's rule for the G1's light parts: contours, roll links, rubber and supports. */
function isTrim(meshUrl: string): boolean {
  const lower = meshUrl.toLowerCase();
  return [
    "contour",
    "roll_link",
    "logo",
    "rubber",
    "constraint",
    "support",
  ].some((part) => lower.includes(part));
}

interface LoadedRobot {
  robot: URDFRobot;
  /** Shared by every mesh of the robot, recolored for the theme. */
  materials: { shell: MeshStandardMaterial; trim: MeshStandardMaterial };
}

const robots = new Map<string, Promise<LoadedRobot>>();

/** One download and parse per URDF per session; the one robot is shared by whoever draws it. */
function loadRobot(url: string): Promise<LoadedRobot> {
  let loading = robots.get(url);
  if (!loading) {
    const materials = {
      shell: new MeshStandardMaterial({ metalness: 0.15, roughness: 0.6 }),
      trim: new MeshStandardMaterial({ metalness: 0.1, roughness: 0.5 }),
    };
    loading = new Promise<LoadedRobot>((resolve, reject) => {
      const manager = new LoadingManager();
      const loader = new URDFLoader(manager);
      loader.workingPath = LoaderUtils.extractUrlBase(url);
      const stl = new STLLoader(manager);
      loader.loadMeshCb = (meshUrl, _mgr, onLoad) => {
        stl.load(
          meshUrl,
          (geometry: BufferGeometry) => {
            if (!geometry.getAttribute("normal"))
              geometry.computeVertexNormals();
            // URDFLoader replaces the material of a bare Mesh; a Group keeps ours.
            const group = new Group();
            group.add(
              new Mesh(
                geometry,
                isTrim(meshUrl) ? materials.trim : materials.shell,
              ),
            );
            onLoad(group);
          },
          undefined,
          (err) => onLoad(new Group(), err as Error),
        );
      };
      let robot: URDFRobot | null = null;
      manager.onLoad = () => robot && resolve({ robot, materials });
      fetch(url)
        .then((res) => {
          if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
          return res.text();
        })
        .then((text) => {
          robot = loader.parse(text);
        })
        .catch(reject);
    }).catch((err) => {
      robots.delete(url);
      for (const material of Object.values(materials)) material.dispose();
      throw err;
    });
    robots.set(url, loading);
  }
  return loading;
}

export function BodyLayer({
  clock,
  theme,
  body,
}: Pick<LayerProps, "clock" | "theme"> & { body: BodyDoc }) {
  const [loaded, setLoaded] = useState<LoadedRobot | null>(null);
  const robot = loaded?.robot ?? null;
  const invalidate = useThree((s) => s.invalidate);
  const url = `${URDF_BASE_URL}/${body.profile.urdf}`;

  useEffect(() => {
    let live = true;
    loadRobot(url)
      .then((next) => {
        if (!live) return;
        setLoaded(next);
        invalidate();
      })
      .catch((err) => console.warn(`G1 not drawn: ${String(err)}`));
    return () => {
      live = false;
    };
  }, [url, invalidate]);
  // The materials belong to the cached robot, so they outlive this layer and are never disposed here.
  if (loaded) {
    loaded.materials.shell.color.set(themed(G1_COLORS.shell, theme));
    loaded.materials.trim.color.set(themed(G1_COLORS.trim, theme));
  }

  const [label, setLabel] = useState<HTMLSpanElement | null>(null);
  const labelRef = useCallback(
    (element: HTMLSpanElement | null) => {
      setLabel(element);
      if (element) invalidate();
    },
    [invalidate],
  );
  const [anchor] = useState(() => new Group());

  useFrame(() => {
    if (!robot) return;
    const pose = bodyAt(body, clock.getTimeUs());
    robot.visible = pose !== null;
    if (label) label.style.display = pose ? "" : "none";
    if (!pose) return;
    robot.position.set(...pose.position);
    robot.scale.setScalar(pose.size);
    robot.quaternion
      .copy(ROS_FROM_W)
      .multiply(new Quaternion(...pose.rotation));
    pose.joints.forEach((value, i) =>
      robot.setJointValue(body.joints[i], value),
    );
    anchor.position.set(
      pose.position[0],
      pose.position[1],
      pose.position[2] + 0.75 * pose.size,
    );
  });

  return (
    <group>
      {robot && <primitive object={robot as Object3D} />}
      <primitive object={anchor}>
        <Html pointerEvents="none" zIndexRange={[20, 0]}>
          <span
            ref={labelRef}
            title="Only the head and hands were measured; the legs, waist, elbows and fingers are inferred"
            className="pointer-events-auto flex -translate-x-1/2 -translate-y-full items-center gap-2 whitespace-nowrap rounded-full bg-surface-0 px-2 py-0.5 text-xs font-medium leading-4 text-fg-muted"
            style={{ display: "none" }}
          >
            <span>Inferred</span>
            <span className="text-fg-soft">Unitree G1</span>
          </span>
        </Html>
      </primitive>
    </group>
  );
}

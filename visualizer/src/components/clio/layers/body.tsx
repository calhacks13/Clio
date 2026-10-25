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
  MeshBasicMaterial,
  type Object3D,
  Quaternion,
} from "three";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import URDFLoader, { type URDFRobot } from "urdf-loader";
import { bodyAt } from "@/lib/clio/derived-display";
import { SCENE_COLORS, themed } from "@/lib/clio/object-display";
import type { LayerProps } from "../clio-scene";

// The whole Unitree G1 of body-g1.json at the grid frame in force at the viewed time: the real URDF
// (the bucket the dataset viewer uses), its pelvis placed and its joints set from the document.
// Only the head and hands were measured; the pelvis, legs, waist and fingers are posed by rule, so
// the robot takes the inferred look (DESIGN.md): muted and drawn as a wireframe. A frame with no
// pose hides it. The label says "Inferred" and names the robot.

const URDF_BASE_URL =
  process.env.NEXT_PUBLIC_URDF_BASE_URL ??
  "https://huggingface.co/buckets/lerobot/robot-urdfs/resolve";

/** The G1's own axes (x forward, y left, z up) are the scene's ROS axes, so the pose needs one turn: W into ROS. */
const ROS_FROM_W = new Quaternion().setFromRotationMatrix(
  new Matrix4().set(0, 0, -1, 0, -1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1),
);

const robots = new Map<string, Promise<URDFRobot>>();

/** One download and parse per URDF per session; the one robot is shared by whoever draws it. */
function loadRobot(
  url: string,
  material: MeshBasicMaterial,
): Promise<URDFRobot> {
  let loading = robots.get(url);
  if (!loading) {
    loading = new Promise<URDFRobot>((resolve, reject) => {
      const manager = new LoadingManager();
      const loader = new URDFLoader(manager);
      loader.workingPath = LoaderUtils.extractUrlBase(url);
      const stl = new STLLoader(manager);
      loader.loadMeshCb = (meshUrl, _mgr, onLoad) => {
        stl.load(
          meshUrl,
          (geometry: BufferGeometry) => {
            // URDFLoader replaces the material of a bare Mesh; a Group keeps ours.
            const group = new Group();
            group.add(new Mesh(geometry, material));
            onLoad(group);
          },
          undefined,
          (err) => onLoad(new Group(), err as Error),
        );
      };
      let robot: URDFRobot | null = null;
      manager.onLoad = () => robot && resolve(robot);
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
  const [material] = useState(() => new MeshBasicMaterial({ wireframe: true }));
  material.color.set(themed(SCENE_COLORS.muted, theme));
  const [robot, setRobot] = useState<URDFRobot | null>(null);
  const invalidate = useThree((s) => s.invalidate);
  const url = `${URDF_BASE_URL}/${body.profile.urdf}`;

  useEffect(() => {
    let live = true;
    loadRobot(url, material)
      .then((loaded) => {
        if (!live) return;
        setRobot(loaded);
        invalidate();
      })
      .catch((err) => console.warn(`G1 not drawn: ${String(err)}`));
    return () => {
      live = false;
    };
  }, [url, material, invalidate]);
  useEffect(() => () => material.dispose(), [material]);

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
    robot.quaternion
      .copy(ROS_FROM_W)
      .multiply(new Quaternion(...pose.rotation));
    pose.joints.forEach((value, i) =>
      robot.setJointValue(body.joints[i], value),
    );
    anchor.position.set(
      pose.position[0],
      pose.position[1],
      pose.position[2] + 0.75,
    );
  });

  return (
    <group>
      {robot && <primitive object={robot as Object3D} />}
      <primitive object={anchor}>
        <Html pointerEvents="none" zIndexRange={[20, 0]}>
          <span
            ref={labelRef}
            title="Only the head and hands were measured; the legs, waist and fingers are inferred"
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

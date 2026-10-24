"use client";

import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useState } from "react";
import {
  BufferGeometry,
  Float32BufferAttribute,
  LineBasicMaterial,
  LineLoop,
} from "three";
import {
  type DetectionOutline,
  outlinesAt,
} from "@/lib/clio/detection-geometry";
import { SCENE_COLORS, themed } from "@/lib/clio/object-display";
import type { LayerProps } from "../clio-scene";

// The newest object finder outline per object, among the answers that had arrived by the viewed
// time: a line loop in the detection color with no fill, labeled "Approximate" because it assumes
// a camera model (the reason is in the label's tooltip). The set changes only when the time crosses
// an answer, so it is React state, updated from the frame loop when it differs.

function Outline({
  outline,
  color,
}: {
  outline: DetectionOutline;
  color: string;
}) {
  const loop = useMemo(
    () =>
      new LineLoop(
        new BufferGeometry().setAttribute(
          "position",
          new Float32BufferAttribute(outline.points.flat(), 3),
        ),
        new LineBasicMaterial(),
      ),
    [outline.points],
  );
  useEffect(
    () => () => {
      loop.geometry.dispose();
      (loop.material as LineBasicMaterial).dispose();
    },
    [loop],
  );
  (loop.material as LineBasicMaterial).color.set(color);
  // The label sits on the outline's highest point.
  const top = outline.points.reduce((a, b) => (b[2] > a[2] ? b : a));
  return (
    <>
      <primitive object={loop} />
      <Html position={top} zIndexRange={[20, 0]}>
        <span
          title="Assumed camera model"
          className="block -translate-x-1/2 -translate-y-full whitespace-nowrap pb-1 text-[11px] font-medium leading-4"
          style={{ color }}
        >
          Approximate
        </span>
      </Html>
    </>
  );
}

const keyOf = (outlines: readonly DetectionOutline[]) =>
  outlines.map((o) => o.eventSequence).join(",");

export function DetectionsLayer({ capture, clock, theme }: LayerProps) {
  const [shown, setShown] = useState<{
    capture: LayerProps["capture"];
    outlines: DetectionOutline[];
  }>({ capture, outlines: [] });
  useFrame(() => {
    const next = outlinesAt(capture, clock.getTimeUs());
    if (shown.capture !== capture || keyOf(next) !== keyOf(shown.outlines))
      setShown({ capture, outlines: next });
  });
  const color = themed(SCENE_COLORS.detection, theme);
  const outlines = shown.capture === capture ? shown.outlines : [];
  return (
    <group>
      {outlines.map((outline) => (
        <Outline key={outline.eventSequence} outline={outline} color={color} />
      ))}
    </group>
  );
}

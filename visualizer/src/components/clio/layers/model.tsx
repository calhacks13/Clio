"use client";

import { useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import {
  Color,
  DoubleSide,
  EdgesGeometry,
  type Group,
  type LineBasicMaterial,
  LineSegments,
  type Material,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  type MeshStandardMaterial,
  Quaternion,
} from "three";
import type { ModelFile } from "@/lib/clio/scene-files";
import { modelPlacement } from "@/lib/clio/scene-display";
import { useSceneFile } from "../use-scene-file";
import { disposeTree, meshesOf, parseGlb, W_TO_ROS } from "./gltf";

// An object's generated model (scene/model-<id>.glb: meters, +y up, origin at the bottom center),
// drawn inside the object's group so it rides on the compiled position and hides with it. Its
// placement (an offset and a yaw, in W) reaches ROS once in scene-display.ts; the GLB's own axes
// are W's, so it sits in a group turned from W to ROS.
//
// A generator made it, so it takes the generated look (DESIGN.md): its own colors, lightly
// desaturated and lit, at half opacity so the measured dot inside stays visible, and its visible
// creases as a thin outline in the object's color. Only the nearest surface draws: a depth-only
// pass of the model goes first, so its back faces and inner parts never show through.

const GENERATED_OPACITY = 0.5;
/** How far each color moves toward its own gray. */
const DESATURATE = 0.35;
const OUTLINE_CREASE_DEG = 30;

/** The model's own color, desaturated: diffuseColor after its map and vertex colors. */
function desaturate(material: MeshLambertMaterial): void {
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <color_fragment>",
      `#include <color_fragment>
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722))), ${DESATURATE.toFixed(2)});`,
    );
  };
  material.customProgramCacheKey = () => "clio-generated";
}

/** The generated look of one of the file's materials, keeping its color, map and vertex colors. */
function generatedMaterial(source: Material): MeshLambertMaterial {
  const from = source as Partial<MeshStandardMaterial>;
  const material = new MeshLambertMaterial({
    color: from.color?.clone() ?? new Color(1, 1, 1),
    map: from.map ?? null,
    vertexColors: from.vertexColors ?? false,
    side: DoubleSide,
    transparent: true,
    opacity: GENERATED_OPACITY * (from.opacity ?? 1),
    depthWrite: false,
  });
  desaturate(material);
  return material;
}

export interface ModelView {
  root: Group;
  /** The outline of every mesh: the layer gives them the object's line material. */
  outlines: LineSegments[];
}

/** The parsed model in the generated look. Only its surfaces take clicks, to select the object. */
export function prepareModel(root: Group): ModelView {
  // Writes depth only, a hair behind the surface, so only the nearest surface and its creases draw.
  const depth = new MeshBasicMaterial({
    colorWrite: false,
    transparent: true,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
  const generated = new Map<Material, MeshLambertMaterial>();
  const look = (m: Material) => {
    let material = generated.get(m);
    if (!material) {
      material = generatedMaterial(m);
      generated.set(m, material);
    }
    return material;
  };
  const outlines: LineSegments[] = [];
  for (const mesh of meshesOf(root)) {
    mesh.material = Array.isArray(mesh.material)
      ? mesh.material.map(look)
      : look(mesh.material);
    mesh.renderOrder = 2;
    const prepass = new Mesh(mesh.geometry, depth);
    prepass.renderOrder = 1;
    prepass.raycast = () => {};
    const outline = new LineSegments(
      new EdgesGeometry(mesh.geometry, OUTLINE_CREASE_DEG),
    );
    outline.renderOrder = 3;
    outline.raycast = () => {};
    mesh.add(prepass, outline);
    outlines.push(outline);
  }
  // The file's own materials are never drawn; their textures live on in the generated ones.
  for (const m of generated.keys()) m.dispose();
  return { root, outlines };
}

/** model-<id>.glb as the objects layer draws it; a file that is not a GLB reads as invalid. */
export async function loadModel(bytes: ArrayBuffer): Promise<ModelView> {
  return prepareModel(await parseGlb(bytes));
}

/** Releases the model's geometries, materials and textures, the outlines' too. */
export function disposeModel(model: ModelView): void {
  for (const outline of model.outlines) {
    // The line material is the object's, released with it.
    outline.removeFromParent();
    outline.geometry.dispose();
  }
  disposeTree(model.root);
}

export function GeneratedModel({
  file,
  outline,
}: {
  file: ModelFile;
  /** The object's outline material: its identity color, or muted where it is not tracked. */
  outline: LineBasicMaterial;
}) {
  const { value: model } = useSceneFile(file.file, loadModel, disposeModel);
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => invalidate(), [model, invalidate]);
  const placement = useMemo(() => modelPlacement(file.model), [file.model]);
  const rotation = useMemo(
    () => new Quaternion(...placement.rotation),
    [placement],
  );
  if (!model) return null;
  for (const line of model.outlines) line.material = outline;
  return (
    <group position={placement.offset} quaternion={rotation} name="model">
      <group quaternion={W_TO_ROS}>
        <primitive object={model.root} />
      </group>
    </group>
  );
}

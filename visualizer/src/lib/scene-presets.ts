import blockStacking from "../../public/examples/g1-blockstacking.scene.json";
import { DEFAULT_HUMANOID_DATASET } from "./humanoid";
import { isG1Robot } from "./so101-robot";
import { EMPTY_SCENE, parseScene, type SceneDocument } from "./scene";

/** Height from the reference URDF's ankle frames and foot collision spheres. */
export const G1_REFERENCE_PELVIS_HEIGHT = 0.7918637524222113;
export function defaultSceneForDataset(
  scope: string,
  robotType: string | null,
): SceneDocument {
  if (scope === DEFAULT_HUMANOID_DATASET) return parseScene(blockStacking);
  if (isG1Robot(robotType))
    return {
      ...structuredClone(EMPTY_SCENE),
      originDescription: "Floor between the feet in the G1 reference stance.",
      frames: [
        {
          ...structuredClone(EMPTY_SCENE.frames[0]),
          translation: [0, 0, G1_REFERENCE_PELVIS_HEIGHT],
        },
      ],
    };
  return structuredClone(EMPTY_SCENE);
}

/** Replace the old untouched pelvis-origin scene, preserving all user-authored scenes. */
export function sceneWithDefaults(
  saved: unknown,
  defaults: SceneDocument,
): SceneDocument {
  if (!saved) return defaults;
  const doc = parseScene(saved);
  const root = doc.frames[0];
  const legacyEmpty =
    !doc.originDescription &&
    !doc.preset &&
    doc.objects.length === 0 &&
    doc.frames.length === 1 &&
    root.id === "base_link" &&
    root.parent === "world" &&
    root.translation.every((n) => n === 0) &&
    root.rotation.every((n, i) => n === [0, 0, 0, 1][i]);
  return legacyEmpty ? defaults : doc;
}

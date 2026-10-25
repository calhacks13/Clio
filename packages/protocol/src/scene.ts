import { z } from 'zod';
import { DerivedInputSchema } from './derived';
import { NormalizedBoxSchema, QuatSchema, Vec3Schema } from './geometry';

// What `clio scene` builds from a compiled episode into data/scenes/<id>/ (docs/room-scene.md): a
// model of each object to look at, beside the measurements. The room itself is the Quest room scan
// the compile already keeps (derived room.glb); nothing here rebuilds it.
//
//   scene.json         SceneDoc: what was built, from which inputs, and how each model was made
//   model-<id>.glb     a generated model of each object, scaled to its measured size
//   crop-<id>-<n>.jpg  the keyframe crops an object's model was made from
//
// Unlike data/derived/<id>/, a scene build runs an image-to-3D model (TripoSR), so it is its own
// step with its own staleness. Every spatial value is in the episode's workspace frame W. A model's
// appearance is generated, never measured: it is scaled and placed by what was measured.

export const SCENE_SCHEMA_ID = 'clio.scene/1';

/** File names the server serves from data/scenes/<id>/ and the visualizer's proxy allows. */
export const SCENE_FILE_NAME = /^[a-z0-9][a-z0-9._-]{0,95}\.(json|glb|jpg)$/;

/**
 * How an object's model was made. primitive: a box or cylinder from its measured size and the
 * crops' color. triposr: TripoSR made the mesh from the best crop, on the machine that built the
 * scene (marching cubes on a 128 grid by default). command: an external image-to-3D command
 * ($CLIO_MODEL_COMMAND) made the mesh from the best crop. The last two are scaled to the measured
 * height and placed like the primitive.
 */
export const ModelBackendSchema = z.enum(['primitive', 'triposr', 'command']);

export const SceneStageSchema = z.object({
  name: z.string(),
  status: z.enum(['ok', 'failed', 'skipped']),
  detail: z.string().optional(),
});

const sceneFile = () => z.string().regex(SCENE_FILE_NAME);

export const SceneCropSchema = z.object({
  file: sceneFile(),
  keyframe: z.string().describe('The keyframe it was cut from, in the episode media/'),
  box: NormalizedBoxSchema.describe('Where in the keyframe, before the margin'),
  from: z
    .enum(['observation', 'projection'])
    .describe(
      "observation: the tracker's box on that same camera frame; projection: the object's compiled position and size projected through the keyframe's pose",
    ),
});

export const SceneModelSchema = z.object({
  id: z.string(),
  label: z.string(),
  backend: ModelBackendSchema,
  generator: z
    .string()
    .nullable()
    .describe('What generated it, e.g. "TripoSR (grid 128)" or the command; null for primitive'),
  model: sceneFile()
    .nullable()
    .describe(
      'GLB in meters, +y up, origin at the bottom center of its bounds; null when none could be made',
    ),
  crops: z.array(SceneCropSchema),
  size: Vec3Schema.describe("The model's bounds after fitting, m, along its own x, y (up), z"),
  sizeSource: z
    .enum(['shape', 'extent', 'radius'])
    .describe(
      "Which measurement scaled it: the fused shape box, the estimated extent, or the plan's radius",
    ),
  placement: z.object({
    offset: Vec3Schema.describe(
      "From the object's tracked position (tracks.json) to the model origin, in W",
    ),
    rotation: QuatSchema.describe('Model rotation in W: a yaw about +y'),
    rotationSource: z
      .enum(['shape', 'view', 'none'])
      .describe(
        "shape: the fused shape box's yaw (measured); view: turned to face the camera that saw it (a guess); none: unrotated",
      ),
  }),
  note: z.string().nullable().describe('Why something was left out or approximated'),
});

export const SceneDocSchema = z.object({
  schema: z.literal(SCENE_SCHEMA_ID),
  episodeId: z.string(),
  builtAt: z.iso.datetime(),
  builder: z.object({ name: z.string(), version: z.string() }),
  frame: z.literal('workspace'),
  compiledAt: z.iso
    .datetime()
    .describe(
      "The compile it was built from (manifest.json's compiledAt): a newer compile makes it stale",
    ),
  inputs: z
    .array(DerivedInputSchema)
    .describe(
      'Raw and compiled files the build read (names relative to the episode or "derived/")',
    ),
  options: z.object({ models: ModelBackendSchema }),
  stages: z.array(SceneStageSchema),
  keyframes: z.number().int().nonnegative().describe('Keyframes the episode has with their image'),
  objects: z.array(SceneModelSchema),
});

export type ModelBackend = z.infer<typeof ModelBackendSchema>;
export type SceneStage = z.infer<typeof SceneStageSchema>;
export type SceneCrop = z.infer<typeof SceneCropSchema>;
export type SceneModel = z.infer<typeof SceneModelSchema>;
export type SceneDoc = z.infer<typeof SceneDocSchema>;

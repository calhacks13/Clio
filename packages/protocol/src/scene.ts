import { z } from 'zod';
import { DerivedInputSchema } from './derived';
import { NormalizedBoxSchema, QuatSchema, Vec3Schema } from './geometry';

// What `clio scene` builds from a compiled episode into data/scenes/<id>/ (docs/data-pipeline.md,
// "Rebuilt scene"): the room and its objects as things to look at, beside the measurements.
//
//   scene.json         SceneDoc: what was built, from which inputs, and how each part was made
//   room-colored.glb   the Quest room scan with colors projected from the keyframes
//   splat.ply          a Gaussian splat of the room trained on the keyframes (3DGS PLY)
//   model-<id>.glb     a generated model of each object, scaled to its measured size
//   cad-<id>.json      the CAD program a generated model was built from (gemini-cad)
//   crop-<id>-<n>.jpg  the keyframe crops an object's model was made from
//
// Unlike data/derived/<id>/, a scene build can be slow (training a splat) and can call a model
// service (gemini-cad), so it is its own step with its own staleness. Every spatial value is in
// the episode's workspace frame W. Generated appearance is never a measurement: the room's shape
// comes from the headset, its colors and the splat from the keyframes, and each object's model
// from a generator, scaled and placed by what was measured.

export const SCENE_SCHEMA_ID = 'clio.scene/1';

/** File names the server serves from data/scenes/<id>/ and the visualizer's proxy allows. */
export const SCENE_FILE_NAME = /^[a-z0-9][a-z0-9._-]{0,95}\.(json|glb|ply|jpg)$/;

/**
 * How an object's model was made. primitive: a box or cylinder from its measured size and the
 * crops' color, offline. gemini-cad: Gemini wrote a CAD program (parts with dimensions) from the
 * crops, the label and the measured size; the pipeline built the mesh from it. command: an
 * external image-to-3D command ($CLIO_MODEL_COMMAND) made the mesh from the best crop.
 */
export const ModelBackendSchema = z.enum(['primitive', 'gemini-cad', 'command']);

export const SceneStageSchema = z.object({
  name: z.string(),
  status: z.enum(['ok', 'failed', 'skipped']),
  detail: z.string().optional(),
});

const sceneFile = () => z.string().regex(SCENE_FILE_NAME);

export const SceneRoomMeshSchema = z.object({
  file: sceneFile().describe('"room-colored.glb": the room scan with COLOR_0 per vertex, in W'),
  source: z.literal('quest-scene'),
  coloredShare: z
    .number()
    .min(0)
    .max(1)
    .describe('Share of vertices at least one keyframe saw; the rest keep a neutral gray'),
  keyframes: z.number().int().nonnegative().describe('Keyframes the colors came from'),
});

export const SceneSplatSchema = z.object({
  file: sceneFile().describe('"splat.ply": 3D Gaussian splatting PLY, positions in W'),
  trainer: z.object({ name: z.string(), version: z.string().nullable() }),
  steps: z.number().int().positive(),
  keyframes: z.number().int().positive().describe('Images it was trained on'),
  splats: z.number().int().nonnegative().nullable().describe('Gaussians in the file, if read'),
  init: z
    .enum(['room-scan', 'depth', 'random'])
    .describe('Where the starting points came from: the colored room scan, depth samples, or none'),
});

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
    .describe('What generated it, e.g. "gemini-pro-latest" or the command; null for primitive'),
  model: sceneFile()
    .nullable()
    .describe(
      'GLB in meters, +y up, origin at the bottom center of its bounds; null when none could be made',
    ),
  cad: sceneFile().nullable().describe('The CAD program the model was built from (gemini-cad)'),
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
  options: z.object({
    models: ModelBackendSchema,
    splatSteps: z.number().int().nonnegative().describe('0: no splat was asked for'),
  }),
  stages: z.array(SceneStageSchema),
  keyframes: z.number().int().nonnegative(),
  room: SceneRoomMeshSchema.nullable(),
  splat: SceneSplatSchema.nullable(),
  objects: z.array(SceneModelSchema),
});

export type ModelBackend = z.infer<typeof ModelBackendSchema>;
export type SceneStage = z.infer<typeof SceneStageSchema>;
export type SceneRoomMesh = z.infer<typeof SceneRoomMeshSchema>;
export type SceneSplat = z.infer<typeof SceneSplatSchema>;
export type SceneCrop = z.infer<typeof SceneCropSchema>;
export type SceneModel = z.infer<typeof SceneModelSchema>;
export type SceneDoc = z.infer<typeof SceneDocSchema>;

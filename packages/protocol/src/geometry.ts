import { z } from 'zod';

// Conventions (see docs/data-format.md): meters, right-handed, +y up (WebXR). Quaternions are
// [x, y, z, w]. A pose is position followed by orientation: [px, py, pz, qx, qy, qz, qw].

const n = () => z.number();

export const Vec3Schema = z.tuple([n(), n(), n()]).describe('[x, y, z] in meters');
export const QuatSchema = z.tuple([n(), n(), n(), n()]).describe('Unit quaternion [x, y, z, w]');
export const Pose7Schema = z
  .tuple([n(), n(), n(), n(), n(), n(), n()])
  .describe('[px, py, pz, qx, qy, qz, qw]');

export type Vec3 = z.infer<typeof Vec3Schema>;
export type Quat = z.infer<typeof QuatSchema>;
export type Pose7 = z.infer<typeof Pose7Schema>;

export const IDENTITY_POSE7: Readonly<Pose7> = Object.freeze([0, 0, 0, 0, 0, 0, 1]);

// Image coordinates, normalized to 0..1 of the image: x to the right, y down.
const unit = () => z.number().min(0).max(1);
export const NormalizedPointSchema = z
  .tuple([unit(), unit()])
  .describe('[x, y] in 0..1 of the image; x right, y down');
export const NormalizedBoxSchema = z
  .tuple([unit(), unit(), unit(), unit()])
  .describe('[x0, y0, x1, y1] in 0..1 of the image');
export const NormalizedPolygonSchema = z
  .array(NormalizedPointSchema)
  .min(3)
  .max(512)
  .describe('Closed outline in 0..1 image coordinates');

export type NormalizedPoint = z.infer<typeof NormalizedPointSchema>;
export type NormalizedBox = z.infer<typeof NormalizedBoxSchema>;
export type NormalizedPolygon = z.infer<typeof NormalizedPolygonSchema>;

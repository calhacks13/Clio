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

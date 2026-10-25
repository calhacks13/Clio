import type { Procedure } from '@clio/protocol';
import type { Object3D } from 'three';
import type { Pose, Vec3 } from '../../core/math';
import type { HandsSample } from '../../domain/demo/clip-player';
import type { Demonstration } from '../../domain/demo/types';
import type { TrackedFrame } from '../../domain/hands/types';
import type { OverlaySnapshot } from '../../domain/overlay/overlay-model';
import type { CalibrationPrompt } from '../../domain/world/calibration';
import type { ObjectEstimate } from '../../domain/world/object-registry';
import type { Placement } from '../../domain/world/placement';

/** Everything a presenter may read in a frame. Presenters never mutate domain state. */
export interface PresentContext {
  t: number;
  dt: number;
  snapshot: OverlaySnapshot;
  procedure: Procedure | null;
  objects: readonly ObjectEstimate[];
  /** Current live tracker silhouettes in world space, used to keep UI clear of real objects. */
  objectMasks?: readonly Placement[];
  /** Nearby detected furniture geometry in world space, including before a lesson starts. */
  sceneObstacles?: readonly (readonly Vec3[])[];
  demo: Demonstration | null;
  /** Ghost hands for this frame (workspace frame), when a demo is playing. */
  demoHands: HandsSample | null;
  /** Tracked hands, workspace frame. */
  hands: TrackedFrame | null;
  /** Head pose, world frame. */
  head: Pose;
  worldFromWorkspace: Pose;
  calibration: (CalibrationPrompt & { firstCorner: Vec3 | null }) | null;
  debug: boolean;
}

export interface Presenter {
  readonly object: Object3D;
  update(ctx: PresentContext): void;
  dispose?(): void;
}

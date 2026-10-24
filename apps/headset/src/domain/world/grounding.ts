import type { Detection } from '@clio/protocol';
import { type CameraModel, liftDetection } from './camera-model';
import type { ObjectRegistry } from './object-registry';
import type { PoseHistory } from './pose-history';
import type { Workspace } from './workspace';

// Grounding: find the plan's objects in the real scene. A camera frame goes to a VisionLocator
// (open-vocabulary detection, e.g. Gemini spatial understanding on the laptop), each 2D detection
// is lifted into 3D using the head pose at capture time, and the result lands in the registry.

export interface CameraFrame {
  /** Capture time on the performance.now() timeline. */
  t: number;
  width: number;
  height: number;
  jpegBase64: string;
}

/** Port: the passthrough camera. */
export interface CameraFrameSource {
  capture(): Promise<CameraFrame | null>;
  /** Calibration for the frames, or null when unknown. */
  model(): CameraModel | null;
}

/** Port: open-vocabulary 2D detection. */
export interface VisionLocator {
  locate(frame: CameraFrame, objects: { id: string; query: string }[]): Promise<Detection[]>;
}

export type GroundingResult =
  | { ok: true; located: string[]; missing: string[] }
  | {
      ok: false;
      reason: 'no-camera-frame' | 'no-camera-model' | 'no-head-pose' | 'locator-failed';
      detail?: string;
    };

export interface GrounderDeps {
  camera: CameraFrameSource;
  locator: VisionLocator;
  registry: ObjectRegistry;
  /** Head poses in world space. */
  poses: PoseHistory;
  /** Read at use time, because the workspace can be recalibrated. */
  workspace: () => Workspace;
  minConfidence?: number;
}

/** Port used by the lesson: anything that can locate objects by id. */
export interface Grounder {
  ground(ids: readonly string[]): Promise<GroundingResult>;
}

export class ObjectGrounder implements Grounder {
  constructor(private readonly deps: GrounderDeps) {}

  async ground(ids: readonly string[]): Promise<GroundingResult> {
    const { camera, locator, registry, poses } = this.deps;
    const workspace = this.deps.workspace();
    const minConfidence = this.deps.minConfidence ?? 0.3;

    const frame = await camera.capture();
    if (!frame) return { ok: false, reason: 'no-camera-frame' };
    const model = camera.model();
    if (!model) return { ok: false, reason: 'no-camera-model' };
    const head = poses.at(frame.t);
    if (!head) return { ok: false, reason: 'no-head-pose' };

    const queries = ids.flatMap((id) => {
      const spec = registry.spec(id);
      return spec ? [{ id, query: spec.tracking?.query ?? spec.label }] : [];
    });
    let detections: Detection[];
    try {
      detections = await locator.locate(frame, queries);
    } catch (err) {
      return { ok: false, reason: 'locator-failed', detail: String(err) };
    }

    const located: string[] = [];
    const missing: string[] = [];
    for (const { id } of queries) {
      const det = detections.find((d) => d.id === id);
      const world =
        det?.found && det.confidence >= minConfidence
          ? liftDetection(det, model, head, workspace.surfaceY)
          : null;
      if (world && det) {
        registry.observe(id, {
          position: workspace.toWorkspacePoint(world),
          confidence: det.confidence,
          source: 'detector',
          t: frame.t,
        });
        located.push(id);
      } else {
        missing.push(id);
      }
    }
    return { ok: true, located, missing };
  }
}

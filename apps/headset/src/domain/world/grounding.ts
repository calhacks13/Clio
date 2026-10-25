import type { Detection, LocateRequest } from '@clio/protocol';
import type { Vec3 } from '../../core/math';
import { type CameraModel, intersectPlaneY, liftDetection, type Ray } from './camera-model';
import { findWords } from './find-words';
import type { ObjectRegistry } from './object-registry';
import { boxPolygon, liftOutline, type ObjectOutline } from './outline';
import type { PoseHistory } from './pose-history';
import type { Workspace } from './workspace';

// Grounding: find the plan's objects in the real scene. A camera frame and the words for each
// object go to a VisionLocator (an object finder: Gemini, or jev behind the server), each 2D
// answer is lifted into 3D with the head pose at capture time, and the result lands in the
// registry. Outlines are lifted too, for the AR layer to draw around the real object.

export interface CameraFrame {
  /** Capture time on the performance.now() timeline. */
  t: number;
  width: number;
  height: number;
  jpegBase64: string;
}

/** Port: the passthrough camera. */
export interface CameraFrameSource {
  /** A fresh frame, at most `maxWidth` pixels wide (the camera picks a default). */
  capture(maxWidth?: number): Promise<CameraFrame | null>;
  /** Calibration for the frames, or null when unknown. */
  model(): CameraModel | null;
}

/** Port: real surfaces (e.g. WebXR plane detection), in world space. */
export interface SurfaceRaycaster {
  cast(ray: Ray): Vec3 | null;
}

export type LocateObject = LocateRequest['objects'][number];

/** What an object finder answered for one frame. */
export interface LocateAnswer {
  detections: Detection[];
  model: string;
  /** A tracking finder's hint: how soon to send the next frame (ms). */
  refreshMs?: number;
}

/** Port: an open-vocabulary object finder. */
export interface VisionLocator {
  locate(frame: CameraFrame, objects: LocateObject[]): Promise<LocateAnswer>;
}

/** What to find: a declared object and, optionally, the words for it at this moment. */
export interface FindRequest {
  id: string;
  /** A visual description for the finder; defaults to the object's tracking query, then label. */
  description?: string;
  /** A short noun phrase for category-prompted finders; defaults to the object's label. */
  phrase?: string;
}

/** What one grounding pass made of one requested object. */
export interface Sighting {
  id: string;
  /** The words the finder was given. */
  description: string;
  phrase: string;
  /** The finder's 2D answer, in normalized image coordinates. */
  detection: Detection;
  /** Workspace frame. Null when not found, too unsure, or the lift missed every surface. */
  position: Vec3 | null;
  outline: ObjectOutline | null;
}

export type GroundingResult =
  | {
      ok: true;
      located: string[];
      missing: string[];
      sightings: Sighting[];
      /** The finder that answered (the server reports its model). */
      source: string;
      /** When the camera frame was captured, on the performance.now() timeline. */
      frameT: number;
      /** The finder's hint for when to look again (ms), when it gives one. */
      refreshMs?: number;
    }
  | {
      ok: false;
      reason: 'no-camera-frame' | 'no-camera-model' | 'no-head-pose' | 'locator-failed' | 'dropped';
      detail?: string;
    };

export interface GroundOptions {
  /**
   * Asked once the finder has answered: false drops the answer before anything is placed (it is
   * `dropped`), as when the lesson that asked has ended and the next may use its ids for others.
   */
  current?: () => boolean;
}

export interface GrounderDeps {
  camera: CameraFrameSource;
  locator: VisionLocator;
  registry: ObjectRegistry;
  /** Head poses in world space. */
  poses: PoseHistory;
  /** Read at use time, because the workspace can be recalibrated. */
  workspace: () => Workspace;
  /** Detected surfaces; detections fall back to the workspace plane when it misses. */
  surface?: SurfaceRaycaster;
  minConfidence?: number;
}

/** Port used by the lesson: anything that can find objects by id. */
export interface Grounder {
  ground(requests: readonly FindRequest[], opts?: GroundOptions): Promise<GroundingResult>;
}

const missed = (id: string): Detection => ({
  id,
  found: false,
  point: null,
  box: null,
  outline: null,
  confidence: 0,
});

export class ObjectGrounder implements Grounder {
  constructor(private readonly deps: GrounderDeps) {}

  async ground(
    requests: readonly FindRequest[],
    opts: GroundOptions = {},
  ): Promise<GroundingResult> {
    const { camera, locator, poses } = this.deps;
    const frame = await camera.capture();
    if (!frame) return { ok: false, reason: 'no-camera-frame' };
    if (!camera.model()) return { ok: false, reason: 'no-camera-model' };
    if (!poses.at(frame.t)) return { ok: false, reason: 'no-head-pose' };

    const objects = this.wording(requests);
    let answer: LocateAnswer;
    try {
      answer = await locator.locate(frame, objects);
    } catch (err) {
      return { ok: false, reason: 'locator-failed', detail: String(err) };
    }
    if (opts.current && !opts.current()) return { ok: false, reason: 'dropped' };
    return this.place(frame, objects, answer);
  }

  /**
   * Lift a finder's answer about `frame` into the scene, with the head pose at capture time: what
   * was found lands in the registry, with an outline for the AR layer. `ground` ends here, and so
   * does the smart model's closer look, which answers about a frame it was sent earlier.
   */
  place(
    frame: CameraFrame,
    objects: readonly LocateObject[],
    answer: { detections: readonly Detection[]; model: string; refreshMs?: number },
  ): GroundingResult {
    const { camera, registry, poses } = this.deps;
    const workspace = this.deps.workspace();
    const minConfidence = this.deps.minConfidence ?? 0.3;
    const model = camera.model();
    if (!model) return { ok: false, reason: 'no-camera-model' };
    const head = poses.at(frame.t);
    if (!head) return { ok: false, reason: 'no-head-pose' };

    const located: string[] = [];
    const missing: string[] = [];
    const sightings: Sighting[] = [];
    for (const { id, query, phrase } of objects) {
      const detection = answer.detections.find((d) => d.id === id) ?? missed(id);
      const world =
        detection.found && detection.confidence >= minConfidence
          ? liftDetection(detection, model, head, (ray) => this.cast(ray, workspace))
          : null;
      const polygon = detection.outline ?? (detection.box && boxPolygon(detection.box));
      const points = world && polygon ? liftOutline(polygon, model, head, world) : null;
      if (world) {
        registry.observe(id, {
          position: workspace.toWorkspacePoint(world),
          confidence: detection.confidence,
          source: 'detector',
          t: frame.t,
        });
        located.push(id);
      } else {
        missing.push(id);
      }
      sightings.push({
        id,
        description: query,
        phrase: phrase ?? query,
        detection,
        position: world && workspace.toWorkspacePoint(world),
        outline: points && { points, shape: detection.outline ? 'contour' : 'box' },
      });
    }
    return {
      ok: true,
      located,
      missing,
      sightings,
      source: answer.model,
      frameT: frame.t,
      ...(answer.refreshMs !== undefined && { refreshMs: answer.refreshMs }),
    };
  }

  /** One entry per declared object, in this moment's words or the object's own. */
  private wording(requests: readonly FindRequest[]): LocateObject[] {
    const seen = new Set<string>();
    return requests.flatMap((r) => {
      const spec = this.deps.registry.spec(r.id);
      if (!spec || seen.has(r.id)) return [];
      seen.add(r.id);
      return [
        {
          id: r.id,
          query: r.description ?? findWords(spec),
          phrase: r.phrase ?? spec.label,
        },
      ];
    });
  }

  private cast(ray: Ray, workspace: Workspace): Vec3 | null {
    return this.deps.surface?.cast(ray) ?? intersectPlaneY(ray, workspace.surfaceY);
  }
}

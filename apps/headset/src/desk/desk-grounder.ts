import type { Detection } from '@clio/protocol';
import type { ScenePlacer } from '../domain/session/closer-look';
import { findWords } from '../domain/world/find-words';
import type {
  CameraFrame,
  CameraFrameSource,
  FindRequest,
  Grounder,
  GroundingResult,
  GroundOptions,
  LocateObject,
  Sighting,
  VisionLocator,
} from '../domain/world/grounding';
import type { ObjectRegistry } from '../domain/world/object-registry';
import { anchorPoint, DESK_WORKSPACE, standInPosition } from './stand-in';

// The lesson's one-shot looks on the desk (a step's start, the coach's highlight, the closer
// look's answer): the headset's ObjectGrounder without the room. The webcam frame and the words go
// to the same object finder (POST /api/vision/locate), and what it finds lands in the registry at
// its stand-in position (stand-in.ts) instead of being lifted into 3D, so the lesson knows it has
// been found. No outline is lifted: the desk draws the tracker's outlines on the picture itself.

export interface DeskGrounderDeps {
  camera: Pick<CameraFrameSource, 'capture'>;
  locator: VisionLocator;
  registry: ObjectRegistry;
  /** The workspace the stand-in positions lie on (m). */
  size?: readonly [number, number];
  minConfidence?: number;
}

const missed = (id: string): Detection => ({
  id,
  found: false,
  point: null,
  box: null,
  outline: null,
  confidence: 0,
});

export class DeskGrounder implements Grounder, ScenePlacer {
  constructor(private readonly deps: DeskGrounderDeps) {}

  async ground(
    requests: readonly FindRequest[],
    opts: GroundOptions = {},
  ): Promise<GroundingResult> {
    const frame = await this.deps.camera.capture().catch(() => null);
    if (!frame) return { ok: false, reason: 'no-camera-frame' };
    const objects = this.wording(requests);
    let answer: Awaited<ReturnType<VisionLocator['locate']>>;
    try {
      answer = await this.deps.locator.locate(frame, objects);
    } catch (err) {
      return { ok: false, reason: 'locator-failed', detail: String(err) };
    }
    if (opts.current && !opts.current()) return { ok: false, reason: 'dropped' };
    return this.place(frame, objects, answer);
  }

  /** What the finder found lands in the registry at its stand-in position, unmeasured. */
  place(
    frame: CameraFrame,
    objects: readonly LocateObject[],
    answer: { detections: readonly Detection[]; model: string; refreshMs?: number },
  ): GroundingResult {
    const { registry } = this.deps;
    const minConfidence = this.deps.minConfidence ?? 0.3;
    const located: string[] = [];
    const missing: string[] = [];
    const sightings: Sighting[] = [];
    for (const { id, query, phrase } of objects) {
      const detection = answer.detections.find((d) => d.id === id) ?? missed(id);
      const point =
        detection.found && detection.confidence >= minConfidence ? anchorPoint(detection) : null;
      const position = point ? standInPosition(point, this.deps.size ?? DESK_WORKSPACE) : null;
      if (position) {
        registry.observe(id, {
          position,
          confidence: detection.confidence,
          source: 'detector',
          t: frame.t,
          measured: false,
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
        position,
        outline: null,
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
        { id: r.id, query: r.description ?? findWords(spec), phrase: r.phrase ?? spec.label },
      ];
    });
  }
}

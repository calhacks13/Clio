import type { DemoClip, PlanRequest, PlanResponse } from '@clio/protocol';
import type { ClipSource } from '../../domain/demo/demo-library';
import type { LessonPlanner } from '../../domain/session/lesson-controller';
import type {
  CameraFrame,
  LocateAnswer,
  LocateObject,
  VisionLocator,
} from '../../domain/world/grounding';
import type { ApiClient } from './api-client';

// Domain ports implemented by the laptop server.

export class RemotePlanner implements LessonPlanner {
  constructor(private readonly api: ApiClient) {}
  plan(request: PlanRequest): Promise<PlanResponse> {
    return this.api.plan(request);
  }
}

export class RemoteLocator implements VisionLocator {
  /**
   * `session` names this run of the app, so a tracking finder (tracker/) keeps one set of tracks
   * per headset instead of mixing frames from two.
   */
  constructor(
    private readonly api: ApiClient,
    private readonly session: string = newSessionId(),
  ) {}
  async locate(frame: CameraFrame, objects: LocateObject[]): Promise<LocateAnswer> {
    const { detections, model, refreshMs } = await this.api.locate({
      image: { mimeType: 'image/jpeg', data: frame.jpegBase64 },
      objects,
      session: this.session,
    });
    return { detections, model, ...(refreshMs !== undefined && { refreshMs }) };
  }
}

function newSessionId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ?? `s-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

export class RemoteClipSource implements ClipSource {
  constructor(private readonly api: ApiClient) {}
  fetch(clipId: string): Promise<DemoClip | null> {
    const slash = clipId.indexOf('/');
    if (slash < 0) return Promise.resolve(null);
    return this.api.clip(clipId.slice(0, slash), clipId.slice(slash + 1));
  }
}

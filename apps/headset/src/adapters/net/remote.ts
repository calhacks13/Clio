import type { DemoClip, Detection, PlanRequest, PlanResponse } from '@clio/protocol';
import type { ClipSource } from '../../domain/demo/demo-library';
import type { LessonPlanner } from '../../domain/session/lesson-controller';
import type { CameraFrame, VisionLocator } from '../../domain/world/grounding';
import type { ApiClient } from './api-client';

// Domain ports implemented by the laptop server.

export class RemotePlanner implements LessonPlanner {
  constructor(private readonly api: ApiClient) {}
  plan(request: PlanRequest): Promise<PlanResponse> {
    return this.api.plan(request);
  }
}

export class RemoteLocator implements VisionLocator {
  constructor(private readonly api: ApiClient) {}
  async locate(frame: CameraFrame, objects: { id: string; query: string }[]): Promise<Detection[]> {
    const res = await this.api.locate({
      image: { mimeType: 'image/jpeg', data: frame.jpegBase64 },
      objects,
    });
    return res.detections;
  }
}

export class RemoteClipSource implements ClipSource {
  constructor(private readonly api: ApiClient) {}
  fetch(clipId: string): Promise<DemoClip | null> {
    const slash = clipId.indexOf('/');
    if (slash < 0) return Promise.resolve(null);
    return this.api.clip(clipId.slice(0, slash), clipId.slice(slash + 1));
  }
}

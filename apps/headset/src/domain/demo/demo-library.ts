import {
  clipIdFor,
  type DemoClip,
  type ObjectSpec,
  type Procedure,
  type Step,
} from '@clio/protocol';
import type { Vec3 } from '../../core/math';
import { synthesizeDemo } from './synthesizer';
import type { Demonstration } from './types';

/** Port: recorded expert clips (the server's /api/clips). */
export interface ClipSource {
  fetch(clipId: string): Promise<DemoClip | null>;
}

export interface ObjectLookup {
  position(id: string): Vec3 | undefined;
  spec(id: string): ObjectSpec | undefined;
}

/**
 * Finds the best demonstration for a step: an expert recording when one exists (every good
 * record_demo episode grows this library), otherwise one synthesized from the step's action and
 * the objects' current positions. Synthesized demos aren't cached because objects move.
 */
export class DemoLibrary {
  private readonly recorded = new Map<string, Promise<DemoClip | null>>();

  constructor(private readonly clips: ClipSource | null) {}

  async forStep(
    procedure: Procedure,
    step: Step,
    objects: ObjectLookup,
  ): Promise<Demonstration | null> {
    const clipId = step.demo?.clipId ?? clipIdFor(procedure.id, step.id);
    const clip = await this.recording(clipId);
    if (clip) {
      return {
        stepId: step.id,
        verb: step.action?.verb ?? 'other',
        source: 'recorded',
        clip: { durationMs: clip.durationMs, frames: clip.frames },
        glyphs: [],
        marks: {},
        captions: [],
      };
    }
    if (!step.action) return null;
    return synthesizeDemo({
      stepId: step.id,
      action: step.action,
      position: (id) => objects.position(id),
      radius: (id) => objects.spec(id)?.radius,
    });
  }

  /** Forget cached recordings (e.g. after recording new demos). */
  clear(): void {
    this.recorded.clear();
  }

  private recording(clipId: string): Promise<DemoClip | null> {
    if (!this.clips) return Promise.resolve(null);
    let pending = this.recorded.get(clipId);
    if (!pending) {
      pending = this.clips.fetch(clipId).catch(() => null);
      this.recorded.set(clipId, pending);
    }
    return pending;
  }
}

import {
  CLIP_SCHEMA_ID,
  clipIdFor,
  type DemoClip,
  type EpisodeEvent,
  type EpisodeMeta,
  type FrameRecord,
} from '@clio/protocol';

// Turns a recorded episode into per-step ghost-hand clips. Pure: the route reads the files and
// writes the clips. Rules (docs/data-format.md, "Demo clips"):
// - one clip per step, from its last completion that was neither forced nor a skip;
// - the window runs from the latest step.entered of that step before the completion to the
//   completion itself, inclusive;
// - frames keep only { t, left, right }, with t rebased so the first kept frame is 0;
// - steps with fewer than 2 frames in their window produce no clip.

export class ClipSliceError extends Error {
  override name = 'ClipSliceError';
}

interface StepWindow {
  stepId: string;
  fromT: number;
  toT: number;
}

const roundMicros = (ms: number) => Math.round(ms * 1000) / 1000;

export function sliceClips(
  meta: EpisodeMeta,
  frames: readonly FrameRecord[],
  events: readonly EpisodeEvent[],
  stepIds?: readonly string[],
): DemoClip[] {
  const procedure = meta.procedure;
  if (!procedure) throw new ClipSliceError(`Episode ${meta.episodeId} has no procedure`);

  // Batches that are retried after a gap are appended late, so sort instead of trusting file order.
  const sorted = [...frames].sort((a, b) => a.t - b.t);
  const clips: DemoClip[] = [];
  for (const window of stepWindows(events, stepIds ? new Set(stepIds) : null)) {
    const kept = sorted.filter((f) => f.t >= window.fromT && f.t <= window.toT);
    const first = kept[0];
    const last = kept.at(-1);
    if (!first || !last || kept.length < 2) continue;
    clips.push({
      schema: CLIP_SCHEMA_ID,
      clipId: clipIdFor(procedure.id, window.stepId),
      procedureId: procedure.id,
      procedureVersion: procedure.version,
      stepId: window.stepId,
      source: { episodeId: meta.episodeId, startT: first.t, endT: last.t },
      durationMs: roundMicros(last.t - first.t),
      frames: kept.map((f) => ({ t: roundMicros(f.t - first.t), left: f.left, right: f.right })),
    });
  }
  return clips;
}

/** The last clean completion of each step, paired with the latest step.entered before it. */
function stepWindows(events: readonly EpisodeEvent[], wanted: Set<string> | null): StepWindow[] {
  const lastEntered = new Map<string, number>();
  const chosen = new Map<string, StepWindow>();
  // Array.prototype.sort is stable, so same-t events keep their recorded order.
  for (const e of [...events].sort((a, b) => a.t - b.t)) {
    if (e.type === 'step.entered') {
      lastEntered.set(e.stepId, e.t);
    } else if (e.type === 'step.completed' && !e.forced && e.by !== 'skip') {
      const fromT = lastEntered.get(e.stepId);
      if (fromT === undefined || (wanted && !wanted.has(e.stepId))) continue;
      chosen.set(e.stepId, { stepId: e.stepId, fromT, toT: e.t });
    }
  }
  return [...chosen.values()].sort((a, b) => a.fromT - b.fromT);
}

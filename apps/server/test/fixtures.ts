import type {
  EpisodeCreate,
  EpisodeEvent,
  EpisodeFinish,
  EpisodeMeta,
  FrameRecord,
  HandSample,
  ObjectTrackRecord,
  Pose7,
} from '@clio/protocol';
import { HAND_LAYOUT } from '@clio/protocol';

// Small, valid protocol values for tests. Hands are filled with one number so a test can tell
// frames apart (a frame recorded at t = 120 carries `hand(120)`).

export const HEAD: Pose7 = [0, 1.6, 0.3, 0, 0, 0, 1];

export function hand(value: number, pinch = 0.03): HandSample {
  return { joints: new Array(200).fill(value), pinch };
}

export function frame(t: number, right: HandSample | null = null): FrameRecord {
  return { t, head: HEAD, left: hand(t), right };
}

export function framesEvery(stepMs: number, fromT: number, toT: number): FrameRecord[] {
  const frames: FrameRecord[] = [];
  for (let t = fromT; t <= toT; t += stepMs) frames.push(frame(t));
  return frames;
}

export function entered(t: number, stepId: string, index = 0): EpisodeEvent {
  return { t, type: 'step.entered', stepId, index, instruction: `Do ${stepId}.`, targets: [] };
}

export function completed(
  t: number,
  stepId: string,
  opts: { index?: number; by?: 'check' | 'coach' | 'user' | 'skip'; forced?: boolean } = {},
): EpisodeEvent {
  return {
    t,
    type: 'step.completed',
    stepId,
    index: opts.index ?? 0,
    by: opts.by ?? 'check',
    forced: opts.forced ?? false,
    durationMs: 0,
  };
}

export function objectTrack(t: number): ObjectTrackRecord {
  return {
    t,
    objects: [
      {
        id: 'cup_a',
        position: [0.15, 0.07, -0.12],
        orientation: null,
        confidence: 0.9,
        source: 'detector',
      },
    ],
  };
}

export function episodeCreate(overrides: Partial<EpisodeCreate> = {}): EpisodeCreate {
  return {
    schema: 'clio.episode/1',
    mode: 'record_demo',
    procedure: { id: 'shirt-fold', version: 1, title: 'Fold a T-shirt in two seconds' },
    operator: { role: 'expert' },
    clock: { timeline: 'performance.now', startEpochMs: 1_792_811_702_000 },
    space: {
      frame: 'workspace',
      units: 'm',
      upAxis: '+y',
      worldFromWorkspace: [0.1, 0.75, -0.4, 0, 0, 0, 1],
      calibration: 'pinch_two_corners',
      anchored: false,
    },
    hands: { joints: [...HAND_LAYOUT.joints], jointFields: [...HAND_LAYOUT.jointFields] },
    objects: [
      {
        id: 'shoulder',
        label: 'shoulder dot',
        position: [0.14, 0, -0.18],
        radius: 0.025,
        method: 'layout',
      },
    ],
    coach: { kind: 'scripted' },
    device: { userAgent: 'vitest', emulated: true, xrFeatures: ['hand-tracking'] },
    app: { version: '0.1.0' },
    ...overrides,
  };
}

export function episodeMeta(overrides: Partial<EpisodeMeta> = {}): EpisodeMeta {
  return {
    ...episodeCreate(),
    episodeId: 'ep-20261024-031502-abcz',
    createdAt: '2026-10-24T03:15:02.123Z',
    ...overrides,
  };
}

export function finishBody(overrides: Partial<EpisodeFinish> = {}): EpisodeFinish {
  return {
    durationMs: 61_500,
    outcome: 'completed',
    stepsCompleted: 5,
    stepsTotal: 5,
    batches: 3,
    ...overrides,
  };
}

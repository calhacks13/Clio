import type {
  Detection,
  SceneAskRequest,
  SceneAskResponse,
  SceneObject,
  SceneRef,
} from '@clio/protocol';
import type { Clock } from '../../core/clock';
import type { LessonView } from '../coach/ports';
import type { CoachOwnToolHandlers, ToolOutcome } from '../coach/toolbox';
import type { AppBus } from '../events';
import { findWords } from '../world/find-words';
import type {
  CameraFrame,
  CameraFrameSource,
  GroundingResult,
  LocateObject,
} from '../world/grounding';

// The bridge from the voice to the smart model. The voice coach (Gemini Live, native audio) gets a
// blurry frame every few seconds. When it needs a sharp look it says so ("let me take a closer
// look") and calls look_closer, which doesn't hold it up: it keeps talking and listening. This
// takes a fresh frame and asks the smart model (Robotics-ER 2 behind POST /api/scene/ask) with the
// lesson's goal, step and materials. The answer, in words, is the call's result, and the voice says
// it in its own words once nobody is talking. What the answer points out among the lesson's
// objects is lifted into the scene and highlighted for the learner; the coach hears which things
// are highlighted, never where they are (docs/coach-plan.md, the perception boundary).

/** Port: the smart model, asked about camera views. */
export interface SceneAsker {
  ask(request: SceneAskRequest): Promise<SceneAskResponse>;
}

/** Port: lifts a finder's answer about a captured frame into the scene (ObjectGrounder.place). */
export interface ScenePlacer {
  place(
    frame: CameraFrame,
    objects: readonly LocateObject[],
    answer: { detections: readonly Detection[]; model: string },
  ): GroundingResult;
}

export interface CloserLookDeps {
  /** Null without a camera: every closer look says so. */
  camera: Pick<CameraFrameSource, 'capture'> | null;
  asker: SceneAsker;
  view: LessonView;
  bus: AppBus;
  clock: Clock;
  /** Null without one: the answer still goes back, but nothing is highlighted. */
  placer?: ScenePlacer | null;
}

/** As sharp as the planner's frames, so labels are readable. */
const FRAME_WIDTH = 1024;
/** The request's limits (SceneAskRequestSchema). */
const MAX_OBJECTS = 16;
const MAX_TEXT = 300;
/** The smart model doesn't rate its pointing; like a Gemini box without a confidence. */
const UNRATED = 0.5;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class CloserLook {
  constructor(private readonly deps: CloserLookDeps) {}

  handlers(): CoachOwnToolHandlers {
    return { look_closer: ({ question }, { callId }) => this.look(question, callId) };
  }

  async look(question: string, callId: string): Promise<ToolOutcome> {
    const { camera, asker } = this.deps;
    if (!camera) return { ok: false, error: 'The headset has no camera. Ask them to describe it.' };
    const frame = await camera.capture(FRAME_WIDTH).catch(() => null);
    if (!frame) {
      return { ok: false, error: 'The camera has no picture right now. Ask them to describe it.' };
    }
    let answer: SceneAskResponse;
    try {
      answer = await asker.ask({
        question,
        ...this.lesson(),
        images: [{ mimeType: 'image/jpeg', data: frame.jpegBase64 }],
      });
    } catch (err) {
      return { ok: false, error: `No closer look this time (${message(err)}).` };
    }
    const shown = this.show(answer, frame, question, callId);
    return {
      ok: true,
      result: {
        ...(answer.hazard ? { hazard: answer.hazard } : {}),
        answer: answer.answer,
        ...(shown.length > 0 ? { highlighted: shown } : {}),
      },
    };
  }

  /** The goal, the step in focus and the materials, so the answer can say which one it means. */
  private lesson(): Pick<SceneAskRequest, 'goal' | 'step' | 'objects'> {
    const { view } = this.deps;
    const plan = view.plan();
    if (!plan) return {};
    const step = plan.steps.find((s) => s.id === plan.focusId);
    const specs = view.procedure()?.objects ?? [];
    const objects = plan.materials.slice(0, MAX_OBJECTS).map(({ id, label }): SceneObject => {
      const spec = specs.find((o) => o.id === id);
      const look = spec && (spec.tracking?.query ?? spec.description) ? findWords(spec) : undefined;
      return { id, label, ...(look ? { look: look.slice(0, MAX_TEXT) } : {}) };
    });
    return {
      goal: plan.goal.slice(0, MAX_TEXT),
      ...(step
        ? {
            step: {
              instruction: step.instruction,
              ...(step.doneWhen ? { doneWhen: step.doneWhen } : {}),
            },
          }
        : {}),
      ...(objects.length > 0 ? { objects } : {}),
    };
  }

  /**
   * Records what the answer points out and highlights the lesson's objects among it, placed with
   * the head pose of the frame the smart model saw. Returns the labels now highlighted.
   */
  private show(answer: SceneAskResponse, frame: CameraFrame, question: string, callId: string) {
    const { bus, clock, view, placer } = this.deps;
    const t = clock.now();
    bus.emit('annotation', {
      t,
      label: 'coach.look_closer',
      data: { callId, model: answer.model, latencyMs: answer.latencyMs, refs: answer.refs },
    });
    const refs = new Map<string, SceneRef>();
    for (const ref of answer.refs) {
      if (ref.objectId && !refs.has(ref.objectId)) refs.set(ref.objectId, ref);
    }
    if (!placer || refs.size === 0) return [];
    const placed = placer.place(
      frame,
      [...refs].map(([id, ref]) => ({ id, query: question, phrase: ref.label })),
      {
        model: answer.model,
        detections: [...refs].map(([id, ref]) => ({
          id,
          found: true,
          point: ref.point,
          box: ref.box,
          outline: null,
          confidence: UNRATED,
        })),
      },
    );
    if (!placed.ok) return [];
    const stepId = view.plan()?.focusId ?? null;
    const shown: string[] = [];
    for (const s of placed.sightings) {
      const { found, point, box, outline, confidence } = s.detection;
      bus.emit('object.detected', {
        t,
        objectId: s.id,
        stepId,
        phrase: s.phrase,
        description: s.description,
        found,
        point,
        box,
        outline,
        confidence,
        position: s.position,
        source: placed.source,
        latencyMs: Math.max(0, t - placed.frameT),
      });
      if (!s.position) continue;
      bus.emit('overlay.highlight', { t, objectId: s.id, style: 'attention', source: 'coach' });
      shown.push(view.label(s.id));
    }
    return shown;
  }
}

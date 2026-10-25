import type { Vec3 } from '../../core/math';
import type { AgentState } from '../coach/agent';
import type { LessonView } from '../coach/ports';
import type { AppBus, CoachVoice, HighlightStyle, LessonPhase } from '../events';
import type { ObjectOutline } from '../world/outline';

export type { CoachVoice };

// The presentation model: what the AR layer should show, reduced from bus events. Presenters read
// a snapshot each frame and never reach into domain objects themselves.

export interface OverlayHighlight {
  objectId: string;
  style: HighlightStyle;
  source: 'auto' | 'coach';
  /** Expiry time, or null while the step lasts. */
  until: number | null;
}

/** Something the current step shows, outlined around the real object. */
export interface OverlayOutline {
  objectId: string;
  outline: ObjectOutline;
  /** Drawn at the object's estimate plus this (workspace frame). */
  offset: Vec3;
  /** 0 is what to act on, then where it goes. */
  rank: number;
  phrase: string;
}

export interface OverlaySnapshot {
  phase: LessonPhase;
  title: string | null;
  instruction: {
    text: string;
    detail?: string;
    index: number;
    total: number;
    progress: number;
  } | null;
  highlights: OverlayHighlight[];
  /** Most important first. */
  outlines: OverlayOutline[];
  toast: { kind: 'mistake' | 'success' | 'info'; text: string } | null;
  demoStepId: string | null;
  caption: { role: 'user' | 'coach'; text: string } | null;
  coach: AgentState | 'off';
  /** The conversation right now: the learner talking, Clio talking, or neither (see CoachVoice). */
  voice: CoachVoice;
  recording: { episodeId: string | null; queued: number } | null;
  missing: string[];
}

/** How long a coach highlight shows (ms). */
export const COACH_HIGHLIGHT_MS = 5000;
const MISTAKE_MS = 4000;
const SUCCESS_MS = 1200;
const CAPTION_MS = 4000;

export class OverlayModel {
  private phase: LessonPhase = 'idle';
  private title: string | null = null;
  private instruction: Omit<NonNullable<OverlaySnapshot['instruction']>, 'progress'> | null = null;
  private progress = 0;
  private highlights: OverlayHighlight[] = [];
  private readonly outlines = new Map<string, OverlayOutline>();
  private toast: (NonNullable<OverlaySnapshot['toast']> & { until: number }) | null = null;
  private demoStepId: string | null = null;
  private caption: (NonNullable<OverlaySnapshot['caption']> & { until: number }) | null = null;
  private coach: AgentState | 'off' = 'off';
  private voice: CoachVoice = 'off';
  private recording: OverlaySnapshot['recording'] = null;
  private missing: string[] = [];

  constructor(
    private readonly bus: AppBus,
    private readonly view: LessonView,
  ) {}

  attach(): () => void {
    const b = this.bus;
    const offs = [
      b.on('lesson.phase', ({ phase }) => {
        this.phase = phase;
      }),
      b.on('plan.requested', ({ revision }) => {
        if (!revision) this.forgetLesson();
      }),
      // Objects may be reported missing before the plan arrives, so plan.ready keeps the list.
      b.on('plan.ready', ({ procedure }) => {
        this.title = procedure.title;
      }),
      b.on('step.entered', ({ stepId, index, instruction, targets }) => {
        const detail = this.detailOf(stepId);
        this.instruction = {
          text: instruction,
          ...this.position(index),
          ...(detail ? { detail } : {}),
        };
        this.progress = 0;
        this.outlines.clear();
        this.highlights = targets.map((objectId) => ({
          objectId,
          style: 'target' as const,
          source: 'auto' as const,
          until: null,
        }));
      }),
      b.on('plan.changed', () => this.refreshInstruction()),
      b.on('step.completed', ({ t, by }) => {
        if (by === 'skip') return;
        this.toast = { kind: 'success', text: 'Nice!', until: t + SUCCESS_MS };
      }),
      b.on('procedure.completed', ({ t }) => {
        this.endLesson();
        this.toast = { kind: 'success', text: 'Lesson complete!', until: t + 3000 };
      }),
      b.on('procedure.aborted', () => this.endLesson()),
      b.on('mistake.detected', ({ t, message }) => {
        this.toast = { kind: 'mistake', text: message, until: t + MISTAKE_MS };
      }),
      b.on('overlay.highlight', ({ t, objectId, style, source }) => {
        this.highlights = this.highlights.filter(
          (h) => !(h.objectId === objectId && h.source === source),
        );
        this.highlights.push({
          objectId,
          style,
          source,
          until: source === 'coach' ? t + COACH_HIGHLIGHT_MS : null,
        });
      }),
      b.on('overlay.outline', ({ objectId, outline, offset, rank, phrase }) => {
        this.outlines.set(objectId, { objectId, outline, offset, rank, phrase });
      }),
      b.on('overlay.demo', ({ stepId, playing }) => {
        this.demoStepId = playing ? stepId : null;
      }),
      b.on('coach.caption', ({ t, role, text }) => {
        this.caption = { role, text, until: t + CAPTION_MS };
      }),
      b.on('coach.status', ({ state }) => {
        this.coach = state;
      }),
      b.on('coach.voice', ({ voice }) => {
        this.voice = voice;
      }),
      b.on('recorder.status', ({ recording, episodeId, queued }) => {
        this.recording = recording ? { episodeId, queued } : null;
      }),
      b.on('object.missing', ({ objectIds }) => {
        this.missing = [...new Set([...this.missing, ...objectIds])];
      }),
      b.on('object.registered', ({ objectId }) => {
        this.missing = this.missing.filter((id) => id !== objectId);
      }),
    ];
    return () => {
      for (const off of offs) off();
    };
  }

  setProgress(progress: number): void {
    this.progress = progress;
  }

  snapshot(t: number): OverlaySnapshot {
    this.highlights = this.highlights.filter((h) => h.until === null || h.until > t);
    if (this.toast && this.toast.until <= t) this.toast = null;
    if (this.caption && this.caption.until <= t) this.caption = null;
    return {
      phase: this.phase,
      // Saved and coach-written lessons send no plan.ready. The view keeps an ended lesson.
      title: this.title ?? (this.instruction && this.view.procedure()?.title) ?? null,
      instruction: this.instruction && { ...this.instruction, progress: this.progress },
      highlights: [...this.highlights],
      outlines: [...this.outlines.values()].sort((a, b) => a.rank - b.rank),
      toast: this.toast && { kind: this.toast.kind, text: this.toast.text },
      demoStepId: this.demoStepId,
      caption: this.caption && { role: this.caption.role, text: this.caption.text },
      coach: this.coach,
      voice: this.voice,
      recording: this.recording,
      missing: [...this.missing],
    };
  }

  /** Done steps out of those not skipped, from the plan; else the step's place in the list. */
  private position(stepIndex: number): { index: number; total: number } {
    const plan = this.view.plan();
    if (!plan) return { index: stepIndex, total: this.view.procedure()?.steps.length ?? 0 };
    const counted = plan.steps.filter((s) => s.status !== 'skipped');
    return { index: counted.filter((s) => s.status === 'done').length, total: counted.length };
  }

  private detailOf(stepId: string): string | undefined {
    return this.view.procedure()?.steps.find((s) => s.id === stepId)?.detail;
  }

  /** After a plan change: the focused step's current text, detail and count. The rest stays. */
  private refreshInstruction(): void {
    const plan = this.view.plan();
    if (!this.instruction || !plan) return;
    const focus = plan.steps.find((s) => s.id === plan.focusId);
    const detail = focus ? this.detailOf(focus.id) : this.instruction.detail;
    this.instruction = {
      text: focus?.instruction ?? this.instruction.text,
      ...this.position(this.instruction.index),
      ...(detail ? { detail } : {}),
    };
  }

  private endLesson(): void {
    this.instruction = null;
    this.highlights = [];
    this.outlines.clear();
    this.demoStepId = null;
    this.forgetLesson();
  }

  private forgetLesson(): void {
    this.title = null;
    this.missing = [];
  }
}

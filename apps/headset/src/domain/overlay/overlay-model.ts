import type { AgentState } from '../coach/agent';
import type { LessonView } from '../coach/ports';
import type { AppBus, HighlightStyle, LessonPhase } from '../events';

// The presentation model: what the AR layer should show, reduced from bus events. Presenters read
// a snapshot each frame and never reach into domain objects themselves.

export interface OverlayHighlight {
  objectId: string;
  style: HighlightStyle;
  source: 'auto' | 'coach';
  /** Expiry time, or null while the step lasts. */
  until: number | null;
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
  toast: { kind: 'mistake' | 'success' | 'info'; text: string } | null;
  demoStepId: string | null;
  caption: { role: 'user' | 'coach'; text: string } | null;
  coach: AgentState | 'off';
  recording: { episodeId: string | null; queued: number } | null;
  missing: string[];
}

const COACH_HIGHLIGHT_MS = 5000;
const MISTAKE_MS = 4000;
const SUCCESS_MS = 1200;
const CAPTION_MS = 4000;

export class OverlayModel {
  private phase: LessonPhase = 'idle';
  private title: string | null = null;
  private instruction: Omit<NonNullable<OverlaySnapshot['instruction']>, 'progress'> | null = null;
  private progress = 0;
  private highlights: OverlayHighlight[] = [];
  private toast: (NonNullable<OverlaySnapshot['toast']> & { until: number }) | null = null;
  private demoStepId: string | null = null;
  private caption: (NonNullable<OverlaySnapshot['caption']> & { until: number }) | null = null;
  private coach: AgentState | 'off' = 'off';
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
      b.on('plan.ready', ({ procedure }) => {
        this.title = procedure.title;
        this.missing = [];
      }),
      b.on('step.entered', ({ index, instruction, targets }) => {
        const steps = this.view.procedure()?.steps ?? [];
        const detail = steps[index]?.detail;
        this.instruction = {
          text: instruction,
          index,
          total: steps.length,
          ...(detail ? { detail } : {}),
        };
        this.progress = 0;
        this.highlights = targets.map((objectId) => ({
          objectId,
          style: 'target' as const,
          source: 'auto' as const,
          until: null,
        }));
      }),
      b.on('step.completed', ({ t }) => {
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
      b.on('overlay.demo', ({ stepId, playing }) => {
        this.demoStepId = playing ? stepId : null;
      }),
      b.on('coach.caption', ({ t, role, text }) => {
        this.caption = { role, text, until: t + CAPTION_MS };
      }),
      b.on('coach.status', ({ state }) => {
        this.coach = state;
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
      title: this.title,
      instruction: this.instruction && { ...this.instruction, progress: this.progress },
      highlights: [...this.highlights],
      toast: this.toast && { kind: this.toast.kind, text: this.toast.text },
      demoStepId: this.demoStepId,
      caption: this.caption && { role: this.caption.role, text: this.caption.text },
      coach: this.coach,
      recording: this.recording,
      missing: [...this.missing],
    };
  }

  private endLesson(): void {
    this.instruction = null;
    this.highlights = [];
    this.demoStepId = null;
  }
}

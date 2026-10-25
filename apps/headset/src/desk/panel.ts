import type { LessonPhase } from '../domain/events';
import type { PlanView } from '../domain/plan/recital';
import { hex } from './colors';
import type { DeskObject, DeskTrackerStats } from './desk-tracker';
import { brief, type ToolCallEntry, type TranscriptLine } from './logs';

// The side panel's sections as HTML, from plain data, so what each shows can be tested without a
// page: the lesson (goal, phase, steps with their status and focus, what the focused step lights,
// the step watcher's last answer), the conversation, every coach tool call, Robotics-ER's looks and
// the tracker's numbers. main.ts puts them in the page.

export const esc = (value: unknown): string =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );

/** A page time (performance.now ms) as minutes and seconds since the page opened, e.g. 2:07.4. */
export function clockText(t: number): string {
  const s = Math.max(0, t) / 1000;
  const minutes = Math.floor(s / 60);
  return `${minutes}:${(s - minutes * 60).toFixed(1).padStart(4, '0')}`;
}

const ms = (value: number | null | undefined) =>
  value === null || value === undefined ? '–' : `${Math.round(value)} ms`;

/** The step watcher's last answer, as the panel shows it. */
export interface WatchLine {
  t: number;
  stepId: string;
  verdict?: string;
  progress?: number;
  observation?: string;
  wrong?: string;
  error?: string;
  latencyMs?: number;
  quick?: boolean;
}

export interface LessonPanel {
  plan: PlanView | null;
  phase: LessonPhase;
  /** The goal being planned, or why planning failed. */
  detail: string | null;
  objects: readonly DeskObject[];
  watch: WatchLine | null;
  /** The action focus's item for the step (Robotics-ER's next thing to touch), if any. */
  next?: string | null;
}

const STATUS_MARK = { done: '✓', skipped: '–', todo: '○' } as const;

export function lessonHtml({ plan, phase, detail, objects, watch, next }: LessonPanel): string {
  const head = `<p class="phase phase-${esc(phase)}">${esc(phase)}${detail ? ` · ${esc(detail)}` : ''}</p>`;
  if (!plan) {
    return `${head}<p class="muted">No lesson. Say what you want to learn, type it below, or start one from a goal.</p>`;
  }
  const steps = plan.steps
    .map((s) => {
      const focus = s.id === plan.focusId;
      const mark = focus ? '●' : STATUS_MARK[s.status];
      return `<li class="step ${s.status}${focus ? ' focus' : ''}">
        <span class="mark">${mark}</span>
        <div><span class="step-id">${esc(s.id)}</span> ${esc(s.instruction)}
        ${s.doneWhen ? `<div class="muted small">Done when: ${esc(s.doneWhen)}</div>` : ''}
        ${s.note ? `<div class="muted small">Note: ${esc(s.note)}</div>` : ''}</div>
      </li>`;
    })
    .join('');
  const lit = objects.filter((o) => o.lit);
  const lights = lit.length
    ? lit
        .map(
          (o) =>
            `<span class="chip"><i style="background:${hex(o.accent.color)}"></i>${esc(o.label)}${o.style ? ` <span class="muted">(${esc(o.style)})</span>` : ''}${o.id === next ? ' <span class="muted">(ER: next)</span>' : ''}</span>`,
        )
        .join('')
    : '<span class="muted">nothing lit</span>';
  return `${head}
    <h3>${esc(plan.goal || plan.title)} <span class="muted small">rev ${plan.rev}</span></h3>
    <ol class="steps">${steps}</ol>
    <p class="lit">Lit: ${lights}</p>
    ${watch ? watchHtml(watch) : ''}`;
}

function watchHtml(w: WatchLine): string {
  if (w.error)
    return `<p class="watch muted small">Watcher (${esc(w.stepId)}): ${esc(w.error)}</p>`;
  const progress = w.progress === undefined ? '' : ` ${Math.round(w.progress * 100)}%`;
  const wrong = w.wrong ? ` <span class="bad">wrong: ${esc(w.wrong)}</span>` : '';
  return `<p class="watch small">Watcher${w.quick ? ' (quick)' : ''}: <b>${esc(w.verdict ?? '?')}</b>${progress}${wrong} · ${esc(w.observation ?? '')} <span class="muted">${ms(w.latencyMs)}</span></p>`;
}

export function transcriptHtml(lines: readonly TranscriptLine[]): string {
  if (lines.length === 0) return '<p class="muted">Nothing said yet.</p>';
  return lines
    .map(
      (l) =>
        `<p class="line ${l.role}${l.final ? '' : ' partial'}"><span class="who">${l.role === 'user' ? (l.typed ? 'you (typed)' : 'you') : l.role === 'coach' ? 'coach' : 'app'}</span> <span class="when">${clockText(l.t)}</span> ${esc(l.text)}</p>`,
    )
    .join('');
}

export function toolsHtml(
  entries: readonly ToolCallEntry[],
  counts: Record<string, number>,
): string {
  const summary = Object.entries(counts)
    .map(
      ([name, n]) =>
        `<span class="chip${name === 'highlight' ? ' hot' : ''}">${esc(name)} ${n}</span>`,
    )
    .join('');
  const highlight = counts.highlight ? '' : '<span class="chip warn">highlight 0</span>';
  if (entries.length === 0) {
    return `<p class="counts">${highlight}</p><p class="muted">No tool calls yet.</p>`;
  }
  const rows = entries
    .map((e) => {
      const state = e.ok === undefined ? 'pending' : e.ok ? 'ok' : 'failed';
      return `<li class="call ${state}${e.name === 'highlight' ? ' hot' : ''}">
        <div><b>${esc(e.name)}</b> <span class="when">${clockText(e.t)}</span> <span class="muted">${e.ms === undefined ? 'running' : ms(e.ms)}</span></div>
        <code>${esc(brief(e.args))}</code>
        ${e.ok === undefined ? '' : `<code class="result">${esc(brief(e.result))}</code>`}
      </li>`;
    })
    .join('');
  return `<p class="counts">${summary}${highlight}</p><ol class="calls">${rows}</ol>`;
}

/** One Robotics-ER action-focus answer, as the panel lists it. */
export interface ErLogEntry {
  t: number;
  stepId: string | null;
  model: string;
  latencyMs: number;
  /**
   * The action item: its label, the lesson object lit for it (null when none), whether the lesson
   * declared it just now from ER's words, and whether ER saw it.
   */
  action: { label: string; id: string | null; declared: boolean; found: boolean } | null;
  /** How old the frame ER judged was when its answer arrived (ms). */
  frameAgeMs: number;
  /** Each requested object: found, and ER's words for it. */
  objects: {
    id: string;
    label: string;
    found: boolean;
    confidence: number;
    description: string | null;
  }[];
}

export function erHtml(entries: readonly ErLogEntry[], on: boolean): string {
  if (!on) return '<p class="muted">The action focus is off (?focus=0).</p>';
  if (entries.length === 0)
    return '<p class="muted">No looks yet: they start when a step is focused.</p>';
  return entries
    .map((e) => {
      const action = e.action
        ? `next: <b>${esc(e.action.label)}</b>${e.action.declared ? ' <span class="warn">(declared now)</span>' : e.action.id ? '' : ' <span class="warn">(not in the plan)</span>'}${e.action.found ? '' : ' <span class="muted">(not seen)</span>'}`
        : '<span class="muted">nothing to touch</span>';
      const objects = e.objects
        .map(
          (o) =>
            `<li class="${o.found ? '' : 'muted'}"><b>${esc(o.label)}</b> ${o.found ? o.confidence.toFixed(2) : 'not found'}${o.description ? ` · ${esc(o.description)}` : ''}</li>`,
        )
        .join('');
      return `<div class="er"><div><span class="when">${clockText(e.t)}</span> ER ${ms(e.latencyMs)} · frame ${ms(e.frameAgeMs)} old · ${esc(e.model)}${e.stepId ? ` · ${esc(e.stepId)}` : ''}</div><div>${action}</div><ul>${objects}</ul></div>`;
    })
    .join('');
}

/** The finder's last one-shot look (a step's start, a highlight): what it found. */
export interface LocateLine {
  t: number;
  source: string;
  found: string[];
  missing: string[];
  latencyMs: number;
}

export function statsHtml(s: DeskTrackerStats, locate: LocateLine | null): string {
  const connection = s.connected
    ? `<span class="ok">connected</span> · ${esc(s.model ?? '')}`
    : '<span class="bad">not connected</span> <span class="muted">(run pnpm tracker; retrying)</span>';
  const frame = s.frame ? `${s.frame.width}×${s.frame.height}` : '–';
  return `<dl class="stats">
    <dt>Tracker</dt><dd>${connection}</dd>
    <dt>Stream</dt><dd>${s.streaming ? `${s.fps.toFixed(1)} fps` : '<span class="muted">idle</span>'} · ${frame} · answer ${ms(s.sendToAnswerMs)} · track ${ms(s.trackMs)} · encode ${ms(s.encodeMs)}</dd>
    <dt>Objects</dt><dd>${s.followed} followed · ${s.lit} lit · ${s.found} found</dd>
    <dt>Placed by</dt><dd>jev ${s.sources.jev} · er ${s.sources.er} · unsaid ${s.sources.none}</dd>
    <dt>Finder</dt><dd>${
      locate
        ? `${esc(locate.source)} · found ${esc(locate.found.join(', ') || 'nothing')}${locate.missing.length ? ` · missing ${esc(locate.missing.join(', '))}` : ''} · ${ms(locate.latencyMs)} <span class="when">${clockText(locate.t)}</span>`
        : '<span class="muted">no look yet</span>'
    }</dd>
  </dl>`;
}

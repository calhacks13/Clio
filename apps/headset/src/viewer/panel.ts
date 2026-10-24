import type { StepEntered } from './episode-data';
import { formatClock } from './episode-data';
import type { LogEntry } from './event-log';

// The viewer's DOM outside the 3D view: the episode list, the lesson panel (title, current step,
// event log) and the timeline. Each one touches the DOM only when what it shows changes, because
// the page updates them every animation frame.

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`viewer.html has no #${id}`);
  return node as T;
}

export interface EpisodeRow {
  id: string;
  name: string;
  when: string;
  status: string;
  live: boolean;
}

export class EpisodeList {
  private readonly buttons = new Map<string, HTMLButtonElement>();

  constructor(
    private readonly root: HTMLElement,
    private readonly note: HTMLElement,
    private readonly onSelect: (id: string) => void,
  ) {}

  /** Rows newest first; existing buttons are reused, so focus survives a refresh. */
  render(rows: readonly EpisodeRow[], selectedId: string | null): void {
    const keep = new Set(rows.map((r) => r.id));
    for (const [id, button] of this.buttons) {
      if (keep.has(id)) continue;
      button.parentElement?.remove();
      this.buttons.delete(id);
    }
    rows.forEach((row, i) => {
      const button = this.buttons.get(row.id) ?? this.create(row.id);
      const [name, when, status] = button.querySelectorAll('span');
      if (name) name.textContent = row.name;
      if (when) when.textContent = row.when;
      if (status) {
        status.textContent = row.status;
        status.classList.toggle('live', row.live);
      }
      button.setAttribute('aria-current', String(row.id === selectedId));
      const item = button.parentElement as HTMLElement;
      if (this.root.children[i] !== item)
        this.root.insertBefore(item, this.root.children[i] ?? null);
    });
    this.setNote(rows.length === 0 ? 'No recordings yet' : null);
  }

  /** A short line above the list (empty or unreachable), or null to hide it. */
  setNote(text: string | null, error = false): void {
    this.note.hidden = text === null;
    this.note.textContent = text ?? '';
    this.note.classList.toggle('error', error);
  }

  private create(id: string): HTMLButtonElement {
    const button = el('button', 'episode');
    button.type = 'button';
    const meta = el('span', 'episode-meta');
    button.append(el('span', 'episode-name'), meta);
    meta.append(el('span', 'episode-when'), el('span', 'episode-status'));
    button.addEventListener('click', () => this.onSelect(id));
    const item = el('li');
    item.append(button);
    this.buttons.set(id, button);
    return button;
  }
}

export class LessonPanel {
  private shownStep: StepEntered | null | undefined;
  private shownLog: readonly LogEntry[] = [];

  constructor(
    private readonly title: HTMLElement,
    private readonly stepIndex: HTMLElement,
    private readonly instruction: HTMLElement,
    private readonly log: HTMLElement,
  ) {}

  setTitle(text: string): void {
    this.title.textContent = text;
  }

  setStep(step: StepEntered | null, stepCount: number | null): void {
    if (step === this.shownStep) return;
    this.shownStep = step;
    const of = stepCount ? ` of ${stepCount}` : '';
    this.stepIndex.textContent = step ? `Step ${step.index + 1}${of}` : '';
    this.instruction.textContent = step?.instruction ?? '';
  }

  /** Entries up to the current time. Moving forward appends; scrubbing back rebuilds. */
  setLog(entries: readonly LogEntry[]): void {
    const shown = this.shownLog;
    if (entries.length === shown.length && entries.every((e, i) => e === shown[i])) return;
    const atBottom = this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 40;
    const appending = shown.length <= entries.length && shown.every((e, i) => e === entries[i]);
    if (!appending) this.log.replaceChildren();
    for (const entry of entries.slice(appending ? shown.length : 0))
      this.log.append(this.row(entry));
    this.shownLog = entries;
    if (atBottom || !appending) this.log.scrollTop = this.log.scrollHeight;
  }

  private row(entry: LogEntry): HTMLLIElement {
    const item = el('li', `entry ${entry.kind}`);
    item.append(
      el('span', 'entry-time', formatClock(entry.t)),
      el('span', 'entry-label', entry.label),
      el('span', 'entry-text', entry.text),
    );
    return item;
  }
}

export interface TimelineState {
  t: number;
  duration: number;
  playing: boolean;
  /** The episode has no finish, so there is a live edge to follow. */
  live: boolean;
  /** The view follows the newest frame. */
  following: boolean;
}

export interface TimelineMark {
  t: number;
  kind: 'step' | 'mistake';
}

export class Timeline {
  private shown: Partial<TimelineState> = {};
  private marksKey = '';

  constructor(
    private readonly els: {
      play: HTMLButtonElement;
      live: HTMLButtonElement;
      scrub: HTMLInputElement;
      fill: HTMLElement;
      marks: HTMLElement;
      clock: HTMLElement;
      duration: HTMLElement;
    },
    handlers: { scrub(t: number): void; togglePlay(): void; goLive(): void },
  ) {
    els.scrub.addEventListener('input', () => handlers.scrub(Number(els.scrub.value)));
    els.play.addEventListener('click', () => handlers.togglePlay());
    els.live.addEventListener('click', () => handlers.goLive());
  }

  update(state: TimelineState): void {
    const { els, shown } = this;
    if (state.duration !== shown.duration) {
      els.scrub.max = String(state.duration);
      els.duration.textContent = formatClock(state.duration);
    }
    if (state.t !== shown.t || state.duration !== shown.duration) {
      els.scrub.value = String(state.t);
      els.clock.textContent = formatClock(state.t);
      const progress = state.duration > 0 ? Math.min(1, state.t / state.duration) : 0;
      els.fill.style.setProperty('--progress', String(progress));
    }
    if (state.playing !== shown.playing) {
      els.play.classList.toggle('playing', state.playing);
      els.play.setAttribute('aria-label', state.playing ? 'Pause' : 'Play');
    }
    if (state.live !== shown.live) els.live.hidden = !state.live;
    if (state.following !== shown.following) {
      els.live.setAttribute('aria-pressed', String(state.following));
    }
    this.shown = { ...state };
  }

  /** Step starts and mistakes as ticks along the track. */
  setMarks(marks: readonly TimelineMark[], duration: number): void {
    const key = `${duration}:${marks.length}`;
    if (key === this.marksKey) return;
    this.marksKey = key;
    this.els.marks.replaceChildren(
      ...marks.map((m) => {
        const tick = el('span', `mark ${m.kind}`);
        tick.style.left = `${duration > 0 ? (m.t / duration) * 100 : 0}%`;
        return tick;
      }),
    );
  }
}

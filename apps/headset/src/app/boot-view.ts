import type { HealthResponse, ProcedureSummary } from '@clio/protocol';

// The launch page: one question, one button, and silence when everything works. The markup is a
// pure function of what boot() learned, so the UI gallery (gallery.html) can show every state
// without a server or a headset; boot.ts and the gallery drive it with the same small functions:
//
//   renderBoot(model)                the page; a problem shows only when something is wrong
//   bindBootView(root, onStart?)     keeps the button's label and the goal box in step with the
//                                    options; onStart gets the choice when the button is pressed
//   setBootProgress(root, progress)  the button narrates starting in place (permissions, entering
//                                    AR, an error to retry); a hidden live region reads it out
//   readBootChoice(root)             the goal, saved lesson and options as they stand

export interface BootModel {
  /** Null when the server is unreachable. */
  health: HealthResponse | null;
  procedures: ProcedureSummary[];
  /** Whether immersive-ar is available. Without it the button is disabled. */
  ar: boolean;
  /** Prefilled from ?goal=. */
  goal: string;
  /** Prefilled from ?procedure=; ignored unless it is one of `procedures`. */
  procedureId?: string | null;
  /** Prefilled from ?calibrate=1. */
  calibrate?: boolean;
  /** Prefilled from ?mode=record_demo. */
  record?: boolean;
}

/** What the button starts. A saved lesson overrides the goal; recording overrides the label. */
export type BootStart = 'lesson' | 'saved' | 'record';

export type BootProgressKind = 'idle' | 'permissions' | 'entering' | 'inside' | 'error';

export interface BootProgress {
  kind: BootProgressKind;
  /** For 'error', what went wrong. For 'permissions' and 'entering', a label for the button. */
  message?: string;
}

export interface BootChoice {
  /** Null when empty: the learner tells Clio once inside. */
  goal: string | null;
  procedureId: string | null;
  calibrate: boolean;
  record: boolean;
}

const START_LABELS: Record<BootStart, string> = {
  lesson: 'Start lesson',
  saved: 'Start saved lesson',
  record: 'Start recording',
};

/** The button's label: what it starts, or how far starting has got. */
export function bootButtonLabel(start: BootStart, progress: BootProgress): string {
  switch (progress.kind) {
    case 'permissions':
      return progress.message ?? 'Allow microphone and camera';
    case 'entering':
      return progress.message ?? 'Entering AR';
    case 'inside':
      return 'In AR';
    case 'error':
      return 'Try again';
    default:
      return START_LABELS[start];
  }
}

export function bootStart(choice: Pick<BootChoice, 'procedureId' | 'record'>): BootStart {
  if (choice.record) return 'record';
  return choice.procedureId ? 'saved' : 'lesson';
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Ends with a full stop unless it already ends a sentence. */
const sentence = (s: string) => (s && !/[.!?]$/.test(s) ? `${s}.` : s);

interface Problem {
  /** bad: lessons cannot work as they are. warn: they work, with less. */
  tone: 'bad' | 'warn';
  title: string;
  /** HTML: the fix. */
  fix: string;
}

function problems({ health, ar }: BootModel): Problem[] {
  const found: Problem[] = [];
  if (!ar) {
    found.push({
      tone: 'bad',
      title: 'This browser can’t enter AR.',
      fix: 'Open Clio on a Quest, or add <code>?emulate=1</code> on a laptop.',
    });
  }
  if (!health) {
    found.push({
      tone: 'bad',
      title: 'Can’t reach the Clio server.',
      fix: 'Run <code>pnpm dev</code> on the laptop, then reload this page.',
    });
  } else if (!health.coach.configured) {
    found.push({
      tone: 'warn',
      title: 'No Gemini key: Clio uses the offline coach.',
      fix: 'It can’t see or listen. Set <code>GEMINI_API_KEY</code> in <code>.env</code> and restart <code>pnpm dev</code>.',
    });
  }
  return found;
}

function renderProblems(list: Problem[]): string {
  if (list.length === 0) return '';
  const items = list
    .map(
      (p) =>
        `<li class="problem ${p.tone}"><p class="problem-title">${p.title}</p><p>${p.fix}</p></li>`,
    )
    .join('');
  return `<ul class="problems" aria-label="Setup problems">${items}</ul>`;
}

function renderSavedLessons(procedures: ProcedureSummary[], selected: string | null): string {
  if (procedures.length === 0) return '';
  const option = (p: ProcedureSummary) =>
    `<option value="${esc(p.id)}"${p.id === selected ? ' selected' : ''}>${esc(p.title)}</option>`;
  const group = (label: string, source: ProcedureSummary['source']) => {
    const list = procedures.filter((p) => p.source === source);
    return list.length ? `<optgroup label="${label}">${list.map(option).join('')}</optgroup>` : '';
  };
  return `
            <label class="field">
              <span>Saved lesson</span>
              <select id="procedure">
                <option value="">None</option>${group('Curated', 'curated')}${group('Planned by Clio', 'generated')}
              </select>
            </label>`;
}

export function renderBoot(model: BootModel): string {
  const { procedures, ar, goal } = model;
  const procedureId =
    model.procedureId && procedures.some((p) => p.id === model.procedureId)
      ? model.procedureId
      : null;
  const calibrate = model.calibrate ?? false;
  const record = model.record ?? false;
  const start = bootStart({ procedureId, record });
  const on = (checked: boolean) => (checked ? ' checked' : '');
  return `
    <main class="boot" data-start="${start}" data-progress="idle">
      ${renderProblems(problems(model))}
      <form class="start" id="boot-form" autocomplete="off" novalidate>
        <h1><label for="goal">What do you want to do?</label></h1>
        <input id="goal" type="text" enterkeyhint="go" placeholder="Refill the windshield washer fluid"
          value="${esc(goal)}"${procedureId ? ' disabled' : ''}>
        <button id="enter" class="go" type="submit" aria-describedby="boot-error"${ar ? '' : ' disabled'}>
          <span class="label">${bootButtonLabel(start, { kind: 'idle' })}</span>
        </button>
        <div class="note">
          <p class="error" id="boot-error"></p>
        </div>
        <details class="more"${procedureId || calibrate || record ? ' open' : ''}>
          <summary><span class="closed">More options</span><span class="opened">Hide options</span></summary>
          <div class="options">${renderSavedLessons(procedures, procedureId)}
            <label class="switch">
              <span>Calibrate the table first</span>
              <input id="calibrate" type="checkbox" role="switch"${on(calibrate)}>
            </label>
            <label class="switch">
              <span>Record expert demonstrations</span>
              <input id="record" type="checkbox" role="switch"${on(record)}>
            </label>
          </div>
        </details>
      </form>
      <p id="status" class="visually-hidden" role="status" aria-live="polite"></p>
    </main>
    <div id="xr"></div>`;
}

const BUSY: ReadonlySet<BootProgressKind> = new Set(['permissions', 'entering', 'inside']);

const find = <T extends Element>(root: ParentNode, selector: string) =>
  root.querySelector<T>(selector);

export function readBootChoice(root: ParentNode): BootChoice {
  const goal = find<HTMLInputElement>(root, '#goal')?.value.trim() ?? '';
  return {
    goal: goal || null,
    procedureId: find<HTMLSelectElement>(root, '#procedure')?.value || null,
    calibrate: find<HTMLInputElement>(root, '#calibrate')?.checked ?? false,
    record: find<HTMLInputElement>(root, '#record')?.checked ?? false,
  };
}

export function setBootProgress(root: ParentNode, progress: BootProgress): void {
  const main = find<HTMLElement>(root, '.boot');
  const button = find<HTMLButtonElement>(root, '#enter');
  if (!main || !button) return;
  const label = bootButtonLabel((main.dataset.start ?? 'lesson') as BootStart, progress);
  main.dataset.progress = progress.kind;
  // aria-disabled rather than disabled: the button keeps focus while it narrates.
  if (BUSY.has(progress.kind)) button.setAttribute('aria-disabled', 'true');
  else button.removeAttribute('aria-disabled');
  const text = find<HTMLElement>(button, '.label');
  if (text) text.textContent = label;
  const reason = progress.kind === 'error' ? sentence(progress.message?.trim() ?? '') : '';
  const error = progress.kind === 'error' ? `Could not start. ${reason}`.trim() : '';
  const note = find<HTMLElement>(root, '#boot-error');
  if (note) {
    note.textContent = error;
    // The note shows two lines at most; the whole error is a hover away.
    note.title = error;
  }
  const status = find<HTMLElement>(root, '#status');
  if (status) {
    status.textContent =
      progress.kind === 'idle' ? '' : progress.kind === 'error' ? `${error} ${label}.` : label;
  }
}

export function bindBootView(root: ParentNode, onStart?: (choice: BootChoice) => void): void {
  const main = find<HTMLElement>(root, '.boot');
  const form = find<HTMLFormElement>(root, '#boot-form');
  const button = find<HTMLButtonElement>(root, '#enter');
  if (!main || !form || !button) return;
  const sync = () => {
    const choice = readBootChoice(root);
    const start = bootStart(choice);
    main.dataset.start = start;
    // A saved lesson overrides the goal, so the goal box steps aside while one is chosen.
    const goal = find<HTMLInputElement>(root, '#goal');
    if (goal) goal.disabled = choice.procedureId !== null;
    if (main.dataset.progress === 'idle') {
      const text = find<HTMLElement>(button, '.label');
      if (text) text.textContent = bootButtonLabel(start, { kind: 'idle' });
    }
  };
  form.addEventListener('change', sync);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (button.disabled || button.getAttribute('aria-disabled') === 'true') return;
    onStart?.(readBootChoice(root));
  });
  sync();
}

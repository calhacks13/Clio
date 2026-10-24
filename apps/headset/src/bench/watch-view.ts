import type { StepCheckVerdict } from '@clio/protocol';
import type { StepProgress, WatchLook, WatchSession } from './live-watch';
import { esc, shortModel } from './plan-view';

// Pure HTML for the live watch panel. It comes in three parts so the page can redraw the status
// on every answer without closing a dropdown the tester has open in the controls, or the log.

export interface WatchStatusOptions {
  now: number;
  paused: boolean;
  looking: boolean;
  needed: number;
  /** It looked done enough, but moving on is up to you. */
  suggest: boolean;
}

export interface WatchControlsOptions {
  paused: boolean;
  complete: boolean;
  intervalMs: number;
  autoAdvance: boolean;
  needed: number;
  model: string;
  models: readonly string[];
}

export const INTERVALS_MS = [2000, 3000, 6000, 10_000] as const;
/** The headset's step watcher looks every 6 s. */
export const HEADSET_INTERVAL_MS = 6000;

export const clockText = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

export function verdictLabel(verdict: StepCheckVerdict): string {
  return verdict === 'done' ? 'done' : verdict === 'not_done' ? 'not done' : 'unsure';
}

/** One-line state for the panel and the camera badge. */
export function watchState(session: WatchSession, paused: boolean, looking: boolean): string {
  if (session.complete) return 'Lesson complete';
  if (paused) return 'Paused';
  return looking ? 'Looking…' : 'Watching live';
}

export function renderWatchStatus(
  session: WatchSession,
  title: string,
  o: WatchStatusOptions,
): string {
  const { steps } = session;
  const focus = session.focus;
  const step = focus === null ? undefined : steps[focus];
  const time = session.elapsed(o.now);
  const last = session.looks[0];
  const tone = session.complete ? 'complete' : o.paused ? 'paused' : 'live';
  const now = step
    ? `
      <div class="watch-now">
        <p class="muted small">Step ${(focus ?? 0) + 1} of ${steps.length}: <code>${esc(step.id)}</code></p>
        <p class="instruction">${esc(step.instruction)}</p>
        <p class="done-when"><span>Done when</span>${step.doneWhen ? esc(step.doneWhen) : '<em>not given: judged by the instruction</em>'}</p>
        ${o.suggest ? '<p class="watch-suggest">It looks done. Press <strong>Mark done</strong> to move on.</p>' : ''}
        ${session.streak > 0 && !o.suggest && o.needed > 1 ? `<p class="muted small">Looked done ${session.streak} of ${o.needed} times in a row.</p>` : ''}
      </div>`
    : `
      <div class="watch-now">
        <p class="instruction">Every step is done, in ${clockText(time.total)}.</p>
        ${renderDurations(session)}
      </div>`;
  return `
    <div class="watch-head">
      <span class="watch-state ${tone}">${watchState(session, o.paused, o.looking)}</span>
      <strong class="watch-title">${esc(title)}</strong>
      <span>${session.doneCount} of ${steps.length} done</span>
      <span class="muted watch-clock">${step ? `${clockText(time.step)} on this step · ` : ''}${clockText(time.total)} in all</span>
    </div>
    ${renderProgress(session.progress, focus)}
    <div class="watch-body">
      ${now}
      ${last ? renderLastLook(last, o.now) : '<div class="watch-last muted">The first look comes in a moment. Start doing the step.</div>'}
    </div>`;
}

export function renderWatchControls(o: WatchControlsOptions): string {
  const off = o.complete ? 'disabled' : '';
  return `
    <button type="button" data-watch="pause" ${off}>${o.paused ? 'Resume' : 'Pause'}</button>
    <button type="button" data-watch="done" class="ok" ${off}>Mark done</button>
    <button type="button" data-watch="skip" ${off}>Skip</button>
    <button type="button" data-watch="back">Back a step</button>
    <button type="button" data-watch="look" ${off}>Look now</button>
    <label>Every
      <select data-watch="interval">
        ${INTERVALS_MS.map((ms) => `<option value="${ms}" ${ms === o.intervalMs ? 'selected' : ''}>${ms / 1000} s${ms === HEADSET_INTERVAL_MS ? ' (headset)' : ''}</option>`).join('')}
      </select>
    </label>
    <label>Judge
      <select data-watch="model">
        ${o.models.map((m) => `<option value="${esc(m)}" ${m === o.model ? 'selected' : ''}>${esc(shortModel(m))}</option>`).join('')}
      </select>
    </label>
    <label class="check"><input type="checkbox" data-watch="auto" ${o.autoAdvance ? 'checked' : ''}> Move on by itself after</label>
    <select data-watch="needed" title="Answers of “done” in a row before moving on">
      ${[1, 2, 3].map((n) => `<option value="${n}" ${n === o.needed ? 'selected' : ''}>${n} “done”${n === 1 ? '' : ' in a row'}</option>`).join('')}
    </select>
    <button type="button" data-watch="stop" class="watch-stop">Stop watching</button>`;
}

export function renderWatchLog(session: WatchSession): string {
  const { looks } = session;
  if (!looks.length) return '';
  const rows = looks
    .map((l) => {
      const step = session.steps[l.step];
      return `
        <li>
          ${l.image ? `<img src="${l.image}" alt="" loading="lazy">` : '<span></span>'}
          <span class="muted">${clockText(l.at - session.startedAt)}</span>
          <span title="${esc(step?.instruction ?? '')}">step ${l.step + 1}</span>
          <span class="log-what">${lookText(l)}</span>
          <span class="muted">${l.latencyMs === undefined ? '' : seconds(l.latencyMs)}</span>
        </li>`;
    })
    .join('');
  return `<summary>Every look (${looks.length})</summary><ol>${rows}</ol>`;
}

function lookText(look: WatchLook): string {
  if (look.error) return `<span class="verdict fail">error</span> ${esc(look.error)}`;
  if (!look.verdict) return '';
  return `<span class="verdict ${look.verdict}">${verdictLabel(look.verdict)}</span> ${esc(look.observation ?? '')}`;
}

function renderProgress(progress: readonly StepProgress[], focus: number | null): string {
  return `
    <ol class="watch-progress">
      ${progress
        .map((p, i) => {
          const cls = i === focus ? 'focus' : p.status;
          const by = p.by === 'before' ? ' before the re-plan' : p.by ? ` by ${p.by}` : '';
          return `<li class="${cls}"><button type="button" data-watch="focus" data-step="${i}" title="Step ${i + 1}: ${p.status}${by}. Click to work on it now.">${i + 1}</button></li>`;
        })
        .join('')}
    </ol>`;
}

function renderLastLook(look: WatchLook, now: number): string {
  return `
    <div class="watch-last">
      ${look.image ? `<img src="${look.image}" alt="The frame it judged">` : ''}
      <div>
        <p class="muted small">Last look, step ${look.step + 1}, ${clockText(now - look.at)} ago${look.model ? ` · ${esc(shortModel(look.model))}` : ''}${look.latencyMs === undefined ? '' : ` · ${seconds(look.latencyMs)}`}</p>
        <p>${lookText(look)}</p>
      </div>
    </div>`;
}

function renderDurations(session: WatchSession): string {
  const rows = session.progress
    .map((p, i) => {
      const s = session.steps[i];
      const took =
        p.startedAt !== undefined && p.endedAt !== undefined
          ? clockText(p.endedAt - p.startedAt)
          : '–';
      const how = p.by === 'watcher' ? 'seen done' : p.by === 'you' ? 'marked done' : p.status;
      return `<tr><td>${i + 1}</td><td>${esc(s?.instruction ?? '')}</td><td>${how}</td><td>${took}</td></tr>`;
    })
    .join('');
  return `<table class="watch-durations"><tbody>${rows}</tbody></table>`;
}

/** The badge a step card shows while its plan is watched. */
export function stepBadge(p: StepProgress, focused: boolean): string {
  if (focused) return '<span class="badge watch-focus">doing now</span>';
  if (p.status === 'done') {
    const by = p.by === 'watcher' ? 'seen done' : p.by === 'you' ? 'marked done' : 'done before';
    return `<span class="badge pass">${by}</span>`;
  }
  if (p.status === 'skipped') return '<span class="badge">skipped</span>';
  return '';
}

import type { BenchCheckExpect, StepCheckCriterion, StepCheckVerdict } from '@clio/protocol';
import type { StepProgress, WatchLook, WatchSession } from './live-watch';
import { esc, shortModel } from './plan-view';

// Pure HTML for the live watch panel. It comes in parts so the page can redraw the status on
// every answer without closing a dropdown the tester has open in the controls, the log, or the
// form that saves a look as a watcher test.

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

/** 0 is "as fast as it answers": the next look starts a moment after the last answer. */
export const INTERVALS_MS = [0, 2000, 3000, 6000, 10_000] as const;
export const AS_FAST_AS_IT_ANSWERS = 0;

export const clockText = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

export function verdictLabel(verdict: StepCheckVerdict): string {
  return verdict === 'done' ? 'done' : verdict === 'not_done' ? 'not done' : 'unsure';
}

export function expectText(expect: BenchCheckExpect): string {
  return expect === 'not_done' ? 'not done' : expect;
}

function intervalLabel(ms: number): string {
  // The headset's step watcher looks again 1 s after each answer.
  if (ms === AS_FAST_AS_IT_ANSWERS) return 'as fast as it answers (like the headset)';
  return `every ${ms / 1000} s`;
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
  const percent = focus === null ? undefined : session.progress[focus]?.percent;
  const wrong = last && last.step === focus && last.wrong ? last.wrong : null;
  const now = step
    ? `
      <div class="watch-now">
        <p class="muted small">Step ${(focus ?? 0) + 1} of ${steps.length}: <code>${esc(step.id)}</code></p>
        <p class="instruction">${esc(step.instruction)}</p>
        <p class="done-when"><span>Done when</span>${step.doneWhen ? esc(step.doneWhen) : '<em>not given: judged by the instruction</em>'}</p>
        ${percent === undefined ? '' : renderMeter(percent)}
        ${wrong ? `<p class="watch-wrong">Wrong: ${esc(wrong)}</p>` : ''}
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
      ${session.wrongCount ? `<span class="badge fail">${session.wrongCount} wrong</span>` : ''}
      <span class="muted watch-clock">${step ? `${clockText(time.step)} on this step · ` : ''}${clockText(time.total)} in all</span>
    </div>
    ${renderProgress(session.progress, focus)}
    <div class="watch-body">
      ${now}
      ${last ? renderLastLook(last, o.now) : '<div class="watch-last muted">The first look comes in a moment. Start doing the step.</div>'}
    </div>`;
}

/** How far along the focused step looks, as a bar. */
function renderMeter(percent: number): string {
  const p = Math.max(0, Math.min(100, Math.round(percent)));
  return `<div class="step-meter" title="How far along the step looks"><span style="width:${p}%"></span></div><p class="muted small">Looks ${p}% along.</p>`;
}

export function renderWatchControls(o: WatchControlsOptions): string {
  const off = o.complete ? 'disabled' : '';
  return `
    <button type="button" data-watch="pause" ${off}>${o.paused ? 'Resume' : 'Pause'}</button>
    <button type="button" data-watch="done" class="ok" ${off}>Mark done</button>
    <button type="button" data-watch="skip" ${off}>Skip</button>
    <button type="button" data-watch="back">Back a step</button>
    <button type="button" data-watch="look" ${off}>Look now</button>
    <label>Look
      <select data-watch="interval">
        ${INTERVALS_MS.map((ms) => `<option value="${ms}" ${ms === o.intervalMs ? 'selected' : ''}>${intervalLabel(ms)}</option>`).join('')}
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
      const instruction = l.asked?.step.instruction ?? session.steps[l.step]?.instruction ?? '';
      const save =
        l.image && l.asked
          ? `<button type="button" class="link" data-watch="save-test" data-look="${l.n ?? ''}" title="Keep this look as a watcher test, with the answer it should have given">Save as test</button>`
          : '<span></span>';
      return `
        <li class="${l.wrong ? 'wrong' : ''}">
          ${l.image ? renderLookFrame(l, 'thumb') : '<span></span>'}
          <span class="muted">${clockText(l.at - session.startedAt)}</span>
          <span title="${esc(instruction)}">step ${l.step + 1}</span>
          <span class="log-what">${lookText(l)}</span>
          <span class="muted">${l.latencyMs === undefined ? '' : seconds(l.latencyMs)}</span>
          ${save}
        </li>`;
    })
    .join('');
  const wrong = session.wrongCount ? `, ${session.wrongCount} wrong` : '';
  return `<summary>Every look (${looks.length}${wrong})</summary><ol>${rows}</ol>`;
}

/** The verdict, what went wrong and what the model saw, in one line. */
export function lookText(look: WatchLook): string {
  if (look.error) return `<span class="verdict fail">error</span> ${esc(look.error)}`;
  if (!look.verdict) return '';
  const wrong = look.wrong ? `<span class="verdict wrong">wrong</span> ${esc(look.wrong)} · ` : '';
  const along = look.progress === undefined ? '' : ` <span class="muted">${look.progress}%</span>`;
  const hazard = look.hazard
    ? ` · <span class="verdict hazard">hazard</span> ${esc(look.hazard)}`
    : '';
  return `${wrong}<span class="verdict ${look.verdict}">${verdictLabel(look.verdict)}</span> ${esc(look.observation ?? '')}${along}${hazard}${criteriaText(look.criteria)}`;
}

const MET_MARK = { yes: '✓', no: '✗', unsure: '?' } as const;

/** Each criterion as judged: "✓ cup A is pink · ✗ cup C is still purple (blue-green)". */
export function criteriaText(criteria: readonly StepCheckCriterion[] | undefined): string {
  if (!criteria?.length) return '';
  const items = criteria.map(
    (c) =>
      `<span class="criterion ${c.met}" title="${esc(c.seen ?? '')}">${MET_MARK[c.met]} ${esc(c.text)}${c.met !== 'yes' && c.seen ? ` <span class="muted">(${esc(c.seen)})</span>` : ''}</span>`,
  );
  return `<span class="criteria">${items.join(' · ')}</span>`;
}

/** The frame a look judged, with the point that decided it when the model gave one. */
export function renderLookFrame(look: WatchLook, size: 'thumb' | 'large'): string {
  if (!look.image) return '';
  const e = look.evidence;
  const at = e
    ? `left:${(e.point[0] * 100).toFixed(1)}%;top:${(e.point[1] * 100).toFixed(1)}%`
    : '';
  // A label on the right half goes left of its point, so it stays on the frame.
  const side = e && e.point[0] > 0.5 ? ' left' : '';
  const marker = e
    ? `<span class="evidence" style="${at}" title="${esc(e.label)}"></span>${size === 'large' ? `<span class="evidence-label${side}" style="${at}">${esc(e.label)}</span>` : ''}`
    : '';
  // The status redraws every second: a lazy image there would blink while it decodes.
  const img =
    size === 'large'
      ? `<img src="${look.image}" alt="The frame it judged" decoding="sync">`
      : `<img src="${look.image}" alt="" loading="lazy">`;
  return `<span class="look-frame ${size}">${img}${marker}</span>`;
}

function renderProgress(progress: readonly StepProgress[], focus: number | null): string {
  return `
    <ol class="watch-progress">
      ${progress
        .map((p, i) => {
          const cls = i === focus ? 'focus' : p.status;
          const by = p.by === 'before' ? ' before the re-plan' : p.by ? ` by ${p.by}` : '';
          const along = i === focus && p.percent !== undefined ? `, ${p.percent}% along` : '';
          const fill =
            i === focus && p.percent !== undefined
              ? ` style="--along:${Math.max(0, Math.min(100, p.percent))}%"`
              : '';
          return `<li class="${cls}"><button type="button" data-watch="focus" data-step="${i}"${fill} title="Step ${i + 1}: ${p.status}${by}${along}. Click to work on it now.">${i + 1}</button></li>`;
        })
        .join('')}
    </ol>`;
}

function renderLastLook(look: WatchLook, now: number): string {
  return `
    <div class="watch-last${look.wrong ? ' wrong' : ''}">
      ${renderLookFrame(look, 'large')}
      <div>
        <p class="muted small">Last look, step ${look.step + 1}, ${clockText(now - look.at)} ago${look.model ? ` · ${esc(shortModel(look.model))}` : ''}${look.latencyMs === undefined ? '' : ` · ${seconds(look.latencyMs)}`}</p>
        <p>${lookText(look)}</p>
        ${look.evidence ? `<p class="muted small">Decided by: ${esc(look.evidence.label)}</p>` : ''}
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
  if (focused) {
    const along = p.percent === undefined ? '' : ` · ${p.percent}%`;
    return `<span class="badge watch-focus">doing now${along}</span>`;
  }
  if (p.status === 'done') {
    const by = p.by === 'watcher' ? 'seen done' : p.by === 'you' ? 'marked done' : 'done before';
    return `<span class="badge pass">${by}</span>`;
  }
  if (p.status === 'skipped') return '<span class="badge">skipped</span>';
  return '';
}

/** The answer a saved look should have given: the opposite of a "done", or "done" otherwise. */
export function suggestedExpect(look: WatchLook): BenchCheckExpect {
  if (look.wrong) return 'wrong';
  return look.verdict === 'done' ? 'not_done' : 'done';
}

/**
 * Keeps one look as a watcher test: its frames, the step and the hints it was asked with, and the
 * answer it should have given. Saved from the log, e.g. when the watcher took the milk for the
 * yogurt drink.
 */
export function renderSaveTest(look: WatchLook, goal: string): string {
  const asked = look.asked;
  if (!asked || !look.image) return '';
  const expect = suggestedExpect(look);
  const option = (value: BenchCheckExpect, label: string, hint: string) =>
    `<label class="check" title="${esc(hint)}"><input type="radio" name="expect" value="${value}" ${value === expect ? 'checked' : ''}> ${label}</label>`;
  const title = `${asked.step.instruction}${look.verdict ? ` (said ${verdictLabel(look.verdict)})` : ''}`;
  return `
    <form class="save-test" data-look="${look.n ?? ''}">
      <h3>Save look ${look.n ?? ''} as a watcher test</h3>
      <div class="save-test-frames">
        ${look.before ? `<figure><img src="${look.before}" alt=""><figcaption>When the step started</figcaption></figure>` : '<figure class="muted small">No frame from when the step started</figure>'}
        <figure>${renderLookFrame(look, 'large')}<figcaption>The frame it judged</figcaption></figure>
      </div>
      <p class="small"><span class="muted">Goal</span> ${esc(goal)} · <span class="muted">Step</span> ${esc(asked.step.instruction)}${asked.step.doneWhen ? ` · <span class="muted">Done when</span> ${esc(asked.step.doneWhen)}` : ''}</p>
      ${asked.objects.length ? `<p class="small"><span class="muted">Objects</span> ${asked.objects.map((o) => `<strong>${esc(o.label)}</strong>: ${esc(o.look)}`).join('; ')}</p>` : ''}
      ${asked.confusions.length ? `<p class="small"><span class="muted">Mix-ups</span> ${asked.confusions.map(esc).join('; ')}</p>` : ''}
      <p class="small"><span class="muted">It said</span> ${lookText(look)}</p>
      <div class="row expect-row">
        <span class="label">It should have said</span>
        ${option('done', 'done', 'The step is done in this frame')}
        ${option('not_done', 'not done', 'Not done yet; unsure also passes')}
        ${option('wrong', 'wrong', 'Not done, and it must say what the learner did instead')}
        ${option('unsure', 'unsure', 'The frame cannot tell: hidden, out of view or blurred')}
      </div>
      <label>Title <input name="title" maxlength="120" required value="${esc(title.slice(0, 120))}"></label>
      <div class="row">
        <button type="submit" class="primary">Save watcher test</button>
        <button type="button" data-watch="save-cancel">Cancel</button>
      </div>
    </form>`;
}

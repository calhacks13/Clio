import type {
  BenchJudgement,
  BenchRun,
  BenchScenarioSummary,
  Check,
  PlanSighting,
  PlanStage,
  Procedure,
  StepCheckResponse,
} from '@clio/protocol';
import { pairStages, stageTiming } from './stages';

// Pure HTML for the planner bench page: a run (the plan, how it was made, its grades), the run
// chips, the scenario list and where the planner saw things in the frames. Everything
// model-written is escaped.

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

type Step = Procedure['steps'][number];
type Action = NonNullable<Step['action']>;

export interface StepCheckState {
  pending: boolean;
  result?: StepCheckResponse;
  error?: string;
}

/** A plan made in two stages, as the run view shows it. */
export interface StageView {
  first: BenchRun;
  /** The run that refined the first one's outline, once it has come. */
  rest?: BenchRun;
  /** The rest is being planned now. */
  refining: boolean;
}

/** A plan request still in flight. */
export interface PendingChip {
  model: string;
  elapsedMs: number;
  stage?: PlanStage;
  /** For stage rest: the run whose outline it refines. */
  after?: string;
}

export interface RunViewOptions {
  /** The run belongs to a saved scenario, so grades save at once and the judge can read it. */
  saved: boolean;
  /** Why the judge can't run, or null when it can. */
  judgeBlocked: string | null;
  judgeModel: string;
  judging: boolean;
  /** Step checks by step index. */
  checks: ReadonlyMap<number, StepCheckState>;
  /** This run's plan is being watched live. */
  watching: boolean;
  /** The camera and the models are there, so watching live can start. */
  canWatch: boolean;
  /** The run is one stage of a two-stage plan. */
  stage?: StageView;
}

const cm = (m: number) => `${Math.round(m * 100)} cm`;
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** A success check or mistake trigger in a few words. */
export function describeCheck(check: Check): string {
  switch (check.type) {
    case 'pinch_near':
      return `${check.hand} hand pinches within ${cm(check.radius)} of ${check.object}`;
    case 'hand_near':
      return `${check.hand} hand's ${check.point.replace('_', ' ')} within ${cm(check.radius)} of ${check.object}${check.dwellMs ? ` for ${seconds(check.dwellMs)}` : ''}`;
    case 'lift':
      return `${check.hand} hand's ${check.point.replace('_', ' ')} ${cm(check.height)} above the table`;
    case 'object_near':
      return `${check.object} within ${cm(check.radius)} of ${check.target}`;
    case 'confirm':
      return `${check.by === 'either' ? 'coach or learner' : check.by} confirms${check.prompt ? `: “${check.prompt}”` : ''}`;
    case 'elapsed':
      return `after ${seconds(check.ms)}`;
    case 'all':
      return `all of: ${check.of.map(describeCheck).join('; ')}`;
    case 'any':
      return `any of: ${check.of.map(describeCheck).join('; ')}`;
    case 'sequence':
      return check.of.map(describeCheck).join(' → ');
  }
}

export function describeAction(action: Action): string {
  const args = [action.object, action.target].filter(Boolean).join(' → ');
  const how = [action.direction, action.amount].filter((v) => v !== undefined).join(' ');
  const hand = action.hand !== 'either' ? `${action.hand} hand` : '';
  const extra = [how, hand, action.note ?? ''].filter((v) => v !== '').join(', ');
  return `${action.verb}(${args})${extra ? ` ${extra}` : ''}`;
}

/** "gemini-3.8-flash" → "3.8-flash": chips are narrow. */
export const shortModel = (model: string) => model.replace(/^gemini-/, '');

function stageLabel(stage: PlanStage | undefined): string {
  return stage === 'first' ? ' · stage 1' : stage === 'rest' ? ' · the rest' : '';
}

export function renderRunChip(run: BenchRun, selected: boolean, goalDiffers: boolean): string {
  const status = run.result.ok
    ? `${run.result.procedure.steps.length} steps${stageLabel(run.request.stage)}`
    : `failed: ${esc(run.result.code)}`;
  const grade = run.verdict
    ? `<span class="badge ${run.verdict.grade}">${run.verdict.grade}</span>`
    : '';
  const judge = run.judgement
    ? `<span class="badge ${run.judgement.passed ? 'pass' : 'fail'}">judge ${run.judgement.criteria.filter((c) => c.met).length}/${run.judgement.criteria.length}</span>`
    : '';
  return `
    <button class="chip${selected ? ' selected' : ''}${run.result.ok ? '' : ' failed'}" data-action="select-run" data-run="${esc(run.id)}"
      title="${esc(run.model)}, ${new Date(run.createdAt).toLocaleTimeString()}${goalDiffers ? ` — goal: ${esc(run.request.goal)}` : ''}">
      <strong>${esc(shortModel(run.model))}</strong>
      <span>${seconds(run.latencyMs)} · ${status}${run.attempts > 1 ? ' · retried' : ''}${goalDiffers ? ' · other goal' : ''}</span>
      ${grade}${judge}
    </button>`;
}

export function renderPendingChip(model: string, elapsedMs: number, stage?: PlanStage): string {
  const what =
    stage === 'first' ? 'planning step 1…' : stage === 'rest' ? 'refining the rest…' : 'planning…';
  return `
    <div class="chip pending">
      <strong>${esc(shortModel(model))}</strong>
      <span>${what} ${seconds(elapsedMs)}</span>
    </div>`;
}

/**
 * Every chip, newest first. The two stages of a plan sit together, the refined rest (or the
 * request for it, still in flight) after the stage-first run it refines.
 */
export function renderChipList(
  runs: readonly BenchRun[],
  pending: readonly PendingChip[],
  options: { selected: string | null; goal?: string },
): string {
  const pairs = pairStages(runs);
  const rests = new Set([...pairs.values()].map((r) => r.id));
  const waiting = new Map(pending.flatMap((p) => (p.after ? [[p.after, p] as const] : [])));
  const chip = (r: BenchRun) =>
    renderRunChip(
      r,
      r.id === options.selected,
      options.goal !== undefined && r.request.goal !== options.goal,
    );
  const pendingChip = (p: PendingChip) => renderPendingChip(p.model, p.elapsedMs, p.stage);
  const loose = pending.filter((p) => !p.after || !runs.some((r) => r.id === p.after));
  return [
    ...loose.map(pendingChip),
    ...runs
      .filter((r) => !rests.has(r.id))
      .map((r) => {
        const rest = pairs.get(r.id);
        const wait = waiting.get(r.id);
        if (!rest && !wait) return chip(r);
        return `<span class="chip-pair" title="One plan in two stages">${chip(r)}<span class="pair-arrow" aria-hidden="true">→</span>${rest ? chip(rest) : wait ? pendingChip(wait) : ''}</span>`;
      }),
  ].join('');
}

export function renderRun(run: BenchRun, options: RunViewOptions): string {
  const { result, request } = run;
  const title = result.ok ? esc(result.procedure.title) : 'No plan';
  const summary = result.ok ? esc(result.procedure.summary) : '';
  return `
    <article class="run">
      <header class="run-head">
        <div>
          <h2>${title}</h2>
          ${summary ? `<p class="muted">${summary}</p>` : ''}
          <p class="request">Goal: <q>${esc(request.goal)}</q>${request.context ? ` · Learner said: <q>${esc(request.context)}</q>` : ''}</p>
          ${request.revise && request.stage !== 'rest' ? `<p class="request">Re-plan from step ${request.revise.fromStepIndex + 1} because: <q>${esc(request.revise.reason)}</q></p>` : ''}
          ${renderStageLine(run, options.stage)}
        </div>
        <dl class="run-meta">
          <div><dt>Model</dt><dd>${esc(run.model)}</dd></div>
          <div><dt>Time</dt><dd>${seconds(run.latencyMs)}</dd></div>
          <div><dt>Tries</dt><dd>${run.attempts}</dd></div>
          <div><dt>Views</dt><dd>${request.views}</dd></div>
          ${run.budgetMs ? `<div><dt>Budget</dt><dd>${seconds(run.budgetMs)}</dd></div>` : ''}
        </dl>
      </header>
      ${
        run.firstAttemptErrors
          ? `<details class="retry"><summary>The first draft failed validation and was retried</summary><pre>${esc(run.firstAttemptErrors)}</pre></details>`
          : ''
      }
      ${result.ok ? renderWatchStart(options) : ''}
      ${renderGrade(run, options)}
      ${run.judgement ? renderJudgement(run.judgement) : ''}
      ${result.ok ? renderPlan(run, result.procedure, result.warnings, options.checks) : renderFailure(result)}
    </article>`;
}

/** How a two-stage plan came together: when step 1 was ready, and when the rest. */
function renderStageLine(run: BenchRun, stage: StageView | undefined): string {
  const { first, rest, refining } = stage ?? { first: run, refining: false };
  if (first.request.stage !== 'first' && run.request.stage !== 'rest') return '';
  const ready = `Step 1 ready in ${seconds(first.latencyMs)}`;
  const link = (to: BenchRun, label: string) =>
    `<button type="button" class="link" data-action="select-run" data-run="${esc(to.id)}">${label}</button>`;
  let text: string;
  if (run.request.stage === 'rest') {
    const timing = stage?.rest ? stageTiming(first, run) : null;
    text = timing
      ? `Step 1 was ready in ${seconds(timing.firstMs)}, this refined rest ${seconds(timing.restMs)} later. ${link(first, 'Show stage 1')}`
      : `The rest of a two-stage plan, refined from step ${(run.request.revise?.fromStepIndex ?? 0) + 1}.`;
  } else if (rest && !rest.result.ok) {
    text = `${ready}; refining the rest failed (${esc(rest.result.code)}). ${link(rest, 'Show why')}`;
  } else if (rest) {
    const { restMs } = stageTiming(first, rest);
    text = `${ready}, the rest refined ${seconds(restMs)} later. ${link(rest, 'Show the refined plan')}`;
  } else if (refining) {
    text = `${ready}; refining the rest…`;
  } else {
    text = `${ready}; the rest was not refined.`;
  }
  return `<p class="request stage-line">Two stages: ${text}</p>`;
}

function renderWatchStart(options: RunViewOptions): string {
  if (options.watching) {
    return '<p class="watch-start muted">Watching this plan live: progress is above and on each step.</p>';
  }
  return `
    <section class="watch-start">
      <button type="button" class="primary" data-action="watch-start" ${options.canWatch ? '' : 'disabled title="Needs the live camera and Gemini"'}>Watch me do it live</button>
      <span class="hint">Do the steps in front of the camera. The step watcher looks at the live camera every few seconds and follows your progress through the plan.</span>
    </section>`;
}

function renderGrade(run: BenchRun, options: RunViewOptions): string {
  const grade = run.verdict?.grade;
  const button = (g: 'pass' | 'partial' | 'fail', label: string) =>
    `<button class="grade-btn ${g}${grade === g ? ' on' : ''}" data-action="grade" data-grade="${g}">${label}</button>`;
  const judge = options.judging
    ? `<button disabled>Judging with ${esc(shortModel(options.judgeModel))}…</button>`
    : `<button data-action="judge" ${options.judgeBlocked ? `disabled title="${esc(options.judgeBlocked)}"` : ''}>Judge with ${esc(shortModel(options.judgeModel))}</button>`;
  return `
    <section class="grade">
      <span class="label">Your grade</span>
      ${button('pass', 'Correct')}${button('partial', 'Partly')}${button('fail', 'Wrong')}
      <input class="grade-notes" data-action="grade-notes" placeholder="What was wrong or missing?" value="${esc(run.verdict?.notes ?? '')}">
      ${judge}
      ${options.saved ? '' : '<span class="hint">Grades are kept when you save the scenario.</span>'}
      ${options.judgeBlocked && !options.judging ? `<span class="hint">${esc(options.judgeBlocked)}</span>` : ''}
    </section>`;
}

export function renderJudgement(j: BenchJudgement): string {
  const met = j.criteria.filter((c) => c.met).length;
  return `
    <section class="judgement ${j.passed ? 'pass' : 'fail'}">
      <h3>Judge: ${met} of ${j.criteria.length} expectations met <small>${esc(j.model)}, ${seconds(j.latencyMs)}</small></h3>
      <ul>
        ${j.criteria
          .map(
            (c) =>
              `<li class="${c.met ? 'met' : 'unmet'}"><span class="mark">${c.met ? '✓' : '✗'}</span><div><strong>${esc(c.expectation)}</strong><p>${esc(c.reason)}</p></div></li>`,
          )
          .join('')}
      </ul>
      ${
        j.issues.length
          ? `<h4>Other problems</h4><ul class="issues">${j.issues.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`
          : ''
      }
    </section>`;
}

function renderFailure(result: Extract<BenchRun['result'], { ok: false }>): string {
  const details =
    result.details === undefined
      ? ''
      : `<pre>${esc(
          typeof (result.details as { errors?: unknown }).errors === 'string'
            ? (result.details as { errors: string }).errors
            : JSON.stringify(result.details, null, 2),
        )}</pre>`;
  return `
    <section class="failure">
      <h3>${esc(result.code)}</h3>
      <p>${esc(result.message)}</p>
      ${details}
    </section>`;
}

/** How a step came to be in the plan, when that is worth a badge. */
export type StepMark = 'kept' | 'stage1' | 'outline' | 'refined';

const STEP_MARKS: Record<StepMark, string> = {
  kept: 'done before the re-plan',
  stage1: 'as in stage 1',
  outline: 'outline',
  refined: 'refined',
};

export function stepMark(run: BenchRun, index: number): StepMark | null {
  const { request, result } = run;
  if (!result.ok) return null;
  const from = request.revise?.fromStepIndex;
  if (request.stage === 'rest' && from !== undefined) return index < from ? 'stage1' : 'refined';
  if (result.outlineFrom !== undefined && index >= result.outlineFrom) return 'outline';
  if (from !== undefined && index < from) return 'kept';
  return null;
}

function renderPlan(
  run: BenchRun,
  procedure: Procedure,
  warnings: readonly string[],
  checks: ReadonlyMap<number, StepCheckState>,
): string {
  const notes = procedure.workspace.notes;
  const outlineFrom = run.result.ok ? run.result.outlineFrom : undefined;
  const count = procedure.steps.length;
  const outline =
    outlineFrom !== undefined && outlineFrom < count
      ? `<p class="note outline-note">${outlineFrom + 1 === count ? `Step ${count} is` : `Steps ${outlineFrom + 1} to ${count} are`} only an outline: stage 1 writes step 1 as a short card so the lesson can start, and the rest stage writes the outline in full.</p>`
      : '';
  return `
    ${
      warnings.length
        ? `<section class="warnings"><h3>Warnings</h3><ul>${warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></section>`
        : '<p class="muted small">No warnings.</p>'
    }
    ${notes ? `<p class="muted small">Setup: ${esc(notes)}</p>` : ''}
    ${outline}
    <ol class="steps">
      ${procedure.steps.map((s, i) => renderStep(s, i, stepMark(run, i), checks.get(i))).join('')}
    </ol>
    ${renderObjects(procedure)}
    <details class="raw"><summary>Plan JSON</summary><pre>${esc(JSON.stringify(procedure, null, 2))}</pre></details>`;
}

function renderStep(
  step: Step,
  index: number,
  mark: StepMark | null,
  check?: StepCheckState,
): string {
  const facts: Array<[string, string]> = [];
  if (step.action) facts.push(['Action', `<code>${esc(describeAction(step.action))}</code>`]);
  if (step.targets.length) facts.push(['Targets', esc(step.targets.join(', '))]);
  facts.push(['Success', esc(describeCheck(step.success))]);
  if (step.show.length) {
    facts.push([
      'Outlines',
      `<ul>${step.show.map((s) => `<li><strong>${esc(s.phrase)}</strong> — ${esc(s.description)}</li>`).join('')}</ul>`,
    ]);
  }
  if (step.mistakes.length) {
    facts.push([
      'Mistakes',
      `<ul>${step.mistakes.map((m) => `<li><code>${esc(m.kind)}</code> “${esc(m.message)}” <span class="muted">when ${esc(describeCheck(m.when))}</span></li>`).join('')}</ul>`,
    ]);
  }
  if (step.detail) facts.push(['Detail', esc(step.detail)]);
  if (step.coachNotes) facts.push(['Coach', esc(step.coachNotes)]);
  return `
    <li class="step${mark ? ` ${mark}` : ''}" data-step="${index}">
      <div class="step-head">
        <span class="step-n">${index + 1}</span>
        <code>${esc(step.id)}</code>
        ${mark ? `<span class="badge mark-${mark}">${STEP_MARKS[mark]}</span>` : ''}
        <span class="watch-status"></span>
        <span class="hand">${esc(step.hand)} hand</span>
      </div>
      <p class="instruction">${esc(step.instruction)}</p>
      <p class="done-when"><span>Done when</span>${step.doneWhen ? esc(step.doneWhen) : '<em>not given</em>'}</p>
      <dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
      <div class="step-tools">
        <button data-action="check" data-step="${index}" ${check?.pending ? 'disabled' : ''}>${check?.pending ? 'Checking…' : 'Does it look done?'}</button>
        <button data-action="replan-open" data-step="${index}">Re-plan from here</button>
        <span class="check-result">${check ? renderCheck(check) : ''}</span>
      </div>
      <form class="replan" data-step="${index}" hidden>
        <input name="reason" required maxlength="300" placeholder="What changed? e.g. the vinegar bottle is empty">
        <button type="submit">Re-plan with a new capture</button>
      </form>
    </li>`;
}

function renderCheck(check: StepCheckState): string {
  if (check.error) return `<span class="verdict fail">${esc(check.error)}</span>`;
  if (!check.result) return '';
  const { verdict, observation, model, latencyMs, progress, wrong } = check.result;
  const label = verdict === 'done' ? 'done' : verdict === 'not_done' ? 'not done' : 'unsure';
  const along = progress === undefined ? '' : ` <span class="muted">${progress}% along</span>`;
  const mistake = wrong ? `<span class="verdict wrong">wrong</span> ${esc(wrong)} · ` : '';
  return `${mistake}<span class="verdict ${verdict}">${label}</span> ${esc(observation)}${along} <span class="muted">${esc(shortModel(model))}, ${seconds(latencyMs)}</span>`;
}

/**
 * Where the planner saw the plan's objects in one camera view: a box and a labeled point each,
 * as SVG laid over the frame. The view box is the frame's own size and the SVG scales like an
 * `object-fit: contain` image, so the marks land on the picture whatever the viewer's shape.
 */
export function renderSightings(
  sightings: readonly PlanSighting[],
  objects: Procedure['objects'],
  view: number,
  size: { width: number; height: number },
): string {
  const { width: w, height: h } = size;
  const shown = sightings.filter((s) => s.view === view);
  if (!shown.length || !w || !h) return '';
  const labels = new Map(objects.map((o) => [o.id, o.label]));
  const font = Math.max(12, Math.round(h / 28));
  const r = Math.max(4, Math.round(font / 3));
  const n = (v: number) => Math.round(v * 10) / 10;
  const marks = shown.map((s) => {
    const [x, y] = [s.point[0] * w, s.point[1] * h];
    const label = esc(labels.get(s.objectId) ?? s.objectId);
    let box = '';
    let tx = x + r * 1.6;
    let ty = y - r * 1.6;
    if (s.box) {
      const [x0, y0, x1, y1] = s.box;
      const [left, top] = [Math.min(x0, x1) * w, Math.min(y0, y1) * h];
      const [bw, bh] = [Math.abs(x1 - x0) * w, Math.abs(y1 - y0) * h];
      box = `<rect x="${n(left)}" y="${n(top)}" width="${n(bw)}" height="${n(bh)}"/>`;
      tx = left;
      ty = top - r;
    }
    if (ty < font) ty = (s.box ? Math.max(s.box[1], s.box[3]) * h : y) + font + r;
    tx = Math.min(Math.max(0, tx), w - font);
    return `<g class="sighting"><title>${label} (${esc(s.objectId)})</title>${box}<circle cx="${n(x)}" cy="${n(y)}" r="${r}"/><text x="${n(tx)}" y="${n(ty)}" font-size="${font}">${label}</text></g>`;
  });
  return `<svg class="sightings" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Where the planner saw the objects">${marks.join('')}</svg>`;
}

function renderObjects(procedure: Procedure): string {
  const rows = procedure.objects
    .map((o) => {
      const look = o.tracking?.query ?? o.description ?? '';
      const hint = o.placement.method === 'detect' ? (o.placement.hint ?? '') : o.placement.method;
      return `<tr><td><code>${esc(o.id)}</code></td><td>${esc(o.label)}</td><td>${esc(o.kind)}</td><td>${esc(look)}</td><td>${o.tracking?.moves ? 'moves' : ''}</td><td>${esc(hint)}</td></tr>`;
    })
    .join('');
  return `
    <section class="objects">
      <h3>Objects (${procedure.objects.length})</h3>
      <table>
        <thead><tr><th>Id</th><th>Label</th><th>Kind</th><th>Looks like</th><th></th><th>Where</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </section>`;
}

/** The last run of a scenario, as one badge. */
export function lastRunBadge(last: BenchScenarioSummary['lastRun']): string {
  if (!last) return '<span class="badge">not run</span>';
  if (!last.ok) return '<span class="badge fail">failed</span>';
  const judge = last.judged
    ? `<span class="badge ${last.passed ? 'pass' : 'fail'}">judge ${last.passed ? '✓' : '✗'}</span>`
    : '';
  const grade = last.grade ? `<span class="badge ${last.grade}">${last.grade}</span>` : '';
  return grade || judge ? `${grade}${judge}` : '<span class="badge">ungraded</span>';
}

export function renderScenarioItem(
  s: BenchScenarioSummary,
  thumbUrl: string,
  active: boolean,
): string {
  return `
    <li>
      <button class="scenario${active ? ' active' : ''}" data-action="load-scenario" data-id="${esc(s.id)}">
        <img src="${esc(thumbUrl)}" alt="" loading="lazy">
        <span class="scenario-text">
          <strong>${esc(s.title)}</strong>
          <span class="muted">${esc(s.goal)}</span>
          <span class="tags">
            ${s.revising ? '<span class="tag">re-plan</span>' : ''}
            ${s.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}
            <span class="tag">${s.expectCount} expect</span>
          </span>
          <span class="last">${lastRunBadge(s.lastRun)} <span class="muted">${s.runCount} run${s.runCount === 1 ? '' : 's'}</span></span>
        </span>
      </button>
    </li>`;
}

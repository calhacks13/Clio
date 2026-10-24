import type {
  BenchJudgement,
  BenchRun,
  BenchScenarioSummary,
  Check,
  Procedure,
  StepCheckResponse,
} from '@clio/protocol';

// Pure HTML for the planner bench page: a run (the plan, how it was made, its grades), the run
// chips and the scenario list. Everything model-written is escaped.

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

type Step = Procedure['steps'][number];
type Action = NonNullable<Step['action']>;

export interface StepCheckState {
  pending: boolean;
  result?: StepCheckResponse;
  error?: string;
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

export function renderRunChip(run: BenchRun, selected: boolean, goalDiffers: boolean): string {
  const status = run.result.ok
    ? `${run.result.procedure.steps.length} steps`
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

export function renderPendingChip(model: string, elapsedMs: number): string {
  return `
    <div class="chip pending">
      <strong>${esc(shortModel(model))}</strong>
      <span>planning… ${seconds(elapsedMs)}</span>
    </div>`;
}

export function renderRun(run: BenchRun, options: RunViewOptions): string {
  const { result, request } = run;
  const revisedFrom = request.revise?.fromStepIndex;
  const title = result.ok ? esc(result.procedure.title) : 'No plan';
  const summary = result.ok ? esc(result.procedure.summary) : '';
  return `
    <article class="run">
      <header class="run-head">
        <div>
          <h2>${title}</h2>
          ${summary ? `<p class="muted">${summary}</p>` : ''}
          <p class="request">Goal: <q>${esc(request.goal)}</q>${request.context ? ` · Learner said: <q>${esc(request.context)}</q>` : ''}</p>
          ${request.revise ? `<p class="request">Re-plan from step ${request.revise.fromStepIndex + 1} because: <q>${esc(request.revise.reason)}</q></p>` : ''}
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
      ${result.ok ? renderPlan(result.procedure, result.warnings, revisedFrom, options.checks) : renderFailure(result)}
    </article>`;
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

function renderPlan(
  procedure: Procedure,
  warnings: readonly string[],
  revisedFrom: number | undefined,
  checks: ReadonlyMap<number, StepCheckState>,
): string {
  const notes = procedure.workspace.notes;
  return `
    ${
      warnings.length
        ? `<section class="warnings"><h3>Warnings</h3><ul>${warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></section>`
        : '<p class="muted small">No warnings.</p>'
    }
    ${notes ? `<p class="muted small">Setup: ${esc(notes)}</p>` : ''}
    <ol class="steps">
      ${procedure.steps.map((s, i) => renderStep(s, i, revisedFrom !== undefined && i < revisedFrom, checks.get(i))).join('')}
    </ol>
    ${renderObjects(procedure)}
    <details class="raw"><summary>Plan JSON</summary><pre>${esc(JSON.stringify(procedure, null, 2))}</pre></details>`;
}

function renderStep(step: Step, index: number, kept: boolean, check?: StepCheckState): string {
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
    <li class="step${kept ? ' kept' : ''}" data-step="${index}">
      <div class="step-head">
        <span class="step-n">${index + 1}</span>
        <code>${esc(step.id)}</code>
        ${kept ? '<span class="badge">done before the re-plan</span>' : ''}
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
  const { verdict, observation, model, latencyMs } = check.result;
  const label = verdict === 'done' ? 'done' : verdict === 'not_done' ? 'not done' : 'unsure';
  return `<span class="verdict ${verdict}">${label}</span> ${esc(observation)} <span class="muted">${esc(shortModel(model))}, ${seconds(latencyMs)}</span>`;
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

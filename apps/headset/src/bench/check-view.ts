import type {
  BenchCheckAnswer,
  BenchCheckExpect,
  BenchCheckRun,
  BenchCheckTestDetail,
  BenchCheckTestSummary,
} from '@clio/protocol';
import { esc, shortModel } from './plan-view';
import { criteriaText, expectText, verdictLabel } from './watch-view';

// Pure HTML for the watcher tests in the library: saved looks of the step watcher, each with the
// answer it should give, run again with any model to see which ones pass.

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** Passes per model as badges: "er-2 3/3". */
export function renderTallies(models: BenchCheckTestSummary['models']): string {
  if (!models.length) return '<span class="badge">not run</span>';
  return models
    .map((m) => {
      const tone = m.passed === m.runs ? 'pass' : m.passed === 0 ? 'fail' : 'partial';
      return `<span class="badge ${tone}" title="${esc(m.model)}: ${m.passed} of ${m.runs} passed">${esc(shortModel(m.model))} ${m.passed}/${m.runs}</span>`;
    })
    .join('');
}

/** One test in the list; `detail` (from renderCheckTestDetail) shows it open. */
export function renderCheckTestItem(
  test: BenchCheckTestSummary,
  thumbUrl: string,
  detail?: string,
): string {
  const open = detail !== undefined;
  return `
    <li class="check-test${open ? ' open' : ''}" data-test="${esc(test.id)}">
      <button class="scenario${open ? ' active' : ''}" data-action="open-test" data-id="${esc(test.id)}" aria-expanded="${open}">
        <img src="${esc(thumbUrl)}" alt="" loading="lazy">
        <span class="scenario-text">
          <strong>${esc(test.title)}</strong>
          <span class="muted">${esc(test.instruction)}</span>
          <span class="tags">
            <span class="tag expect-${test.expect}">should say ${expectText(test.expect)}</span>
            ${test.hasBefore ? '<span class="tag">before + now</span>' : ''}
          </span>
          <span class="last">${renderTallies(test.models)}</span>
        </span>
      </button>
      ${detail ?? ''}
    </li>`;
}

export interface CheckTestDetailOptions {
  frameUrl: (file: string) => string;
  /** Models it is running with now. */
  running: readonly string[];
  /** Models a "Run" would use. */
  models: readonly string[];
}

export function renderCheckTestDetail(
  detail: BenchCheckTestDetail,
  options: CheckTestDetailOptions,
): string {
  const { test, runs } = detail;
  const frame = (file: string, caption: string) =>
    `<figure><img src="${esc(options.frameUrl(file))}" alt="" loading="lazy"><figcaption>${caption}</figcaption></figure>`;
  const option = (value: BenchCheckExpect) =>
    `<option value="${value}" ${value === test.expect ? 'selected' : ''}>${expectText(value)}</option>`;
  const seen = test.seen
    ? `<p class="small"><span class="muted">When saved, ${esc(shortModel(test.seen.model))} said</span> ${renderAnswer(test.seen)}</p>`
    : '';
  const running = options.running.length
    ? `<button type="button" disabled>Running with ${options.running.map((m) => esc(shortModel(m))).join(', ')}…</button>`
    : `<button type="button" data-action="run-test" data-id="${esc(test.id)}" ${options.models.length ? '' : 'disabled title="Tick a model first"'}>Run with ${options.models.length === 1 ? esc(shortModel(options.models[0] ?? '')) : `${options.models.length} models`}</button>`;
  return `
    <div class="check-test-detail">
      <div class="save-test-frames">
        ${test.before.map((f) => frame(f.file, 'When the step started')).join('')}
        ${test.now.map((f) => frame(f.file, 'The frame it judges')).join('')}
      </div>
      <p class="small"><span class="muted">Goal</span> ${esc(test.goal)}</p>
      <p class="small"><span class="muted">Step</span> ${esc(test.step.instruction)} <code>${esc(test.step.id)}</code></p>
      ${test.step.doneWhen ? `<p class="small"><span class="muted">Done when</span> ${esc(test.step.doneWhen)}</p>` : ''}
      ${test.objects.length ? `<p class="small"><span class="muted">Objects</span> ${test.objects.map((o) => `<strong>${esc(o.label)}</strong>: ${esc(o.look)}`).join('; ')}</p>` : ''}
      ${test.confusions.length ? `<p class="small"><span class="muted">Mix-ups</span> ${test.confusions.map(esc).join('; ')}</p>` : ''}
      ${test.notes ? `<p class="small"><span class="muted">Notes</span> ${esc(test.notes)}</p>` : ''}
      ${seen}
      <div class="row">
        <label class="inline">Should say <select data-action="test-expect" data-id="${esc(test.id)}">${option('done')}${option('not_done')}${option('wrong')}${option('unsure')}</select></label>
        ${running}
        <button type="button" class="danger" data-action="delete-test" data-id="${esc(test.id)}">Delete</button>
      </div>
      ${runs.length ? `<ol class="check-runs">${runs.map(renderCheckRun).join('')}</ol>` : '<p class="muted small">Not run yet.</p>'}
    </div>`;
}

function renderAnswer(
  answer: Pick<BenchCheckAnswer, 'verdict' | 'observation' | 'wrong' | 'progress' | 'criteria'>,
): string {
  const wrong = answer.wrong
    ? `<span class="verdict wrong">wrong</span> ${esc(answer.wrong)} · `
    : '';
  const along =
    answer.progress === undefined ? '' : ` <span class="muted">${answer.progress}%</span>`;
  return `${wrong}<span class="verdict ${answer.verdict}">${verdictLabel(answer.verdict)}</span> ${esc(answer.observation)}${along}${criteriaText(answer.criteria)}`;
}

export function renderCheckRun(run: BenchCheckRun): string {
  const what = run.result.ok
    ? renderAnswer(run.result.answer)
    : `<span class="verdict fail">failed</span> ${esc(run.result.message)}`;
  return `
    <li class="${run.passed ? 'pass' : 'fail'}" title="${new Date(run.createdAt).toLocaleString()}">
      <span class="run-mark">${run.passed ? '✓' : '✗'}</span>
      <span><strong>${esc(shortModel(run.model))}</strong> <span class="muted">${run.variant ? `${esc(run.variant)}, ` : ''}${seconds(run.latencyMs)}, expected ${expectText(run.expect)}</span><br>${what}</span>
    </li>`;
}

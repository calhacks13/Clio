import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  type BenchCheckExpect,
  type BenchCheckRun,
  type BenchCheckTestSummary,
  type BenchRun,
  type BenchScenarioSummary,
  PlanStageSchema,
} from '@clio/protocol';
import { type Config, loadConfig } from '../src/config';
import { describeError } from '../src/log';
import {
  benchPlan,
  createBenchModels,
  judgeRun,
  restPlanRequest,
  scenarioPlanRequest,
} from '../src/services/bench';
import {
  criteriaTestRequest,
  expectLabel,
  falseDone,
  runCheckTest,
} from '../src/services/bench-checks';
import { createGeminiClient, isGeminiConfigured, type Thinking } from '../src/services/gemini';
import type { StageThinking } from '../src/services/gemini-planner';
import type { GeminiStepCheckerOptions } from '../src/services/gemini-step-check';
import { askStepCriteria } from '../src/services/step-check-service';
import { BenchCheckStore } from '../src/storage/bench-check-store';
import { BenchStore } from '../src/storage/bench-store';
import { ProcedureStore } from '../src/storage/procedure-store';

// `pnpm bench`: replays the planner bench's saved scenarios (docs/planner-bench.md) without the
// page, e.g. after changing the planner prompt, and with --checks its watcher tests, after
// changing the step check. Every run is saved with its scenario or test, so the page shows them
// too. No server needed; it reads .env like the server does.

const USAGE = `Usage: pnpm bench [scenario-id ...] [options]
       pnpm bench --checks [test-id ...] [--model <name> ...] [--repeat <n>] [check options]

Runs saved planner bench scenarios (data/bench/scenarios) and judges each plan against the
scenario's expectations. With --checks, runs the saved watcher tests (data/bench/checks) instead:
the step watcher's question on each saved look, graded against the answer it should give. With no
ids, runs them all.

Options:
  --model <name>        Plan (or check) with this model; repeat to compare several
                        (default: the planner model)
  --tag <tag>           Only scenarios with this tag; repeat for any of several
  --repeat <n>          Run each scenario or test n times per model, to see how steady it is
  --staged              Plan as the headset does: stage first (the first step and an outline),
                        then stage rest (the outline in full); judges the plan after both
  --thinking <s>=<lvl>  Thinking for a stage (full, first, rest): minimal, low, medium, high or
                        default (the model's own); repeat for several stages
  --judge-model <name>  Judge with this model (default: GEMINI_JUDGE_MODEL)
  --no-judge            Plan only
  --slow                Allow 2 minutes per plan instead of the headset's 40 s
  --checks              Run the watcher tests instead of the scenarios
  --thinking check=<l>  With --checks: thinking for the check, or criteria=<l> for the criteria
  --criteria <how>      With --checks: the criteria to judge. seen (the default, as the headset):
                        written first from the view at the start of the step; words: from the
                        step's words alone; inline: written in each answer; none: no criteria
  --quick               With --checks: ask as quick looks (minimal thinking), as the watcher
                        does while a step is far from done
  --parallel <n>        With --checks: ask n looks at a time (default 1)
  --list                List the scenarios (or watcher tests) and exit
  -h, --help            Show this help`;

const SLOW_BUDGET_MS = 120_000;
const LEVELS: readonly string[] = ['minimal', 'low', 'medium', 'high', 'default'];

interface Tally {
  runs: number;
  planned: number;
  judged: number;
  passed: number;
  met: number;
  criteria: number;
  /** Until the lesson can start: the whole plan, or stage first. */
  starts: number[];
  /** Until the plan is complete: the whole plan, or both stages. */
  times: number[];
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      model: { type: 'string', multiple: true },
      tag: { type: 'string', multiple: true },
      repeat: { type: 'string' },
      staged: { type: 'boolean' },
      thinking: { type: 'string', multiple: true },
      'judge-model': { type: 'string' },
      'no-judge': { type: 'boolean' },
      slow: { type: 'boolean' },
      checks: { type: 'boolean' },
      criteria: { type: 'string' },
      parallel: { type: 'string' },
      quick: { type: 'boolean' },
      list: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) return console.log(USAGE);

  const config = loadConfig();
  const benchDir = join(config.dataDir, 'bench');
  if (values.checks) {
    return runChecks(config, benchDir, positionals, {
      models: values.model ?? [],
      repeat: values.repeat,
      list: values.list ?? false,
      thinking: values.thinking ?? [],
      criteria: values.criteria,
      parallel: values.parallel,
      quick: values.quick ?? false,
    });
  }
  const store = new BenchStore(benchDir);
  const all = await store.list();
  const tags = values.tag ?? [];
  const scenarios = all.filter(
    (s) =>
      (positionals.length === 0 || positionals.includes(s.id)) &&
      (tags.length === 0 || s.tags.some((t) => tags.includes(t))),
  );
  const unknown = positionals.filter((id) => !all.some((s) => s.id === id));
  if (unknown.length) throw new Error(`No scenario ${unknown.map((id) => `"${id}"`).join(', ')}`);
  if (values.list) return listScenarios(scenarios);
  if (!scenarios.length) {
    return console.log('No scenarios to run. Save some on the bench page first (bench.html).');
  }
  if (!isGeminiConfigured(config.geminiApiKey)) throw new Error('Set GEMINI_API_KEY in .env');

  const models = createBenchModels(createGeminiClient(config.geminiApiKey), config);
  const plannerModels = values.model?.length ? values.model : [config.plannerModel];
  const repeat = Math.max(1, Number(values.repeat ?? 1) || 1);
  const staged = values.staged ?? false;
  const thinking = parseThinking(values.thinking ?? []);
  const judgeModel = values['judge-model'] ?? config.judgeModel;
  const judging = !values['no-judge'];
  const budgetMs = values.slow ? SLOW_BUDGET_MS : undefined;
  const plans = new ProcedureStore({
    curatedDir: config.proceduresDir,
    plansDir: join(benchDir, 'plans'),
  });
  const now = () => new Date();

  const total = scenarios.length * plannerModels.length * repeat;
  const thinks = Object.entries(thinking).map(([stage, level]) => `${stage} ${level ?? 'default'}`);
  console.log(
    `Planner bench: ${scenarios.length} scenario${scenarios.length === 1 ? '' : 's'} × ` +
      `${plannerModels.length} model${plannerModels.length === 1 ? '' : 's'} × ${repeat} = ` +
      `${total} run${total === 1 ? '' : 's'}${staged ? ', staged' : ''}` +
      `${thinks.length ? `, thinking ${thinks.join(', ')}` : ''}` +
      `${judging ? `, judged by ${judgeModel}` : ''}${budgetMs ? ', 2 minutes each' : ''}\n`,
  );
  const tallies = new Map<string, Tally>(
    plannerModels.map((m) => [
      m,
      { runs: 0, planned: 0, judged: 0, passed: 0, met: 0, criteria: 0, starts: [], times: [] },
    ]),
  );
  const width = Math.min(48, Math.max(...scenarios.map((s) => s.id.length)));

  for (const summary of scenarios) {
    const scenario = await store.getScenario(summary.id);
    if (!scenario) continue;
    const images = await store.readViews(scenario);
    for (const model of plannerModels) {
      for (let i = 0; i < repeat; i++) {
        const tally = tallies.get(model) as Tally;
        const planner = models.planner(model, { thinking });
        const body = scenarioPlanRequest(scenario, images, { staged });
        const first = await benchPlan({ planner, plans, now, budgetMs }, body);
        // The plan the learner ends up with: the first stage's, written out by stage rest.
        const rest = staged ? restPlanRequest(body, first) : null;
        let run = first;
        if (rest) {
          await store.addRun(scenario.id, first);
          run = withEarlierWarnings(
            first,
            await benchPlan({ planner, plans, now, budgetMs }, rest),
          );
        }
        let verdict = '';
        if (judging && run.result.ok && scenario.expect.length) {
          try {
            const judgement = await judgeRun(models.judge(judgeModel), scenario, run, images, now);
            run = { ...run, judgement };
            const met = judgement.criteria.filter((c) => c.met).length;
            verdict = `judge ${met}/${judgement.criteria.length} ${judgement.passed ? '✓' : '✗'}`;
            tally.judged++;
            tally.met += met;
            tally.criteria += judgement.criteria.length;
            if (judgement.passed) tally.passed++;
          } catch (error) {
            verdict = `judge failed: ${describeError(error)}`;
          }
        }
        await store.addRun(scenario.id, run);
        tally.runs++;
        tally.starts.push(first.latencyMs);
        tally.times.push(first.latencyMs + (rest ? run.latencyMs : 0));
        if (run.result.ok) tally.planned++;
        const time = rest
          ? `${seconds(first.latencyMs)} + ${seconds(run.latencyMs)} rest`
          : seconds(first.latencyMs);
        console.log(
          `  ${scenario.id.slice(0, width).padEnd(width)}  ${model.padEnd(24)} ` +
            `${time.padStart(7)}  ${describeRun(first, rest ? run : null)}` +
            `${verdict ? `  ${verdict}` : ''}`,
        );
      }
    }
  }

  console.log(
    '\nModel                     runs  planned  judged passed  criteria met  median start  median total',
  );
  for (const [model, t] of tallies) {
    const judged = judging ? `${t.passed}/${t.judged}`.padStart(13) : '            -';
    const met = judging ? `${t.met}/${t.criteria}`.padStart(14) : '             -';
    console.log(
      `${model.padEnd(24)}  ${String(t.runs).padStart(4)}  ${String(t.planned).padStart(7)}` +
        `${judged}${met}  ${seconds(median(t.starts)).padStart(12)}  ${seconds(median(t.times)).padStart(12)}`,
    );
  }
  console.log('\nRuns are saved with their scenarios; open bench.html to read the plans.');
}

/** "first=high" → { first: 'high' }; "default" leaves the model its own thinking. */
function parseThinking(args: readonly string[]): Partial<StageThinking> {
  const thinking: Partial<StageThinking> = {};
  for (const arg of args) {
    const [stage = '', level = ''] = arg.split('=');
    const parsed = PlanStageSchema.safeParse(stage);
    if (!parsed.success || !LEVELS.includes(level)) {
      throw new Error(`--thinking ${arg}: use <full|first|rest>=<${LEVELS.join('|')}>`);
    }
    thinking[parsed.data] = level === 'default' ? null : (level as Thinking);
  }
  return thinking;
}

/**
 * The coach heard the first stage's warnings with "Plan ready" and only new ones with "Plan
 * refined", so the plan the learner ends up with carries both.
 */
function withEarlierWarnings(first: BenchRun, rest: BenchRun): BenchRun {
  if (!first.result.ok || !rest.result.ok) return rest;
  const earlier = first.result.warnings;
  const later = rest.result.warnings.filter((w) => !earlier.includes(w));
  return { ...rest, result: { ...rest.result, warnings: [...earlier, ...later] } };
}

function describeRun(first: BenchRun, rest: BenchRun | null): string {
  const what = (run: BenchRun) =>
    run.result.ok
      ? `${run.result.procedure.steps.length} steps${run.attempts > 1 ? ' (retried)' : ''}`
      : `FAILED ${run.result.code}: ${run.result.message}`;
  if (!rest) return what(first);
  const outline = first.result.ok ? `, outline from ${first.result.outlineFrom}` : '';
  return `${what(first)}${outline}; rest ${what(rest)}`;
}

function listScenarios(scenarios: BenchScenarioSummary[]): void {
  if (!scenarios.length) console.log('No scenarios.');
  for (const s of scenarios) {
    const tags = s.tags.length ? ` [${s.tags.join(', ')}]` : '';
    console.log(`${s.id}${tags}\n  ${s.goal}\n  ${s.expectCount} expectations, ${s.runCount} runs`);
  }
}

interface CheckTally {
  runs: number;
  passed: number;
  failed: number;
  /** Said done when the test expected anything else. */
  falseDone: number;
  byExpect: Record<BenchCheckExpect, { runs: number; passed: number }>;
  times: number[];
  /** Asking for the criteria, once per test and repeat. */
  criteriaTimes: number[];
}

const EXPECTS: readonly BenchCheckExpect[] = ['done', 'not_done', 'wrong', 'unsure'];
/** seen, the headset's way: criteria from the step's start view, asked once per test and repeat. */
const CRITERIA_MODES = ['seen', 'words', 'inline', 'none'] as const;
type CriteriaMode = (typeof CRITERIA_MODES)[number];

interface CheckOptions {
  models: string[];
  repeat: string | undefined;
  list: boolean;
  /** check=<level> and criteria=<level>. */
  thinking: string[];
  criteria: string | undefined;
  parallel: string | undefined;
  quick: boolean;
}

/** `--thinking check=minimal --thinking criteria=low` for the watcher tests. */
function parseCheckThinking(args: readonly string[]): GeminiStepCheckerOptions {
  const options: GeminiStepCheckerOptions = {};
  for (const arg of args) {
    const [what = '', level = ''] = arg.split('=');
    if (!['check', 'criteria'].includes(what) || !LEVELS.includes(level)) {
      throw new Error(`--thinking ${arg}: use <check|criteria>=<${LEVELS.join('|')}>`);
    }
    const thinking = level === 'default' ? null : (level as Thinking);
    if (what === 'check') options.thinking = thinking;
    else options.criteriaThinking = thinking;
  }
  return options;
}

/** How a run was asked, for its `variant`: empty when the way the headset's careful look is. */
function checkVariant(
  options: GeminiStepCheckerOptions,
  criteria: CriteriaMode,
  quick: boolean,
): string {
  const parts: string[] = quick ? ['quick'] : [];
  if (options.thinking !== undefined) parts.push(`thinking ${options.thinking ?? 'default'}`);
  if (criteria === 'none') parts.push('no criteria');
  else if (criteria !== 'seen') parts.push(`criteria ${criteria}`);
  if ((criteria === 'seen' || criteria === 'words') && options.criteriaThinking !== undefined) {
    parts.push(`criteria thinking ${options.criteriaThinking ?? 'default'}`);
  }
  return parts.join(', ');
}

/** `pnpm bench --checks`: every watcher test with every model, then a pass rate per model. */
async function runChecks(
  config: Config,
  benchDir: string,
  ids: string[],
  options: CheckOptions,
): Promise<void> {
  const store = new BenchCheckStore(benchDir);
  const all = await store.list();
  const tests = all.filter((t) => ids.length === 0 || ids.includes(t.id));
  const unknown = ids.filter((id) => !all.some((t) => t.id === id));
  if (unknown.length)
    throw new Error(`No watcher test ${unknown.map((id) => `"${id}"`).join(', ')}`);
  if (options.list) return listChecks(tests);
  if (!tests.length) {
    return console.log(
      'No watcher tests to run. Save some from the live watch log on the bench page first.',
    );
  }
  if (!isGeminiConfigured(config.geminiApiKey)) throw new Error('Set GEMINI_API_KEY in .env');
  const criteria = options.criteria ?? 'seen';
  if (!CRITERIA_MODES.includes(criteria as CriteriaMode)) {
    throw new Error(`--criteria ${criteria}: use ${CRITERIA_MODES.join(', ')}`);
  }
  const mode = criteria as CriteriaMode;
  const checkerOptions: GeminiStepCheckerOptions = {
    ...parseCheckThinking(options.thinking),
    ...(mode === 'inline' ? { inline: true } : {}),
  };
  const variant = checkVariant(checkerOptions, mode, options.quick);

  const models = createBenchModels(createGeminiClient(config.geminiApiKey), config);
  const checkModels = options.models.length ? options.models : [config.plannerModel];
  const repeat = Math.max(1, Number(options.repeat ?? 1) || 1);
  const parallel = Math.max(1, Number(options.parallel ?? 1) || 1);
  const now = () => new Date();
  const total = tests.length * checkModels.length * repeat;
  console.log(
    `Watcher tests: ${tests.length} test${tests.length === 1 ? '' : 's'} × ` +
      `${checkModels.length} model${checkModels.length === 1 ? '' : 's'} × ${repeat} = ` +
      `${total} look${total === 1 ? '' : 's'}${variant ? `, ${variant}` : ''}` +
      `${parallel > 1 ? `, ${parallel} at a time` : ''}\n`,
  );
  const tallies = new Map<string, CheckTally>(
    checkModels.map((m) => [
      m,
      {
        runs: 0,
        passed: 0,
        failed: 0,
        falseDone: 0,
        byExpect: {
          done: { runs: 0, passed: 0 },
          not_done: { runs: 0, passed: 0 },
          wrong: { runs: 0, passed: 0 },
          unsure: { runs: 0, passed: 0 },
        },
        times: [],
        criteriaTimes: [],
      },
    ]),
  );
  const width = Math.min(40, Math.max(...tests.map((t) => t.id.length)));

  const jobs: Array<() => Promise<void>> = [];
  for (const summary of tests) {
    for (const model of checkModels) {
      for (let i = 0; i < repeat; i++) {
        jobs.push(async () => {
          const test = await store.getTest(summary.id);
          if (!test) return;
          const frames = await store.readFrames(test);
          const tally = tallies.get(model) as CheckTally;
          const checker = models.checker(model, checkerOptions);
          // The headset asks once when the step gains focus; each repeat asks again.
          let given: string[] = [];
          if (mode === 'seen' || mode === 'words') {
            try {
              const request = criteriaTestRequest(test, frames, { seen: mode === 'seen' });
              const asked = await askStepCriteria(checker, request, now);
              given = asked.criteria;
              tally.criteriaTimes.push(asked.latencyMs);
            } catch (error) {
              console.log(`  ${test.id}: no criteria (${describeError(error)})`);
            }
          }
          const run = await runCheckTest({ checker, now }, test, frames, {
            criteria: given,
            quick: options.quick,
            ...(variant ? { variant } : {}),
          });
          await store.addRun(test.id, run);
          tally.runs++;
          tally.times.push(run.latencyMs);
          tally.byExpect[run.expect].runs++;
          if (run.passed) {
            tally.passed++;
            tally.byExpect[run.expect].passed++;
          }
          if (!run.result.ok) tally.failed++;
          else if (falseDone(run.expect, run.result.answer)) tally.falseDone++;
          console.log(
            `  ${test.id.slice(0, width).padEnd(width)}  ${model.padEnd(28)} ` +
              `${seconds(run.latencyMs).padStart(7)}  expects ${expectLabel(run.expect).padEnd(8)}  ` +
              `${checkAnswer(run)}  ${run.passed ? '✓' : '✗'}`,
          );
        });
      }
    }
  }
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(parallel, jobs.length) }, async () => {
      while (next < jobs.length) await jobs[next++]?.();
    }),
  );

  console.log(
    '\nModel                         looks  passed   rate   done  not done  wrong  unsure  ' +
      'false done  median    p90',
  );
  for (const [model, t] of tallies) {
    const rate = t.runs ? `${Math.round((100 * t.passed) / t.runs)}%` : '-';
    const by = EXPECTS.map((e) => {
      const x = t.byExpect[e];
      return x.runs ? `${x.passed}/${x.runs}` : '-';
    });
    console.log(
      `${model.padEnd(28)}  ${String(t.runs).padStart(5)}  ${String(t.passed).padStart(6)}  ` +
        `${rate.padStart(5)}  ${(by[0] ?? '').padStart(5)}  ${(by[1] ?? '').padStart(8)}  ` +
        `${(by[2] ?? '').padStart(5)}  ${(by[3] ?? '').padStart(6)}  ` +
        `${String(t.falseDone).padStart(10)}  ${seconds(median(t.times)).padStart(6)}  ` +
        `${seconds(quantile(t.times, 0.9)).padStart(6)}${t.failed ? `  (${t.failed} failed calls)` : ''}`,
    );
    if (t.criteriaTimes.length) {
      console.log(
        `${''.padEnd(28)}  criteria asked ${t.criteriaTimes.length} times, median ` +
          `${seconds(median(t.criteriaTimes))}, p90 ${seconds(quantile(t.criteriaTimes, 0.9))}`,
      );
    }
  }
  console.log('\nRuns are saved with their tests; open bench.html to see the frames.');
}

function checkAnswer(run: BenchCheckRun): string {
  if (!run.result.ok) return `FAILED ${run.result.code}: ${run.result.message}`;
  const { verdict, observation, wrong } = run.result.answer;
  const said = verdict === 'not_done' ? 'not done' : verdict;
  return `said ${said}${wrong ? `, wrong: ${wrong}` : ''} “${observation}”`;
}

function listChecks(tests: BenchCheckTestSummary[]): void {
  if (!tests.length) console.log('No watcher tests.');
  for (const t of tests) {
    const tallies = t.models.map((m) => `${m.model} ${m.passed}/${m.runs}`).join(', ');
    console.log(
      `${t.id}  (expects ${expectLabel(t.expect)})\n  ${t.instruction}\n  ` +
        `${t.runCount} runs${tallies ? `: ${tallies}` : ''}`,
    );
  }
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/** The value below which `q` of them fall, nearest rank. */
function quantile(values: number[], q: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? 0;
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

main().catch((error: unknown) => {
  console.error(describeError(error));
  process.exit(1);
});

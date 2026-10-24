import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { type BenchRun, type BenchScenarioSummary, PlanStageSchema } from '@clio/protocol';
import { loadConfig } from '../src/config';
import { describeError } from '../src/log';
import {
  benchPlan,
  createBenchModels,
  judgeRun,
  restPlanRequest,
  scenarioPlanRequest,
} from '../src/services/bench';
import { createGeminiClient, isGeminiConfigured, type Thinking } from '../src/services/gemini';
import type { StageThinking } from '../src/services/gemini-planner';
import { BenchStore } from '../src/storage/bench-store';
import { ProcedureStore } from '../src/storage/procedure-store';

// `pnpm bench`: replays the planner bench's saved scenarios (docs/planner-bench.md) without the
// page, e.g. after changing the planner prompt. Every run and judgement is saved with its
// scenario, so the page shows them too. No server needed; it reads .env like the server does.

const USAGE = `Usage: pnpm bench [scenario-id ...] [options]

Runs saved planner bench scenarios (data/bench/scenarios) and judges each plan against the
scenario's expectations. With no ids, runs them all.

Options:
  --model <name>        Plan with this model; repeat to compare several (default: the planner model)
  --tag <tag>           Only scenarios with this tag; repeat for any of several
  --repeat <n>          Run each scenario n times per model, to see how steady the answers are
  --staged              Plan as the headset does: stage first (the first step and an outline),
                        then stage rest (the outline in full); judges the plan after both
  --thinking <s>=<lvl>  Thinking for a stage (full, first, rest): minimal, low, medium, high or
                        default (the model's own); repeat for several stages
  --judge-model <name>  Judge with this model (default: GEMINI_JUDGE_MODEL)
  --no-judge            Plan only
  --slow                Allow 2 minutes per plan instead of the headset's 40 s
  --list                List the scenarios and exit
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
      list: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) return console.log(USAGE);

  const config = loadConfig();
  const benchDir = join(config.dataDir, 'bench');
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

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

main().catch((error: unknown) => {
  console.error(describeError(error));
  process.exit(1);
});

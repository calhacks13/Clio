import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { BenchRun, BenchScenarioSummary } from '@clio/protocol';
import { loadConfig } from '../src/config';
import { describeError } from '../src/log';
import { benchPlan, createBenchModels, judgeRun, scenarioPlanRequest } from '../src/services/bench';
import { createGeminiClient, isGeminiConfigured } from '../src/services/gemini';
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
  --judge-model <name>  Judge with this model (default: GEMINI_JUDGE_MODEL)
  --no-judge            Plan only
  --slow                Allow 2 minutes per plan instead of the headset's 40 s
  --list                List the scenarios and exit
  -h, --help            Show this help`;

const SLOW_BUDGET_MS = 120_000;

interface Tally {
  runs: number;
  planned: number;
  judged: number;
  passed: number;
  times: number[];
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      model: { type: 'string', multiple: true },
      tag: { type: 'string', multiple: true },
      repeat: { type: 'string' },
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
  const judgeModel = values['judge-model'] ?? config.judgeModel;
  const judging = !values['no-judge'];
  const budgetMs = values.slow ? SLOW_BUDGET_MS : undefined;
  const plans = new ProcedureStore({
    curatedDir: config.proceduresDir,
    plansDir: join(benchDir, 'plans'),
  });
  const now = () => new Date();

  const total = scenarios.length * plannerModels.length * repeat;
  console.log(
    `Planner bench: ${scenarios.length} scenario${scenarios.length === 1 ? '' : 's'} × ` +
      `${plannerModels.length} model${plannerModels.length === 1 ? '' : 's'} × ${repeat} = ` +
      `${total} run${total === 1 ? '' : 's'}${judging ? `, judged by ${judgeModel}` : ''}` +
      `${budgetMs ? ', 2 minutes each' : ''}\n`,
  );
  const tallies = new Map<string, Tally>(
    plannerModels.map((m) => [m, { runs: 0, planned: 0, judged: 0, passed: 0, times: [] }]),
  );
  const width = Math.min(48, Math.max(...scenarios.map((s) => s.id.length)));

  for (const summary of scenarios) {
    const scenario = await store.getScenario(summary.id);
    if (!scenario) continue;
    const images = await store.readViews(scenario);
    for (const model of plannerModels) {
      for (let i = 0; i < repeat; i++) {
        const tally = tallies.get(model) as Tally;
        let run: BenchRun = await benchPlan(
          { planner: models.planner(model), plans, now, budgetMs },
          scenarioPlanRequest(scenario, images),
        );
        let verdict = '';
        if (judging && run.result.ok && scenario.expect.length) {
          try {
            const judgement = await judgeRun(models.judge(judgeModel), scenario, run, images, now);
            run = { ...run, judgement };
            const met = judgement.criteria.filter((c) => c.met).length;
            verdict = `judge ${met}/${judgement.criteria.length} ${judgement.passed ? '✓' : '✗'}`;
            tally.judged++;
            if (judgement.passed) tally.passed++;
          } catch (error) {
            verdict = `judge failed: ${describeError(error)}`;
          }
        }
        await store.addRun(scenario.id, run);
        tally.runs++;
        tally.times.push(run.latencyMs);
        if (run.result.ok) tally.planned++;
        const what = run.result.ok
          ? `${run.result.procedure.steps.length} steps${run.attempts > 1 ? ' (retried)' : ''}`
          : `FAILED ${run.result.code}: ${run.result.message}`;
        console.log(
          `  ${scenario.id.slice(0, width).padEnd(width)}  ${model.padEnd(24)} ` +
            `${seconds(run.latencyMs).padStart(7)}  ${what}${verdict ? `  ${verdict}` : ''}`,
        );
      }
    }
  }

  console.log('\nModel                     runs  planned  judged passed  median time');
  for (const [model, t] of tallies) {
    const judged = judging ? `${t.passed}/${t.judged}`.padStart(13) : '            -';
    console.log(
      `${model.padEnd(24)}  ${String(t.runs).padStart(4)}  ${String(t.planned).padStart(7)}` +
        `${judged}  ${seconds(median(t.times)).padStart(11)}`,
    );
  }
  console.log('\nRuns are saved with their scenarios; open bench.html to read the plans.');
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

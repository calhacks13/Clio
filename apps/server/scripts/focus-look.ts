// Asks the action focus (POST /api/vision/focus's service) about saved bench scenarios: one view,
// the goal, a step of the scenario's newest saved plan and its objects, the step's show items
// first, as the headset sends them. Prints how long each look took, what it found, its words for
// each object beside the plan's, and the action item. Saves nothing unless --out names a folder
// for the answers. A measuring tool for docs/robotics-er.md, not part of the app. Run from
// apps/server:
//   npx tsx --env-file-if-exists=../../.env scripts/focus-look.ts [scenario-id ...] [options]
// With no ids it looks at every scenario in data/bench/scenarios (CLIO_DATA_DIR moves data/).

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { FocusObject, FocusRequest, Procedure } from '@clio/protocol';
import { loadConfig } from '../src/config';
import { createGeminiClient, isGeminiConfigured } from '../src/services/gemini';
import { createGeminiFocusFinder } from '../src/services/gemini-focus';
import { BenchStore } from '../src/storage/bench-store';

const USAGE = `Usage: npx tsx --env-file-if-exists=../../.env scripts/focus-look.ts [scenario-id ...] [options]

Options:
  --step <n>      Which step of the saved plan, from 1 (default 1)
  --view <n>      Which view, from 1 (default 1)
  --repeat <n>    Looks per scenario (default 1)
  --model <name>  The model (default: the vision model)
  --omit <id>     Leave this object out of the request, to see the focus name it on its own
  --out <dir>     Save each request's step and objects and each answer there as JSON
  -h, --help      Show this help`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    step: { type: 'string' },
    view: { type: 'string' },
    repeat: { type: 'string' },
    model: { type: 'string' },
    omit: { type: 'string', multiple: true },
    out: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});
if (values.help) {
  console.log(USAGE);
  process.exit(0);
}
const config = loadConfig();
const stepIndex = Math.max(1, Number(values.step ?? 1) || 1) - 1;
const viewIndex = Math.max(1, Number(values.view ?? 1) || 1) - 1;
const repeat = Math.max(1, Number(values.repeat ?? 1) || 1);
const model = values.model ?? config.visionModel;
const store = new BenchStore(join(config.dataDir, 'bench'));
const all = await store.list();
const ids = positionals.length ? positionals : all.map((s) => s.id);
if (!isGeminiConfigured(config.geminiApiKey)) throw new Error('Set GEMINI_API_KEY in .env');
const finder = createGeminiFocusFinder(createGeminiClient(config.geminiApiKey), model);

console.log(`Action focus on ${model}, step ${stepIndex + 1}, view ${viewIndex + 1}\n`);
const latencies: number[] = [];
for (const id of ids) {
  const detail = await store.get(id);
  if (!detail) throw new Error(`No scenario "${id}"`);
  const plan = newestPlan(detail.runs, stepIndex);
  const step = plan?.steps[stepIndex];
  if (!plan || !step) {
    console.log(`${id}: no saved plan has a step ${stepIndex + 1}\n`);
    continue;
  }
  const image = (await store.readViews(detail.scenario))[viewIndex];
  if (!image) throw new Error(`${id} has no view ${viewIndex + 1}`);
  const request: FocusRequest = {
    image,
    goal: detail.scenario.goal,
    step: { instruction: step.instruction, ...(step.doneWhen ? { doneWhen: step.doneWhen } : {}) },
    objects: focusObjects(plan, stepIndex).filter((o) => !values.omit?.includes(o.id)),
  };
  console.log(`== ${id}\n  step: ${step.instruction} (done when: ${step.doneWhen ?? '-'})`);
  for (let i = 0; i < repeat; i++) {
    const t0 = performance.now();
    const answer = await finder.focus(request);
    const ms = Math.round(performance.now() - t0);
    latencies.push(ms);
    console.log(`  look ${i + 1}: ${(ms / 1000).toFixed(1)} s`);
    for (const [n, d] of answer.detections.entries()) {
      const asked = request.objects[n];
      console.log(
        `  - ${d.id}: ${d.found ? `found ${d.confidence.toFixed(2)} box ${fmt(d.box)}` : 'not found'}` +
          `\n      plan: ${asked?.phrase ? `"${asked.phrase}" ` : ''}${asked?.query}` +
          (d.description ? `\n      er:   ${d.description}` : ''),
      );
    }
    const a = answer.action;
    console.log(
      a
        ? `  action: ${a.id ?? `(new) ${a.label}, "${a.phrase}"`} ${a.found ? `box ${fmt(a.box)}` : 'not found'}` +
            (a.id ? '' : `\n      ${a.description}`)
        : '  action: none',
    );
    if (values.out) {
      const { image: _, ...asked } = request;
      await writeFile(
        join(values.out, `${id}-step${stepIndex + 1}-${i + 1}.json`),
        JSON.stringify({ id, view: viewIndex + 1, ms, request: asked, answer }, null, 2),
      );
    }
  }
  console.log('');
}
if (latencies.length) {
  const sorted = [...latencies].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  console.log(
    `${latencies.length} looks: median ${(median / 1000).toFixed(1)} s, ` +
      `${((sorted[0] ?? 0) / 1000).toFixed(1)} to ${((sorted.at(-1) ?? 0) / 1000).toFixed(1)} s`,
  );
}

/** The newest saved plan with that step written out (stage rest's plans have every step). */
function newestPlan(runs: { result: unknown }[], index: number): Procedure | null {
  for (const run of runs) {
    const result = run.result as { ok?: boolean; procedure?: Procedure };
    const step = result.ok ? result.procedure?.steps[index] : undefined;
    if (step && (index === 0 || step.show.length)) return result.procedure ?? null;
  }
  return null;
}

/** The step's show items first, in rank order, then the plan's other objects, at most 8. */
function focusObjects(plan: Procedure, index: number): FocusObject[] {
  const step = plan.steps[index];
  const shown: FocusObject[] = (step?.show ?? []).map((item) => ({
    id: item.object,
    label: plan.objects.find((o) => o.id === item.object)?.label ?? item.object,
    phrase: item.phrase,
    query: item.description,
  }));
  const rest = plan.objects
    .filter((o) => !shown.some((s) => s.id === o.id))
    .map((o) => ({
      id: o.id,
      label: o.label,
      query: o.tracking?.query ?? o.description ?? o.label,
    }));
  return [...shown, ...rest].slice(0, 8);
}

function fmt(box: readonly number[] | null): string {
  return box ? `[${box.map((v) => v.toFixed(2)).join(', ')}]` : '-';
}

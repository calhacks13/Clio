// Times the planner's first stage on the saved bench scenarios, streamed: how long the model
// thinks before its first output, when the first step starts, and when it is done, with token
// counts and how the answer's characters split between its fields. It asks what the planner asks
// for stage first (prompt, schema, thinking), streamed, and saves nothing. A measuring tool for
// docs/handoff-stage1-speed.md, not part of the app. Run from apps/server:
//   npx tsx --env-file-if-exists=../../.env scripts/stage1-timing.ts [scenario-id ...] [options]
// With no ids it times every scenario in data/bench/scenarios (CLIO_DATA_DIR moves data/).

import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { GoogleGenAI } from '@google/genai';
import { loadConfig } from '../src/config';
import { isGeminiConfigured, type Thinking, thinkingConfig } from '../src/services/gemini';
import { PLAN_THINKING } from '../src/services/gemini-planner';
import { PLANNER_SYSTEM_INSTRUCTION, plannerContents } from '../src/services/plan-prompt';
import { buildPlanJsonSchema } from '../src/services/plan-schema';
import { BenchStore } from '../src/storage/bench-store';

const USAGE = `Usage: npx tsx --env-file-if-exists=../../.env scripts/stage1-timing.ts [scenario-id ...] [options]

Options:
  --thinking <level>  minimal, low, medium or high (default: PLAN_THINKING.first)
  --repeat <n>        Runs per scenario (default 3)
  --model <name>      The model (default: the planner model)
  -h, --help          Show this help`;

const LEVELS: readonly string[] = ['minimal', 'low', 'medium', 'high'];

interface Timing {
  /** Until the first answer text: the model's thinking, plus the request's round trip. */
  thinks: number;
  /** Until `"firstStep"` appears in the answer, or null if it never does. */
  firstStep: number | null;
  done: number;
  output: number;
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    thinking: { type: 'string' },
    repeat: { type: 'string' },
    model: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});
if (values.help) {
  console.log(USAGE);
  process.exit(0);
}
const config = loadConfig();
const level = values.thinking ?? PLAN_THINKING.first ?? 'low';
if (!LEVELS.includes(level)) throw new Error(`--thinking ${level}: use ${LEVELS.join(', ')}`);
const model = values.model ?? config.plannerModel;
const repeat = Math.max(1, Number(values.repeat ?? 3) || 1);
const store = new BenchStore(join(config.dataDir, 'bench'));
const all = await store.list();
const ids = positionals.length ? positionals : all.map((s) => s.id);
const unknown = ids.filter((id) => !all.some((s) => s.id === id));
if (unknown.length) throw new Error(`No scenario ${unknown.map((id) => `"${id}"`).join(', ')}`);
if (!ids.length) {
  console.log('No scenarios to time. Save some on the bench page first (bench.html).');
  process.exit(0);
}
if (!isGeminiConfigured(config.geminiApiKey)) throw new Error('Set GEMINI_API_KEY in .env');
const ai = new GoogleGenAI({ apiKey: config.geminiApiKey, vertexai: false });

console.log(`Stage first on ${model}, thinking ${level}, ${repeat} runs per scenario\n`);
for (const id of ids) {
  const scenario = await store.getScenario(id);
  if (!scenario) continue;
  const images = await store.readViews(scenario);
  const request = {
    goal: scenario.goal,
    ...(scenario.context ? { context: scenario.context } : {}),
    images,
    stage: 'first' as const,
  };
  const timings: Timing[] = [];
  for (let i = 0; i < repeat; i++) {
    const t0 = performance.now();
    let thinks = 0;
    let firstStep: number | null = null;
    let text = '';
    let usage:
      | { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number }
      | undefined;
    const stream = await ai.models.generateContentStream({
      model,
      contents: plannerContents(request),
      config: {
        systemInstruction: PLANNER_SYSTEM_INSTRUCTION,
        responseMimeType: 'application/json',
        responseJsonSchema: buildPlanJsonSchema('first'),
        ...thinkingConfig(model, level as Thinking),
      },
    });
    for await (const chunk of stream) {
      const piece = chunk.text ?? '';
      if (piece && !thinks) thinks = performance.now() - t0;
      text += piece;
      if (firstStep === null && text.includes('"firstStep"')) firstStep = performance.now() - t0;
      if (chunk.usageMetadata) usage = chunk.usageMetadata;
    }
    const done = performance.now() - t0;
    const answer = JSON.parse(text) as Record<string, unknown>;
    const count = (k: string) => (Array.isArray(answer[k]) ? answer[k].length : 0);
    timings.push({ thinks, firstStep, done, output: usage?.candidatesTokenCount ?? 0 });
    console.log(
      `${id.slice(0, 32).padEnd(32)} run ${i + 1}: thinks ${seconds(thinks)}, ` +
        `first step starts ${firstStep === null ? '-' : seconds(firstStep)}, done ${seconds(done)}` +
        ` | tokens in ${usage?.promptTokenCount} out ${usage?.candidatesTokenCount} thoughts ` +
        `${usage?.thoughtsTokenCount ?? 0} | ${count('objects')} objects, ${count('outline')} ` +
        `outline lines | ${text.length} chars: ${shares(text, Object.keys(answer))}`,
    );
  }
  const range = (pick: (t: Timing) => number | null, format: (n: number) => string) => {
    const xs = timings.map(pick).filter((n): n is number => n !== null);
    return xs.length ? `${format(Math.min(...xs))} to ${format(Math.max(...xs))}` : '-';
  };
  console.log(
    `  thinks ${range((t) => t.thinks, seconds)}, first step starts ` +
      `${range((t) => t.firstStep, seconds)}, done ${range((t) => t.done, seconds)}, ` +
      `output tokens ${range((t) => t.output, String)}\n`,
  );
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

/** Each top-level field's share of the answer's characters, in the order it was written. */
function shares(text: string, keys: string[]): string {
  const at: number[] = [];
  for (const k of keys) at.push(text.indexOf(`"${k}"`, (at.at(-1) ?? -1) + 1));
  return keys
    .map((k, i) => {
      const end = at[i + 1] ?? text.length;
      const start = at[i] ?? 0;
      return `${k} ${Math.round(((end - start) / text.length) * 100)}%`;
    })
    .join(', ');
}

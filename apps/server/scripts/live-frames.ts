// Asks the coach's Live model detail questions about one camera frame, sent the way the headset
// sends it (realtime video), at a media resolution: how many tokens the frame cost, how long each
// answer took and what it said, graded against the expected words. --frames sends the frame more
// times first, a second apart (Live keeps about one frame a second), to see whether a fuller
// context slows the answers. Prints a summary per run and
// saves nothing. A measuring tool for docs/coach-plan.md, not part of the app. Run from
// apps/server:
//   npx tsx --env-file-if-exists=../../.env scripts/live-frames.ts <frame.jpg ...> [options]
// The questions fit the bench's fridge scene (data/bench/scenarios/fridge-yogurt-drink-beside-the-
// milk); scale its views first to the width the headset would send.

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import {
  GoogleGenAI,
  type LiveServerMessage,
  MediaResolution,
  Modality,
  type Session,
  ThinkingLevel,
} from '@google/genai';
import { loadConfig } from '../src/config';

const USAGE = `Usage: npx tsx --env-file-if-exists=../../.env scripts/live-frames.ts <frame.jpg ...> [options]

Options:
  --resolution <r>  low, medium or high (default low, the coach's until October 2026)
  --repeat <n>      Sessions per frame (default 2)
  --frames <n>      Times the frame is sent before the questions, 1 s apart (default 1)
  --model <name>    The Live model (default: the coach's)
  -h, --help        Show this help`;

const RESOLUTIONS: Record<string, MediaResolution> = {
  low: MediaResolution.MEDIA_RESOLUTION_LOW,
  medium: MediaResolution.MEDIA_RESOLUTION_MEDIUM,
  high: MediaResolution.MEDIA_RESOLUTION_HIGH,
};

/** Each question, and the words a right answer contains (any one of a list). */
const QUESTIONS: { q: string; expect: RegExp[] }[] = [
  { q: 'What word is printed on the bottle with the blue cap?', expect: [/milk/i] },
  { q: 'What fruit is pictured on the bottle with the pink cap?', expect: [/strawberr/i] },
  {
    q: 'What pattern is on the lid of the small jar behind the bottles?',
    expect: [/check|gingham|plaid/i],
  },
  { q: 'What is lying in the open wrapper on the left of the shelf?', expect: [/butter/i] },
  {
    q: 'Name the two sauces standing in the middle shelf of the door.',
    expect: [/ketchup/i, /mustard/i],
  },
  { q: 'Name the vegetables in the bottom drawer.', expect: [/carrot/i, /lettuce|cabbage/i] },
  { q: 'Is there a knife anywhere in view? Answer yes or no first.', expect: [/^\W*no\b/i] },
  // Small details, visible in view 1 only.
  { q: 'What colour is the cap of the ketchup bottle?', expect: [/white/i] },
  {
    q: 'What colour is the lid of the jar partly hidden behind the milk bottle?',
    expect: [/gold|yellow|brass|metal/i],
  },
  {
    q: 'What colour is the cap of the tall glass bottle just right of the mustard?',
    expect: [/black|dark/i],
  },
  { q: 'What colours are the eggs in the carton?', expect: [/brown/i, /white/i] },
  { q: 'What stands on the counter at the far left, outside the fridge?', expect: [/bottle/i] },
];

const SYSTEM =
  'You see the camera of a headset the learner wears. Answer each question about what you see ' +
  'in one short sentence. If you cannot tell, say so.';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    resolution: { type: 'string' },
    repeat: { type: 'string' },
    frames: { type: 'string' },
    model: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});
if (values.help || positionals.length === 0) {
  console.log(USAGE);
  process.exit(values.help ? 0 : 1);
}
const config = loadConfig();
const resolution = RESOLUTIONS[values.resolution ?? 'low'];
if (!resolution) throw new Error(`--resolution ${values.resolution}: use low, medium or high`);
const repeat = Math.max(1, Number(values.repeat ?? 2) || 1);
const frames = Math.max(1, Number(values.frames ?? 1) || 1);
const model = values.model ?? config.liveModel;
const thinking = /(^|[-/])extended-thinking($|-)/.test(model);
if (!config.geminiApiKey) throw new Error('GEMINI_API_KEY is not set');
const ai = new GoogleGenAI({ apiKey: config.geminiApiKey });

interface Answer {
  text: string;
  ms: number;
  right: boolean;
}

interface Run {
  /** The media and the whole prompt in tokens, as the first answer's usage counts them. */
  mediaTokens: number | null;
  promptTokens: number | null;
  answers: Answer[];
}

/** One session: the frame, then each question as its own turn. */
async function run(jpeg: string): Promise<Run> {
  let onTurn: (() => void) | null = null;
  let text = '';
  let firstAt = 0;
  let mediaTokens: number | null = null;
  let promptTokens: number | null = null;
  const session: Session = await ai.live.connect({
    model,
    config: {
      responseModalities: [Modality.AUDIO],
      systemInstruction: SYSTEM,
      outputAudioTranscription: {},
      mediaResolution: resolution,
      ...(thinking ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } } : {}),
    },
    callbacks: {
      onmessage: (msg: LiveServerMessage) => {
        const said = msg.serverContent?.outputTranscription?.text;
        if (said) {
          if (!text) firstAt = performance.now();
          text += said;
        }
        const usage = msg.usageMetadata;
        const media = (usage?.promptTokensDetails ?? [])
          .filter((d) => d.modality === 'IMAGE' || d.modality === 'VIDEO')
          .reduce((sum, d) => sum + (d.tokenCount ?? 0), 0);
        if (media && mediaTokens === null) {
          mediaTokens = media;
          promptTokens = usage?.promptTokenCount ?? null;
        }
        if (msg.serverContent?.turnComplete) onTurn?.();
      },
      onerror: (e: ErrorEvent) => console.error(`socket error: ${e.message}`),
      onclose: (e: CloseEvent) => {
        if (e.code !== 1000) console.error(`closed (${e.code} ${e.reason})`);
        onTurn?.();
      },
    },
  });
  for (let i = 0; i < frames; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 1000));
    session.sendRealtimeInput({ video: { data: jpeg, mimeType: 'image/jpeg' } });
  }
  await new Promise((r) => setTimeout(r, 1000));
  const answers: Answer[] = [];
  for (const { q, expect } of QUESTIONS) {
    text = '';
    const sent = performance.now();
    const done = new Promise<void>((resolve) => {
      onTurn = resolve;
    });
    session.sendClientContent({ turns: [{ role: 'user', parts: [{ text: q }] }] });
    await Promise.race([done, new Promise((r) => setTimeout(r, 20_000))]);
    const said = text.trim();
    answers.push({
      text: said,
      ms: Math.round((firstAt || performance.now()) - sent),
      right: expect.every((re) => re.test(said)),
    });
  }
  session.close();
  return { mediaTokens, promptTokens, answers };
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : Number.NaN;
};

for (const file of positionals) {
  const jpeg = (await readFile(file)).toString('base64');
  for (let i = 0; i < repeat; i++) {
    const { mediaTokens, promptTokens, answers } = await run(jpeg);
    const right = answers.filter((a) => a.right).length;
    console.log(
      `${basename(file)} ${values.resolution ?? 'low'} run ${i + 1}: ${right}/${answers.length} ` +
        `right, ${frames} frame(s) ${mediaTokens ?? '?'} tokens of ${promptTokens ?? '?'}, ` +
        `first words after ${median(answers.map((a) => a.ms))} ms (median)`,
    );
    for (const [j, a] of answers.entries()) {
      console.log(
        `  ${a.right ? 'ok  ' : 'MISS'} ${QUESTIONS[j]?.q}\n       ${a.text || '(nothing)'}`,
      );
    }
  }
}

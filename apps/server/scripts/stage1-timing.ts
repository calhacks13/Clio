// Times the planner's first stage on the saved bench scenarios, streamed: how long the model
// thinks before its first output, when the first step starts, and when it is done, with token
// counts. A measuring tool for docs/handoff-stage1-speed.md, not part of the app.
// Run from apps/server: npx tsx --env-file=../../.env scripts/stage1-timing.ts [minimal|low|medium]

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GoogleGenAI } from '@google/genai';
import { REPO_ROOT } from '../src/config';
import { thinkingConfig } from '../src/services/gemini';
import { PLANNER_SYSTEM_INSTRUCTION, plannerContents } from '../src/services/plan-prompt';
import { buildPlanJsonSchema } from '../src/services/plan-schema';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY ?? '' });
const MODEL = 'gemini-robotics-er-2-preview';
async function scene(id: string) {
  const dir = join(REPO_ROOT, 'data/bench/scenarios', id);
  const s = JSON.parse(await readFile(`${dir}/scenario.json`, 'utf8'));
  const images = [];
  for (const v of s.views)
    images.push({
      mimeType: v.mimeType,
      data: (await readFile(`${dir}/${v.file}`)).toString('base64'),
    });
  return { goal: s.goal as string, context: s.context as string | undefined, images };
}
const scenes = [
  'ph-lesson-cup-a-already-pink-knife-on-the-table',
  'fridge-yogurt-drink-beside-the-milk',
];
const LEVEL = (process.argv[2] ?? 'low') as 'low' | 'minimal' | 'medium';
for (const id of scenes) {
  const sc = await scene(id);
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    let first = 0,
      firstStepAt = 0,
      text = '',
      usage: any;
    const stream = await ai.models.generateContentStream({
      model: MODEL,
      contents: plannerContents({ ...sc, stage: 'first' } as never),
      config: {
        systemInstruction: PLANNER_SYSTEM_INSTRUCTION,
        responseMimeType: 'application/json',
        responseJsonSchema: buildPlanJsonSchema('first'),
        ...thinkingConfig(MODEL, LEVEL),
      },
    });
    for await (const chunk of stream) {
      const piece = chunk.text ?? '';
      if (piece && !first) first = performance.now() - t0;
      text += piece;
      if (!firstStepAt && text.includes('"firstStep"')) firstStepAt = performance.now() - t0;
      if (chunk.usageMetadata) usage = chunk.usageMetadata;
    }
    const total = performance.now() - t0;
    const j = JSON.parse(text);
    const at = (k: string) => text.indexOf(`"${k}"`);
    const share = (k: string, next: string) =>
      Math.round((((at(next) > 0 ? at(next) : text.length) - at(k)) / text.length) * 100);
    console.log(
      `${LEVEL} ${id.slice(0, 18)} run ${i + 1}: first output ${(first / 1000).toFixed(1)} s, firstStep starts ${(firstStepAt / 1000).toFixed(1)} s, done ${(total / 1000).toFixed(1)} s | in ${usage?.promptTokenCount} out ${usage?.candidatesTokenCount} thoughts ${usage?.thoughtsTokenCount} | ${j.objects?.length} objects, ${j.outline?.length} outline, chars ${text.length}: objects ${share('outline', 'objects')}% outline, ${share('objects', 'sightings')}% objects, ${share('firstStep', 'zzz')}% firstStep`,
    );
  }
}

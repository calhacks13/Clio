// Makes a synthetic planner bench scene: headset-like views generated from a written spec, then
// saved as a scenario (docs/planner-bench.md). A stand-in for capturing a real scene on
// bench.html, for a laptop without the original scenes. Run from apps/server:
//   npx tsx --env-file-if-exists=../../.env scripts/bench-scene.ts generate scripts/bench-scenes/<name>.json [--view 2]
//   npx tsx --env-file-if-exists=../../.env scripts/bench-scene.ts save scripts/bench-scenes/<name>.json
// `generate` writes the views to data/bench/generated/<name>/ (view 1 from its prompt, each later
// view from view 1, so they show the same scene); look at them before `save`. Resizing uses macOS
// `sips`: 1024 x 768 JPEG, as the headset sends.

import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { type ImagePayload, SlugSchema } from '@clio/protocol';
import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import { loadConfig } from '../src/config';
import { isGeminiConfigured } from '../src/services/gemini';
import { BenchStore } from '../src/storage/bench-store';

const IMAGE_MODEL = 'gemini-3-pro-image';

const SpecSchema = z.object({
  title: z.string().min(1).max(120),
  goal: z.string().min(3).max(300),
  context: z.string().max(2000).optional(),
  expect: z.array(z.string().min(1).max(300)).max(20),
  tags: z.array(SlugSchema).max(10).default([]),
  /** Said before every view's prompt: the camera, the light, what must never be in it. */
  style: z.string(),
  /** View 1 from its prompt; each later view from view 1 and its own prompt. */
  views: z.array(z.string().min(1)).min(1).max(3),
});
type Spec = z.infer<typeof SpecSchema>;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { view: { type: 'string', multiple: true } },
});
const [command, specPath] = positionals;
if ((command !== 'generate' && command !== 'save') || !specPath) {
  console.log('Usage: bench-scene.ts <generate|save> <spec.json> [--view <n> ...]');
  process.exit(1);
}
const spec = SpecSchema.parse(JSON.parse(await readFile(specPath, 'utf8')));
const name = basename(specPath, '.json');
const config = loadConfig();
const outDir = join(config.dataDir, 'bench', 'generated', name);
const viewPath = (n: number) => join(outDir, `view-${n}.jpg`);

if (command === 'generate') await generate(spec);
else await save(spec);

async function generate({ style, views }: Spec): Promise<void> {
  if (!isGeminiConfigured(config.geminiApiKey)) throw new Error('Set GEMINI_API_KEY in .env');
  const ai = new GoogleGenAI({ apiKey: config.geminiApiKey, vertexai: false });
  await mkdir(outDir, { recursive: true });
  const only = (values.view ?? []).map(Number);
  for (const [i, prompt] of views.entries()) {
    const n = i + 1;
    if (only.length && !only.includes(n)) continue;
    const parts: { text?: string; inlineData?: { mimeType: string; data: string } }[] = [];
    if (n > 1) {
      const first = await readFile(viewPath(1));
      parts.push({ inlineData: { mimeType: 'image/jpeg', data: first.toString('base64') } });
    }
    parts.push({ text: `${style}\n\n${prompt}` });
    const started = Date.now();
    const response = await ai.models.generateContent({
      model: IMAGE_MODEL,
      contents: [{ role: 'user', parts }],
      config: {
        responseModalities: ['IMAGE'],
        imageConfig: { aspectRatio: '4:3', imageSize: '1K' },
      },
    });
    const image = response.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
    if (!image?.inlineData?.data) throw new Error(`View ${n}: no image in the answer`);
    const raw = join(outDir, `view-${n}.raw`);
    await writeFile(raw, Buffer.from(image.inlineData.data, 'base64'));
    await promisify(execFile)('sips', [
      ...['-s', 'format', 'jpeg', '-s', 'formatOptions', '80'],
      ...['--resampleHeightWidth', '768', '1024', raw, '--out', viewPath(n)],
    ]);
    console.log(`view ${n}: ${viewPath(n)} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
  }
}

async function save({ title, goal, context, expect, tags, views }: Spec): Promise<void> {
  const images: ImagePayload[] = await Promise.all(
    views.map(async (_, i) => ({
      mimeType: 'image/jpeg' as const,
      data: (await readFile(viewPath(i + 1))).toString('base64'),
    })),
  );
  const store = new BenchStore(join(config.dataDir, 'bench'));
  const { scenario } = await store.create({
    title,
    goal,
    ...(context ? { context } : {}),
    expect,
    tags,
    images,
    runs: [],
  });
  console.log(`Saved scenario ${scenario.id} (${scenario.views.length} views)`);
}

// Paints the step watcher's hard cases (scripts/check-test-specs.ts) with an image model and
// saves them as watcher tests in data/bench/checks, for `pnpm bench --checks`. Scenes are cached
// in data/bench/check-scenes (gitignored, like all of data/) with the prompt that made them, so a
// run paints only what is missing or whose prompt changed. Look at every scene before trusting a
// test: a wrong label is worse than no test. Needs ffmpeg (1024 x 768 JPEG, as the headset sends).
// Run from apps/server:
//   npx tsx --env-file-if-exists=../../.env scripts/check-tests.ts [options]

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { GoogleGenAI, type Part } from '@google/genai';
import { loadConfig } from '../src/config';
import { isGeminiConfigured } from '../src/services/gemini';
import { slugFromGoal } from '../src/services/plan-ids';
import { BenchCheckStore } from '../src/storage/bench-check-store';
import { CHECK_TESTS, SCENES, type SceneSpec } from './check-test-specs';

const USAGE = `Usage: npx tsx --env-file-if-exists=../../.env scripts/check-tests.ts [options]

Paints the scenes that are missing (or whose prompt changed), then saves the watcher tests that
don't exist yet.

Options:
  --redo <scene>   Paint this scene again, and the scenes made from it; repeat for several
  --no-save        Only paint the scenes
  --replace        Save every test again, replacing one with the same id (its runs go with it)
  --model <name>   The image model (default gemini-3-pro-image)
  -h, --help       Show this help`;

const run = promisify(execFile);
const IMAGE_MODEL = 'gemini-3-pro-image';
/** The headset's frames: 1024 px wide, 4:3, JPEG at about 0.8. */
const FRAME = 'scale=1024:768:force_original_aspect_ratio=increase,crop=1024:768';
const JPEG_QUALITY = '4';
const PARALLEL = 4;

const { values } = parseArgs({
  options: {
    redo: { type: 'string', multiple: true },
    'no-save': { type: 'boolean' },
    replace: { type: 'boolean' },
    model: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});
if (values.help) {
  console.log(USAGE);
  process.exit(0);
}
const config = loadConfig();
if (!isGeminiConfigured(config.geminiApiKey)) throw new Error('Set GEMINI_API_KEY in .env');
const ai = new GoogleGenAI({ apiKey: config.geminiApiKey, vertexai: false });
const model = values.model ?? IMAGE_MODEL;
const benchDir = join(config.dataDir, 'bench');
const sceneDir = join(benchDir, 'check-scenes');
const redo = new Set(values.redo ?? []);
const unknown = [...redo].filter((name) => !SCENES.some((s) => s.name === name));
if (unknown.length) throw new Error(`No scene ${unknown.map((n) => `"${n}"`).join(', ')}`);
await mkdir(sceneDir, { recursive: true });

const scenePath = (name: string) => join(sceneDir, `${name}.jpg`);
/** What made a scene: its prompt or filter, and what it was made from. */
const recipe = (s: SceneSpec) =>
  JSON.stringify({ from: s.from ?? null, prompt: s.prompt ?? null, filter: s.filter ?? null });

/** Cached, made by the same recipe, and newer than the scene it was made from. */
async function fresh(scene: SceneSpec, repainted: ReadonlySet<string>): Promise<boolean> {
  if (redo.has(scene.name) || (scene.from && repainted.has(scene.from))) return false;
  try {
    const made = await readFile(join(sceneDir, `${scene.name}.json`), 'utf8');
    const { mtimeMs } = await stat(scenePath(scene.name));
    const source = scene.from ? (await stat(scenePath(scene.from))).mtimeMs : 0;
    return made === recipe(scene) && mtimeMs >= source;
  } catch {
    return false;
  }
}

/** Writes `input` (any image) as the headset's frame, through ffmpeg with an optional filter. */
async function frame(input: string, output: string, filter?: string): Promise<void> {
  const vf = filter ? `${filter},${FRAME}` : FRAME;
  await run('ffmpeg', [
    '-y',
    '-loglevel',
    'error',
    '-i',
    input,
    '-vf',
    vf,
    '-q:v',
    JPEG_QUALITY,
    output,
  ]);
}

async function paint(scene: SceneSpec, scratch: string): Promise<void> {
  const started = performance.now();
  if (scene.filter) {
    if (!scene.from) throw new Error(`Scene ${scene.name} has a filter but nothing to filter`);
    await frame(scenePath(scene.from), scenePath(scene.name), scene.filter);
  } else {
    if (!scene.prompt) throw new Error(`Scene ${scene.name} has no prompt`);
    const parts: Part[] = [];
    if (scene.from) {
      const data = (await readFile(scenePath(scene.from))).toString('base64');
      parts.push({ inlineData: { mimeType: 'image/jpeg', data } });
    }
    parts.push({ text: scene.prompt });
    const response = await ai.models.generateContent({
      model,
      contents: [{ role: 'user', parts }],
      config: {
        responseModalities: ['IMAGE'],
        imageConfig: { aspectRatio: '4:3', imageSize: '1K' },
      },
    });
    const image = response.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
    const data = image?.inlineData?.data;
    if (!data) throw new Error(`${model} painted no image for ${scene.name}`);
    const raw = join(scratch, `${scene.name}.raw`);
    await writeFile(raw, Buffer.from(data, 'base64'));
    await frame(raw, scenePath(scene.name));
  }
  await writeFile(join(sceneDir, `${scene.name}.json`), recipe(scene));
  console.log(`  painted ${scene.name} in ${((performance.now() - started) / 1000).toFixed(1)} s`);
}

/** Paints in waves: a scene waits for the one it is made from. */
async function paintAll(): Promise<void> {
  const scratch = await mkdtemp(join(tmpdir(), 'clio-check-scenes-'));
  try {
    const done = new Set<string>();
    const todo: SceneSpec[] = [];
    // SCENES lists a scene after the one it is made from, so a repaint carries down the chain.
    const repainted = new Set<string>();
    for (const scene of SCENES) {
      if (await fresh(scene, repainted)) done.add(scene.name);
      else {
        todo.push(scene);
        repainted.add(scene.name);
      }
    }
    console.log(`Scenes: ${done.size} cached, ${todo.length} to paint with ${model}`);
    const failed: string[] = [];
    while (todo.length) {
      const ready = todo.filter((s) => !s.from || done.has(s.from)).slice(0, PARALLEL);
      if (!ready.length) {
        failed.push(...todo.map((s) => s.name));
        break;
      }
      await Promise.all(
        ready.map(async (scene) => {
          todo.splice(todo.indexOf(scene), 1);
          try {
            await paint(scene, scratch);
            done.add(scene.name);
          } catch (error) {
            failed.push(scene.name);
            console.error(
              `  ${scene.name} failed: ${error instanceof Error ? error.message : error}`,
            );
          }
        }),
      );
    }
    if (failed.length) throw new Error(`Not painted: ${failed.join(', ')}`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function saveAll(): Promise<void> {
  const store = new BenchCheckStore(benchDir);
  const existing = new Set((await store.list()).map((t) => t.id));
  let saved = 0;
  for (const spec of CHECK_TESTS) {
    const id = slugFromGoal(spec.title);
    if (existing.has(id)) {
      if (!values.replace) continue;
      await store.remove(id);
    }
    const image = async (name: string) => ({
      mimeType: 'image/jpeg' as const,
      data: (await readFile(scenePath(name))).toString('base64'),
    });
    const { test } = await store.create({
      title: spec.title,
      expect: spec.expect,
      goal: spec.goal,
      step: spec.step,
      images: [await image(spec.now)],
      before: [await image(spec.before)],
      ...(spec.objects ? { objects: spec.objects } : {}),
      ...(spec.confusions ? { confusions: spec.confusions } : {}),
      notes: `${spec.notes} (Painted: ${spec.before} → ${spec.now}.)`,
    });
    if (test.id !== id) console.warn(`  ${spec.title} saved as ${test.id}, not ${id}`);
    saved++;
  }
  console.log(`Watcher tests: ${saved} saved, ${CHECK_TESTS.length - saved} already there`);
}

await paintAll();
if (!values['no-save']) await saveAll();

#!/usr/bin/env bun
// Builds one HTML file that replays a stretch of a Clio episode in the episode
// viewer, with no server and no network: double-click it, or send it.
//
//   bun scripts/build-standalone.ts <episode-id> --from 0:50 --to 1:50 \
//     [--out ../data/demos/name.html] [--server http://127.0.0.1:8787]
//
// It reads the episode from a running Clio server (the same reads the viewer
// makes through /api/clio), cuts the stretch out and moves it to start at 0
// (src/standalone/clip.ts), and packs it with the room scan, the generated
// models, their crops and the G1's URDF and meshes (simplified, see
// G1_TRIANGLE_SHARE) into the page (src/standalone/pack.ts). The page is the
// viewer's own code bundled by Bun, its Tailwind CSS and the Inter fonts,
// all inline. The output holds recording data: it goes under ../data/ by
// default, which git ignores, and nothing is uploaded anywhere.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import tailwind from "@tailwindcss/postcss";
import { MeshoptSimplifier } from "meshoptimizer";
import postcss from "postcss";
import {
  type ClipWindow,
  clipDoc,
  clipDurationMs,
  clipEvents,
  clipFrames,
  clipGridDoc,
  clipObjects,
  clipObservations,
} from "../src/standalone/clip";
import {
  encodeMesh,
  encodePack,
  MESH_TYPE,
  NDJSON_TYPE,
  type PackFile,
  requestKey,
} from "../src/standalone/pack";
import { THEME_INIT_SCRIPT } from "../src/utils/theme-init";

const ROOT = path.resolve(import.meta.dir, "..");
/** body.tsx's default; the bundle is built with the same value. */
const URDF_BASE_URL = "https://huggingface.co/buckets/lerobot/robot-urdfs/resolve";
/** Downloads that do not change between builds (the G1's files, the fonts). */
const CACHE_DIR = path.join(ROOT, "node_modules/.cache/clio-standalone");
/** The share of each G1 mesh's triangles kept: 34 MB of STL becomes about 2 MB packed. */
const G1_TRIANGLE_SHARE = 0.2;
/** How far a simplified G1 mesh may stray, relative to its size. */
const G1_MAX_ERROR = 0.01;
const FONTS_CSS_URL =
  "https://fonts.googleapis.com/css2?family=Inter:wght@100..900&family=Inter+Tight:wght@100..900&display=swap";
/** Google Fonts sends woff2 only to a browser it knows. */
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

type Json = Record<string, unknown>;

/** "1:50", "1:50.5" or "110" as ms. */
function parseTime(text: string): number {
  const parts = text.split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part))) {
    throw new Error(`Not a time: ${text}`);
  }
  return parts.reduce((total, part) => total * 60 + part, 0) * 1000;
}

function usage(message: string): never {
  console.error(
    `${message}\nUsage: bun scripts/build-standalone.ts <episode-id> --from 0:50 --to 1:50 [--out file.html] [--server url]`,
  );
  process.exit(1);
}

async function get(url: string): Promise<Response> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res;
}

async function getJson(url: string): Promise<Json> {
  return (await (await get(url)).json()) as Json;
}

/** A download kept in CACHE_DIR, read from there on later builds. */
async function cached(url: string, init?: RequestInit): Promise<Uint8Array> {
  const file = path.join(CACHE_DIR, encodeURIComponent(url));
  try {
    return new Uint8Array(await readFile(file));
  } catch {
    const res = await fetch(url, init);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(file, bytes);
    return bytes;
  }
}

function parseNdjson(text: string): unknown[] {
  const records: unknown[] = [];
  for (const line of text.split("\n")) {
    if (line.trim()) records.push(JSON.parse(line));
  }
  return records;
}

const encoder = new TextEncoder();
const jsonFile = (value: unknown): PackFile => ({
  type: "application/json",
  bytes: encoder.encode(JSON.stringify(value)),
});
const ndjsonFile = (records: unknown[]): PackFile => ({
  type: NDJSON_TYPE,
  bytes: encoder.encode(
    records.map((record) => `${JSON.stringify(record)}\n`).join(""),
  ),
});

function contentType(name: string): string {
  if (name.endsWith(".glb")) return "model/gltf-binary";
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}

/** The episode's detail, channels and compiled files, cut to the window, as pack files. */
async function episodeFiles(
  server: string,
  episodeId: string,
  window: ClipWindow,
): Promise<{ files: Map<string, PackFile>; detail: Json }> {
  const api = `${server}/api/episodes/${encodeURIComponent(episodeId)}`;
  const at = (suffix: string) => requestKey(`/api/clio/episodes/${episodeId}${suffix}`).key;
  const files = new Map<string, PackFile>();
  const detail = await getJson(api);
  const duration = clipDurationMs(window);

  const channels = {
    frames: clipFrames,
    events: clipEvents,
    objects: clipObjects,
    observations: clipObservations,
  } as const;
  const counts: Record<string, number> = {};
  for (const [channel, clip] of Object.entries(channels)) {
    const res = await fetch(`${api}/${channel}?from=0`);
    if (res.status === 404) continue;
    if (!res.ok) throw new Error(`${channel}: HTTP ${res.status}`);
    const records = clip(parseNdjson(await res.text()), window);
    counts[channel] = records.length;
    files.set(at(`/${channel}`), ndjsonFile(records));
  }
  if (!counts.frames) {
    throw new Error("No frames in that stretch; check --from and --to");
  }

  const meta = detail.meta as Json;
  const clock = meta.clock as Json;
  meta.clock = {
    ...clock,
    startEpochMs: (clock.startEpochMs as number) + window.fromMs,
  };
  detail.summary = {
    ...(detail.summary as Json),
    durationMs: duration,
    frameCount: counts.frames,
    eventCount: counts.events ?? 0,
  };
  if (detail.finish) {
    detail.finish = { ...(detail.finish as Json), durationMs: duration };
  }

  const derived = detail.derived as Json | null;
  const manifest = derived?.manifest as Json | undefined;
  for (const artifact of (manifest?.artifacts ?? []) as Json[]) {
    const name = String(artifact.name);
    const res = await get(`${api}/derived/${encodeURIComponent(name)}`);
    const file: PackFile = name.endsWith(".json")
      ? jsonFile(clipGridDoc(await res.json(), window))
      : { type: contentType(name), bytes: new Uint8Array(await res.arrayBuffer()) };
    files.set(at(`/derived/${name}`), file);
    artifact.bytes = file.bytes.length;
  }
  if (manifest?.quality) {
    manifest.quality = {
      ...(manifest.quality as Json),
      durationMs: duration,
      frames: counts.frames,
    };
  }

  const sceneStatus = detail.scene as Json | null;
  if (sceneStatus?.scene) {
    const scene = clipDoc(sceneStatus.scene, window) as Json;
    const names = new Set<string>();
    for (const model of scene.objects as Json[]) {
      // The note is for whoever runs the pipeline (a backend that is not set up, a local path).
      model.note = null;
      if (typeof model.model === "string") names.add(model.model);
      for (const crop of (model.crops ?? []) as Json[]) names.add(String(crop.file));
    }
    for (const name of names) {
      const res = await fetch(`${api}/scene/${encodeURIComponent(name)}`);
      if (!res.ok) continue;
      files.set(at(`/scene/${name}`), {
        type: contentType(name),
        bytes: new Uint8Array(await res.arrayBuffer()),
      });
    }
    sceneStatus.scene = scene;
  }

  const summary = detail.summary as Json;
  files.set(requestKey("/api/clio/episodes").key, jsonFile({ episodes: [summary] }));
  files.set(at(""), jsonFile(detail));
  return { files, detail };
}

/** Binary STL as positions, three vertices per triangle. */
function parseStl(bytes: Uint8Array): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const triangles = view.getUint32(80, true);
  if (84 + triangles * 50 !== bytes.length) {
    throw new Error("Only binary STL is supported");
  }
  const positions = new Float32Array(triangles * 9);
  for (let tri = 0; tri < triangles; tri++) {
    for (let i = 0; i < 9; i++) {
      positions[tri * 9 + i] = view.getFloat32(84 + tri * 50 + 12 + i * 4, true);
    }
  }
  return positions;
}

/** Shared corners merged, so the simplifier sees a connected surface. */
function weld(soup: Float32Array): { positions: Float32Array; indices: Uint32Array } {
  const seen = new Map<string, number>();
  const positions: number[] = [];
  const indices = new Uint32Array(soup.length / 3);
  for (let v = 0; v < indices.length; v++) {
    const x = soup[v * 3] as number;
    const y = soup[v * 3 + 1] as number;
    const z = soup[v * 3 + 2] as number;
    const key = `${x},${y},${z}`;
    let index = seen.get(key);
    if (index === undefined) {
      index = positions.length / 3;
      seen.set(key, index);
      positions.push(x, y, z);
    }
    indices[v] = index;
  }
  return { positions: new Float32Array(positions), indices };
}

/** Only the vertices the indices use, renumbered. */
function compact(
  positions: Float32Array,
  indices: Uint32Array,
): { positions: Float32Array; indices: Uint32Array } {
  const remap = new Map<number, number>();
  const kept: number[] = [];
  const out = new Uint32Array(indices.length);
  for (let i = 0; i < indices.length; i++) {
    const old = indices[i] as number;
    let index = remap.get(old);
    if (index === undefined) {
      index = kept.length / 3;
      remap.set(old, index);
      kept.push(
        positions[old * 3] as number,
        positions[old * 3 + 1] as number,
        positions[old * 3 + 2] as number,
      );
    }
    out[i] = index;
  }
  return { positions: new Float32Array(kept), indices: out };
}

/** The G1's URDF and its meshes, simplified, keyed by the URLs the body layer asks for. */
async function robotFiles(urdfPath: string): Promise<Map<string, PackFile>> {
  await MeshoptSimplifier.ready;
  const files = new Map<string, PackFile>();
  const urdfUrl = `${URDF_BASE_URL}/${urdfPath}`;
  const urdf = await cached(urdfUrl);
  files.set(requestKey(urdfUrl).key, { type: "application/xml", bytes: urdf });
  const base = urdfUrl.slice(0, urdfUrl.lastIndexOf("/") + 1);
  const meshes = new Set(
    [...new TextDecoder().decode(urdf).matchAll(/filename="([^"]+)"/g)].map(
      (match) => match[1] as string,
    ),
  );
  let before = 0;
  let after = 0;
  for (const mesh of meshes) {
    const url = new URL(mesh, base).href;
    const welded = weld(parseStl(await cached(url)));
    const target = Math.max(
      3,
      Math.floor((welded.indices.length * G1_TRIANGLE_SHARE) / 3) * 3,
    );
    const [simplified] = MeshoptSimplifier.simplify(
      welded.indices,
      welded.positions,
      3,
      target,
      G1_MAX_ERROR,
    );
    const small = compact(welded.positions, simplified);
    before += welded.indices.length / 3;
    after += small.indices.length / 3;
    files.set(requestKey(url).key, {
      type: MESH_TYPE,
      bytes: encodeMesh(small.positions, small.indices),
    });
  }
  console.log(
    `G1: ${meshes.size} meshes, ${before} triangles simplified to ${after}`,
  );
  return files;
}

/** @font-face rules for Inter and Inter Tight (latin), with the fonts inline. */
async function fontFaces(): Promise<string> {
  try {
    const css = new TextDecoder().decode(
      await cached(FONTS_CSS_URL, { headers: { "user-agent": BROWSER_UA } }),
    );
    const faces: string[] = [];
    for (const [, block] of css.matchAll(/\/\* latin \*\/\s*(@font-face\s*{[^}]*})/g)) {
      const url = /url\((https:[^)]+)\)/.exec(block as string)?.[1];
      if (!url) continue;
      const font = Buffer.from(await cached(url)).toString("base64");
      faces.push(
        (block as string).replace(url, `data:font/woff2;base64,${font}`),
      );
    }
    return faces.join("\n");
  } catch (err) {
    console.warn(`Fonts not inlined, the page falls back to system fonts: ${err}`);
    return "";
  }
}

/** The app's Tailwind CSS (src/app/globals.css), as `next dev` builds it. */
async function appCss(): Promise<string> {
  const from = path.join(ROOT, "src/app/globals.css");
  const result = await postcss([tailwind({ base: ROOT, optimize: true })]).process(
    await readFile(from, "utf8"),
    { from },
  );
  return result.css;
}

async function bundle(): Promise<string> {
  const result = await Bun.build({
    entrypoints: [path.join(ROOT, "src/standalone/main.tsx")],
    target: "browser",
    format: "esm",
    minify: true,
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
      "process.env.NEXT_PUBLIC_URDF_BASE_URL": JSON.stringify(URDF_BASE_URL),
    },
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error("Bundling the viewer failed");
  }
  const [output] = result.outputs;
  if (!output) throw new Error("Bundling the viewer produced nothing");
  return output.text();
}

/** Safe inside an inline <script>: no "</script" can end it early. */
const scriptSafe = (text: string) => text.replace(/<\/(script)/gi, "<\\/$1");

const escapeHtml = (text: string) =>
  text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

async function main() {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    allowPositionals: true,
    options: {
      from: { type: "string" },
      to: { type: "string" },
      out: { type: "string" },
      server: { type: "string" },
    },
  });
  const [episodeId] = positionals;
  if (!episodeId) usage("Name the episode.");
  if (!values.from || !values.to) usage("Give the stretch with --from and --to.");
  const window = { fromMs: parseTime(values.from), toMs: parseTime(values.to) };
  if (window.toMs <= window.fromMs) usage("--to must come after --from.");
  const server = (
    values.server ??
    process.env.CLIO_SERVER_URL ??
    "http://127.0.0.1:8787"
  ).replace(/\/$/, "");
  const out = path.resolve(
    values.out ??
      path.join(
        ROOT,
        "../data/demos",
        `${episodeId}_${values.from}-${values.to}.html`.replaceAll(":", "."),
      ),
  );

  const { files, detail } = await episodeFiles(server, episodeId, window);
  const body = files.get(
    requestKey(`/api/clio/episodes/${episodeId}/derived/body-g1.json`).key,
  );
  const urdf = body
    ? ((JSON.parse(new TextDecoder().decode(body.bytes)) as Json).profile as Json)
        .urdf
    : null;
  if (typeof urdf === "string") {
    for (const [key, file] of await robotFiles(urdf)) files.set(key, file);
  }

  const packed = Bun.gzipSync(encodePack(episodeId, files), { level: 9 });
  const [css, fonts, js] = await Promise.all([appCss(), fontFaces(), bundle()]);
  const meta = detail.meta as Json;
  const title = String(
    (meta.procedure as Json | null)?.title ?? "Clio recording",
  );

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<script>${THEME_INIT_SCRIPT}</script>
<style>
${fonts}
:root { --font-inter: "Inter"; --font-inter-tight: "Inter Tight"; }
${css}
</style>
</head>
<body class="font-sans">
<div id="root"></div>
<script id="clio-pack" type="application/octet-stream">${Buffer.from(packed).toString("base64")}</script>
<script type="module">${scriptSafe(js)}</script>
</body>
</html>
`;
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, html);
  const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  console.log(
    `${out}\n${mb(html.length)}: data ${mb(packed.length)} gzipped, script ${mb(js.length)}, styles ${mb(css.length + fonts.length)}`,
  );
}

await main();

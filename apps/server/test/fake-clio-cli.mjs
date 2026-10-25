// A stand-in for the pipeline's `clio compile`, so server tests need neither uv nor Python.
//
//   node fake-clio-cli.mjs [--log FILE] [--control DIR] [--ignore-term]
//     compile <episode dir> --out <derived dir> [--fps N] [--retarget FILE]... [--if-stale] --json
//
// It writes <out>/<id>/manifest.json (a valid CompileManifest listing the raw inputs and the room
// scans in media/ with sizes and hashes) and <out>/<id>/tracks.json, then prints the real CLI's --json line. With --if-stale it
// skips an episode whose manifest lists the same inputs and prints `"skipped": true`. --log appends
// one JSON line when a run starts and one when it ends. Files in the --control dir steer a run,
// named by its episode id: `gate` makes every run wait until it exists; `<id>.fail` is printed to
// stderr and the run exits 3; `<id>.hang` makes the run never finish. --ignore-term ignores
// SIGTERM.

import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';

const INPUTS = [
  'meta.json',
  'frames.ndjson',
  'events.ndjson',
  'objects.ndjson',
  'observations.ndjson',
  'finish.json',
  'batches.json',
];
const ROOM_SCAN = /^room-scan-[0-9]{1,4}\.glb$/;

const argv = process.argv.slice(2);
const split = argv.indexOf('compile');
const own = parseOptions(argv.slice(0, split));
const compileArgs = argv.slice(split + 1);
const target = compileArgs[0];
const opts = parseOptions(compileArgs.slice(1));

const key = basename(target);
const control = (name) => (own.control ? join(own.control, name) : null);
const log = (event) => {
  if (own.log) appendFileSync(own.log, `${JSON.stringify({ event, pid: process.pid, argv })}\n`);
};

if (own['ignore-term']) process.on('SIGTERM', () => {});
log('start');
waitFor(control('gate'), run);

function run() {
  const hang = control(`${key}.hang`);
  if (hang && existsSync(hang)) {
    setInterval(() => {}, 1000);
    return;
  }
  const fail = control(`${key}.fail`);
  if (fail && existsSync(fail)) {
    process.stderr.write(readFileSync(fail));
    log('end');
    process.exit(3);
  }
  if (!existsSync(join(target, 'meta.json'))) {
    process.stderr.write(`clio: ${target}: not an episode directory (no meta.json)\n`);
    log('end');
    process.exit(2);
  }
  const inputs = inputsOf(target);
  const out = join(opts.out, key);
  const skipped = Boolean(opts['if-stale']) && upToDate(out, inputs);
  if (!skipped) compile(target, key, inputs);
  const line = { episodeId: key, skipped, outDir: out, usable: false, stages: [] };
  process.stdout.write(`${JSON.stringify(line)}\n`);
  log('end');
}

function compile(dir, id, inputs) {
  const out = join(opts.out, id);
  mkdirSync(out, { recursive: true });
  const tracks = JSON.stringify({ schema: 'clio.derived/1', episodeId: id, kind: 'tracks' });
  writeAtomic(join(out, 'tracks.json'), tracks);
  const finished = existsSync(join(dir, 'finish.json'));
  const manifest = {
    schema: 'clio.derived/1',
    episodeId: id,
    compiledAt: new Date().toISOString(),
    compiler: { name: 'fake-clio', version: '0.0.0' },
    fps: Number(opts.fps ?? 30),
    inputs,
    retarget: [],
    stages: [{ name: 'tracks', status: 'ok' }],
    artifacts: [{ name: 'tracks.json', kind: 'tracks', bytes: Buffer.byteLength(tracks) }],
    quality: {
      usable: false,
      reasons: ['fake compile'],
      finished,
      outcome: null,
      batches: null,
      durationMs: 0,
      frames: 0,
      frameRateHz: null,
      maxFrameGapMs: null,
      hands: { left: 0, right: 0 },
      objects: [],
      validationIssues: 0,
    },
  };
  // Last, like the real compiler: its presence means the compile is complete.
  writeAtomic(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
}

function inputsOf(dir) {
  const media = existsSync(join(dir, 'media')) ? readdirSync(join(dir, 'media')) : [];
  const scans = media.filter((name) => ROOM_SCAN.test(name)).map((name) => `media/${name}`);
  return [...INPUTS, ...scans.sort()]
    .filter((name) => existsSync(join(dir, name)))
    .map((name) => {
      const bytes = readFileSync(join(dir, name));
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      return { name, bytes: bytes.length, sha256 };
    });
}

function upToDate(out, inputs) {
  let listed;
  try {
    listed = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')).inputs;
  } catch {
    return false; // missing, unreadable or not JSON: compile it
  }
  return JSON.stringify(listed) === JSON.stringify(inputs);
}

function writeAtomic(path, text) {
  writeFileSync(`${path}.tmp`, text);
  renameSync(`${path}.tmp`, path);
}

function waitFor(path, then) {
  if (path === null || existsSync(path)) return then();
  const timer = setInterval(() => {
    if (!existsSync(path)) return;
    clearInterval(timer);
    then();
  }, 5);
}

/** `--name value` pairs; a flag followed by another flag (or nothing) is `true`. Repeats collect. */
function parseOptions(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const name = args[i].replace(/^--/, '');
    const next = args[i + 1];
    let value = true;
    if (next !== undefined && !next.startsWith('--')) {
      value = next;
      i++;
    }
    out[name] = name in out ? [out[name], value].flat() : value;
  }
  return out;
}

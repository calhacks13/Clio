import './bench.css';
import type {
  BenchCheckExpect,
  BenchCheckTestDetail,
  BenchCheckTestSummary,
  BenchModelsResponse,
  BenchPlanRequest,
  BenchRevise,
  BenchRun,
  BenchScenario,
  BenchScenarioSummary,
  ImagePayload,
  PlanStage,
  Procedure,
} from '@clio/protocol';
import { BenchClient } from './bench-client';
import { renderCheckTestDetail, renderCheckTestItem } from './check-view';
import {
  type LookAsked,
  nextLookDelay,
  stepCheckHints,
  type WatchLook,
  WatchSession,
} from './live-watch';
import {
  esc,
  renderChipList,
  renderRun,
  renderScenarioItem,
  renderSightings,
  type StageView,
  type StepCheckState,
  shortModel,
} from './plan-view';
import { firstOf, pairStages, restRevise } from './stages';
import {
  AS_FAST_AS_IT_ANSWERS,
  expectText,
  renderSaveTest,
  renderWatchControls,
  renderWatchLog,
  renderWatchStatus,
  stepBadge,
  watchState,
} from './watch-view';
import { Webcam } from './webcam';

// The planner bench (bench.html, docs/planner-bench.md). Point the laptop camera at a scene,
// give the planner a goal, and read the plan it writes, from one model or several at once, in
// one go or in two stages (step 1 first, the rest refined after). A scene worth keeping becomes
// a scenario: its frames, its request and what a correct plan must do. Saved scenarios can be
// re-run with any model, graded by hand or by a judge model, and run all together after a prompt
// or model change. Watching live follows a plan while you do it in front of the camera, asking
// the step watcher's question about the focused step over and over; any of its looks can be kept
// as a watcher test, with the answer it should have given, and replayed on any model.

type Scene =
  | { kind: 'live' }
  | { kind: 'captured'; images: ImagePayload[]; at: Date }
  | { kind: 'scenario'; scenario: BenchScenario };

interface Pending {
  key: number;
  model: string;
  started: number;
  stage?: PlanStage;
  /** For stage rest: the run whose outline it refines. */
  after?: string;
}

interface Batch {
  done: number;
  total: number;
  label: string;
  stop: boolean;
  planned: number;
  judged: number;
  passed: number;
}

interface Prefs {
  goal: string;
  context: string;
  models: string[];
  judgeModel: string;
  camera: string;
  frames: number;
  twoStage: boolean;
  sightings: boolean;
  /** 0: look again as soon as the last answer is in. */
  watchEveryMs: number;
  watchAuto: boolean;
  watchInARow: number;
}

/** A plan followed live: its progress plus how and how often to look. */
interface Watch {
  runId: string;
  title: string;
  goal: string;
  /** The plan being followed, for what its steps' objects look like. */
  procedure: Procedure;
  session: WatchSession;
  model: string;
  intervalMs: number;
  autoAdvance: boolean;
  needed: number;
  paused: boolean;
  looking: boolean;
  suggest: boolean;
  /** The frame from when the focused step gained focus (session.focusTurn), sent as `before`. */
  before: { turn: number; image: ImagePayload; url: string } | null;
  /** The look whose save-as-test form is open. */
  saving: WatchLook | null;
  timer: ReturnType<typeof setTimeout> | null;
  clock: ReturnType<typeof setInterval>;
}

interface TestBatch {
  done: number;
  total: number;
  passed: number;
  stop: boolean;
}

const api = new BenchClient();
const SLOW_BUDGET_MS = 120_000;
const prefs = loadPrefs();
const state = {
  models: null as BenchModelsResponse | null,
  selected: [...prefs.models],
  judgeModel: prefs.judgeModel,
  scene: { kind: 'live' } as Scene,
  /** Bumped whenever the scene changes, so a slow answer never lands on the wrong scene. */
  sceneKey: 0,
  shown: 0,
  revise: null as BenchRevise | null,
  runs: [] as BenchRun[],
  pending: [] as Pending[],
  runId: null as string | null,
  checks: new Map<string, Map<number, StepCheckState>>(),
  judging: new Set<string>(),
  library: [] as BenchScenarioSummary[],
  batch: null as Batch | null,
  watch: null as Watch | null,
  /** Watcher tests, the one shown open and the models each is running with now. */
  tests: [] as BenchCheckTestSummary[],
  openTest: null as BenchCheckTestDetail | null,
  testsRunning: new Map<string, string[]>(),
  testBatch: null as TestBatch | null,
};
let webcam: Webcam | null = null;
let pendingKey = 0;
let ticker: ReturnType<typeof setInterval> | null = null;
const scenarioImages = new Map<string, ImagePayload[]>();

async function init(el: HTMLElement): Promise<void> {
  el.innerHTML = layout();
  bindEvents();
  input('#goal').value = prefs.goal;
  textarea('#context').value = prefs.context;
  select('#frames').value = String(prefs.frames);
  input('#two-stage').checked = prefs.twoStage;
  input('#sightings-on').checked = prefs.sightings;
  renderScene();
  renderChips();
  renderRunView();
  await Promise.all([
    loadModels(),
    openCamera(prefs.camera || undefined),
    refreshLibrary(),
    refreshTests(),
  ]);
}

// ---------------------------------------------------------------------------------------------
// Layout and events

function layout(): string {
  return `
    <header class="top">
      <h1>Planner bench</h1>
      <span id="status" class="status">Connecting…</span>
      <label class="judge-pick">Judge <select id="judge-model"></select></label>
    </header>
    <main class="bench">
      <section class="panel scene-panel">
        <div class="viewer">
          <video id="video" autoplay muted playsinline></video>
          <img id="frame" alt="Captured frame" hidden>
          <div id="overlay" class="overlay"></div>
          <span id="scene-badge" class="scene-badge">Live</span>
          <p id="camera-error" class="camera-error" hidden></p>
        </div>
        <div id="thumbs" class="thumbs"></div>
        <label id="sightings-row" class="check sightings-row" hidden title="The planner's sightings: where it saw each object it declared, in these frames">
          <input id="sightings-on" type="checkbox"> Show where the plan saw its objects <span id="sightings-count" class="muted"></span>
        </label>
        <div class="row">
          <select id="camera" title="Camera"></select>
          <select id="frames" title="Frames per capture">
            <option value="1">1 frame</option>
            <option value="2">2 frames</option>
            <option value="3">3 frames</option>
          </select>
          <button id="capture" type="button">Capture</button>
          <button id="live" type="button">Back to live</button>
        </div>
        <div id="scene-note"></div>
        <form id="request" class="stack">
          <label>Goal
            <input id="goal" maxlength="300" placeholder="e.g. make a cup of pour-over coffee" autocomplete="off">
          </label>
          <label>What the learner said <span class="muted">(optional)</span>
            <textarea id="context" rows="2" maxlength="2000" placeholder="e.g. I'm left-handed and the kettle has just boiled"></textarea>
          </label>
          <details id="models" class="models">
            <summary id="models-summary">Models</summary>
            <div id="model-list" class="model-list"></div>
          </details>
          <label class="check" title="Stage 1 writes step 1 in full and the rest as an outline, so a lesson can start quickly; then the rest is refined in full while the learner works on step 1">
            <input id="two-stage" type="checkbox"> Plan in two stages: step 1 first, the rest refined after
          </label>
          <label class="check" title="The headset gives the planner 40 s, retry included">
            <input id="slow" type="checkbox"> Give slow models 2 minutes, not the headset's 40 s
          </label>
          <button id="plan" class="primary" type="submit">Capture &amp; plan</button>
          <p class="hint">⌘/Ctrl + Enter plans. The planner sees exactly the frames shown above.</p>
        </form>
        <form id="save" class="stack save">
          <h2 id="save-title">Save as a scenario</h2>
          <label>Title <input id="title" maxlength="120" placeholder="e.g. Coffee, kettle already hot" autocomplete="off"></label>
          <label>A correct plan must… <span class="muted">(one per line)</span>
            <textarea id="expect" rows="4" placeholder="Skip boiling water: the kettle is already hot&#10;Never use the knife lying on the left"></textarea>
          </label>
          <label>Tags <span class="muted">(comma separated)</span> <input id="tags" placeholder="e.g. distractor, safety" autocomplete="off"></label>
          <div class="row">
            <button id="save-btn" type="submit">Save scenario</button>
            <button id="delete" class="danger" type="button" hidden>Delete scenario</button>
          </div>
        </form>
      </section>
      <section class="panel runs-panel">
        <div id="chips" class="chips"></div>
        <div id="watch"></div>
        <div id="run" class="run-view"></div>
      </section>
      <aside class="panel library-panel">
        <div class="library-head">
          <h2>Scenarios <span id="lib-count" class="muted"></span></h2>
          <input id="lib-filter" placeholder="Filter by title, goal or tag" autocomplete="off">
          <div class="row">
            <button id="run-all" type="button">Run all shown</button>
            <label class="check"><input id="run-all-judge" type="checkbox" checked> and judge</label>
          </div>
          <p id="batch" class="batch" hidden></p>
        </div>
        <ul id="library" class="library"></ul>
        <div class="library-head tests-head">
          <h2>Watcher tests <span id="tests-count" class="muted"></span></h2>
          <p class="hint">Looks kept from <strong>Every look</strong> while watching live, each with the answer it should have given. They run with the ticked models.</p>
          <div class="row">
            <button id="tests-run-all" type="button">Run all tests</button>
          </div>
          <p id="tests-batch" class="batch" hidden></p>
        </div>
        <ul id="tests" class="library"></ul>
      </aside>
    </main>
    <div id="toast" class="toast" hidden></div>`;
}

function bindEvents(): void {
  form('#request').addEventListener('submit', (e) => {
    e.preventDefault();
    void plan();
  });
  form('#request').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void plan();
    }
  });
  for (const id of ['#goal', '#context']) {
    $(id).addEventListener('input', () => savePrefs());
  }
  button('#capture').addEventListener('click', () => void capture());
  button('#live').addEventListener('click', () => backToLive());
  select('#camera').addEventListener('change', () => void openCamera(select('#camera').value));
  select('#frames').addEventListener('change', () => savePrefs());
  input('#two-stage').addEventListener('change', () => savePrefs());
  input('#sightings-on').addEventListener('change', () => {
    savePrefs();
    renderOverlay();
  });
  $('#frame').addEventListener('load', () => renderOverlay());
  $('#model-list').addEventListener('change', () => {
    state.selected = [...document.querySelectorAll<HTMLInputElement>('#model-list input:checked')]
      .map((i) => i.value)
      .filter(Boolean);
    renderModels();
    renderTests();
    savePrefs();
  });
  select('#judge-model').addEventListener('change', () => {
    state.judgeModel = select('#judge-model').value;
    savePrefs();
    renderRunView();
  });
  form('#save').addEventListener('submit', (e) => {
    e.preventDefault();
    void save();
  });
  button('#delete').addEventListener('click', () => void deleteScenario());
  $('#thumbs').addEventListener('click', (e) => {
    const frame = (e.target as HTMLElement).closest<HTMLElement>('[data-frame]');
    if (!frame) return;
    state.shown = Number(frame.dataset.frame);
    renderScene();
  });
  $('#chips').addEventListener('click', (e) => {
    const chip = (e.target as HTMLElement).closest<HTMLElement>('[data-action="select-run"]');
    if (chip?.dataset.run) selectRun(chip.dataset.run);
  });
  $('#run').addEventListener('click', (e) => onRunClick(e));
  $('#watch').addEventListener('click', (e) => onWatchClick(e));
  $('#watch').addEventListener('change', (e) => onWatchChange(e));
  $('#watch').addEventListener('submit', (e) => {
    const form = (e.target as HTMLElement).closest<HTMLFormElement>('form.save-test');
    if (!form) return;
    e.preventDefault();
    void saveLookAsTest(form);
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.watch && !state.watch.paused) scheduleLook(500);
  });
  $('#run').addEventListener('change', (e) => {
    const target = e.target as HTMLElement;
    if (target.matches('[data-action="grade-notes"]'))
      void saveNotes((target as HTMLInputElement).value);
  });
  $('#run').addEventListener('submit', (e) => {
    const replan = (e.target as HTMLElement).closest<HTMLFormElement>('form.replan');
    if (!replan) return;
    e.preventDefault();
    const reason = new FormData(replan).get('reason')?.toString().trim() ?? '';
    if (reason) void replanFrom(Number(replan.dataset.step), reason);
  });
  $('#library').addEventListener('click', (e) => {
    const item = (e.target as HTMLElement).closest<HTMLElement>('[data-action="load-scenario"]');
    if (item?.dataset.id) void loadScenario(item.dataset.id);
  });
  input('#lib-filter').addEventListener('input', () => renderLibrary());
  button('#run-all').addEventListener('click', () => void runAll());
  $('#tests').addEventListener('click', (e) => onTestsClick(e));
  $('#tests').addEventListener('change', (e) => {
    const target = e.target as HTMLSelectElement;
    if (target.dataset.action === 'test-expect' && target.dataset.id) {
      void setTestExpect(target.dataset.id, target.value as BenchCheckExpect);
    }
  });
  button('#tests-run-all').addEventListener('click', () => void runAllTests());
}

function selectRun(runId: string): void {
  state.runId = runId;
  renderChips();
  renderRunView();
}

function onRunClick(e: Event): void {
  const target = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
  if (!target) return;
  const step = Number(target.dataset.step);
  switch (target.dataset.action) {
    case 'select-run':
      if (target.dataset.run) selectRun(target.dataset.run);
      break;
    case 'grade':
      void grade(target.dataset.grade as 'pass' | 'partial' | 'fail');
      break;
    case 'judge':
      void judge();
      break;
    case 'check':
      void checkStep(step);
      break;
    case 'watch-start':
      startWatch();
      break;
    case 'replan-open': {
      const replan = document.querySelector<HTMLFormElement>(
        `#run form.replan[data-step="${step}"]`,
      );
      if (!replan) return;
      replan.hidden = !replan.hidden;
      if (!replan.hidden) replan.querySelector('input')?.focus();
      break;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Server, models, camera

async function loadModels(): Promise<void> {
  const health = await api.health().catch(() => null);
  try {
    state.models = await api.models();
  } catch (err) {
    setStatus(
      health
        ? `Server ${health.version} · Gemini is off: set GEMINI_API_KEY in .env (${message(err)})`
        : 'Server unreachable: run pnpm dev',
      'bad',
    );
    renderModels();
    return;
  }
  const { plannerModel, judgeModel, models } = state.models;
  state.selected = state.selected.filter((m) => models.includes(m));
  if (!state.selected.length) state.selected = [plannerModel];
  if (!models.includes(state.judgeModel)) state.judgeModel = judgeModel;
  setStatus(`Server ${health?.version ?? '?'} · headset plans with ${plannerModel}`, 'ok');
  select('#judge-model').innerHTML = models
    .map(
      (m) => `<option value="${esc(m)}">${esc(m)}${m === judgeModel ? ' (default)' : ''}</option>`,
    )
    .join('');
  select('#judge-model').value = state.judgeModel;
  renderModels();
  renderRunView();
  renderTests();
}

function renderModels(): void {
  const models = state.models;
  const list = $('#model-list');
  if (!models) {
    list.innerHTML = '<p class="muted">No models: Gemini is off.</p>';
    $('#models-summary').textContent = 'Models: none';
    return;
  }
  const order = [models.plannerModel, ...models.models.filter((m) => m !== models.plannerModel)];
  list.innerHTML = order
    .map(
      (m) => `
      <label class="check">
        <input type="checkbox" value="${esc(m)}" ${state.selected.includes(m) ? 'checked' : ''}>
        ${esc(m)}${m === models.plannerModel ? ' <span class="muted">(the headset’s)</span>' : ''}
      </label>`,
    )
    .join('');
  const [first, ...rest] = state.selected;
  $('#models-summary').textContent = first
    ? `Plan with ${first}${rest.length ? ` + ${rest.length} more` : ''}`
    : 'Plan with: pick a model';
}

async function openCamera(deviceId?: string): Promise<void> {
  webcam?.close();
  webcam = null;
  const error = $('#camera-error');
  try {
    webcam = await Webcam.open(video(), deviceId);
    error.hidden = true;
  } catch (err) {
    if (deviceId) return openCamera();
    error.textContent = `No camera: ${message(err)}. Allow camera access for this page and reload.`;
    error.hidden = false;
  }
  const cameras = await Webcam.cameras().catch(() => []);
  select('#camera').innerHTML = cameras
    .map(
      (c, i) => `<option value="${esc(c.deviceId)}">${esc(c.label || `Camera ${i + 1}`)}</option>`,
    )
    .join('');
  if (webcam?.deviceId) select('#camera').value = webcam.deviceId;
  savePrefs();
  renderScene();
}

async function snapshots(): Promise<ImagePayload[] | null> {
  if (!webcam) {
    toast('No camera. Allow camera access and reload, or load a saved scenario.');
    return null;
  }
  try {
    return await webcam.snapshots(Number(select('#frames').value) || 2);
  } catch (err) {
    toast(`Capture failed: ${message(err)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Scenes

function setScene(scene: Scene): void {
  state.scene = scene;
  state.sceneKey++;
  state.shown = 0;
  state.runs = [];
  state.runId = null;
  state.pending = [];
  state.checks.clear();
  stopWatch();
  renderScene();
  renderChips();
  renderRunView();
  renderLibrary();
}

/** Asks before dropping runs that were never saved. */
function canLeaveScene(): boolean {
  if (state.scene.kind !== 'captured' || !state.runs.length) return true;
  const n = state.runs.length;
  return confirm(
    `Drop ${n} unsaved run${n === 1 ? '' : 's'}? Save the scenario first to keep them.`,
  );
}

async function capture(): Promise<void> {
  if (!canLeaveScene()) return;
  const images = await snapshots();
  if (images) setScene({ kind: 'captured', images, at: new Date() });
}

function backToLive(): void {
  if (!canLeaveScene()) return;
  state.revise = null;
  setScene({ kind: 'live' });
  fillSaveForm(null);
}

async function loadScenario(id: string): Promise<void> {
  if (state.scene.kind === 'scenario' && state.scene.scenario.id === id) return;
  if (!canLeaveScene()) return;
  try {
    const detail = await api.scenario(id);
    state.revise = null;
    setScene({ kind: 'scenario', scenario: detail.scenario });
    state.runs = detail.runs;
    state.runId = detail.runs[0]?.id ?? null;
    input('#goal').value = detail.scenario.goal;
    textarea('#context').value = detail.scenario.context ?? '';
    fillSaveForm(detail.scenario);
    renderChips();
    renderRunView();
  } catch (err) {
    toast(`Could not load the scenario: ${message(err)}`);
  }
}

function fillSaveForm(scenario: BenchScenario | null): void {
  input('#title').value = scenario?.title ?? '';
  textarea('#expect').value = scenario?.expect.join('\n') ?? '';
  input('#tags').value = scenario?.tags.join(', ') ?? '';
}

/** The frames of the current scene as payloads (a saved scenario's are fetched once). */
async function sceneImages(): Promise<ImagePayload[] | null> {
  const scene = state.scene;
  if (scene.kind === 'captured') return scene.images;
  if (scene.kind === 'live') return null;
  const cached = scenarioImages.get(scene.scenario.id);
  if (cached) return cached;
  const images = await Promise.all(
    scene.scenario.views.map(async (view, i) => {
      const blob = await (await fetch(api.viewUrl(scene.scenario.id, i + 1))).blob();
      return { mimeType: view.mimeType, data: await base64(blob) };
    }),
  );
  scenarioImages.set(scene.scenario.id, images);
  return images;
}

function renderScene(): void {
  const scene = state.scene;
  const frames =
    scene.kind === 'captured'
      ? scene.images.map((img) => `data:${img.mimeType};base64,${img.data}`)
      : scene.kind === 'scenario'
        ? scene.scenario.views.map((_, i) => api.viewUrl(scene.scenario.id, i + 1))
        : [];
  const frame = document.querySelector<HTMLImageElement>('#frame');
  if (!frame) return;
  const live = frames.length === 0 || state.watch !== null;
  video().hidden = !live;
  frame.hidden = live;
  if (!live) frame.src = frames[Math.min(state.shown, frames.length - 1)] ?? '';
  $('#scene-badge').textContent =
    scene.kind === 'live'
      ? `Live${webcam ? ` · ${webcam.size}` : ''}`
      : scene.kind === 'captured'
        ? `Captured ${scene.at.toLocaleTimeString()} · frame ${state.shown + 1} of ${frames.length}`
        : `Saved · frame ${state.shown + 1} of ${frames.length}`;
  $('#scene-badge').className = `scene-badge ${scene.kind}`;
  if (state.watch) updateWatchBadge(state.watch);
  $('#thumbs').innerHTML = frames
    .map(
      (src, i) =>
        `<button type="button" class="thumb${i === state.shown ? ' on' : ''}" data-frame="${i}"><img src="${esc(src)}" alt="Frame ${i + 1}"></button>`,
    )
    .join('');
  button('#capture').disabled = !webcam;
  button('#live').disabled = scene.kind === 'live';
  button('#plan').textContent =
    scene.kind === 'live'
      ? 'Capture & plan'
      : scene.kind === 'captured'
        ? 'Plan these frames'
        : 'Run this scenario';
  const revise = scene.kind === 'scenario' ? scene.scenario.revise : state.revise;
  const notes: string[] = [];
  if (scene.kind === 'scenario') {
    notes.push(
      `<p class="note scenario-note">Scenario <strong>${esc(scene.scenario.title)}</strong>. Runs are saved with it; edits to the goal and the fields below are saved before each run.</p>`,
    );
  }
  if (revise) {
    notes.push(
      `<p class="note revise-note">Re-plan of <strong>${esc(revise.base.title)}</strong> from step ${revise.fromStepIndex + 1}: <q>${esc(revise.reason)}</q>${scene.kind === 'scenario' ? '' : ' <button type="button" class="link" id="clear-revise">plan from scratch instead</button>'}</p>`,
    );
  }
  $('#scene-note').innerHTML = notes.join('');
  document.querySelector('#clear-revise')?.addEventListener('click', () => {
    state.revise = null;
    renderScene();
  });
  $('#save-title').textContent =
    scene.kind === 'scenario' ? 'Scenario details' : 'Save as a scenario';
  button('#save-btn').textContent = scene.kind === 'scenario' ? 'Save changes' : 'Save scenario';
  button('#save-btn').disabled = scene.kind === 'live';
  button('#delete').hidden = scene.kind !== 'scenario';
  renderOverlay();
}

/** Draws where the selected run's planner saw its objects, over the frame shown. */
function renderOverlay(): void {
  const overlay = document.querySelector<HTMLElement>('#overlay');
  const frame = document.querySelector<HTMLImageElement>('#frame');
  if (!overlay || !frame) return;
  const run = selectedRun();
  const result = run?.result.ok ? run.result : null;
  const sightings = result?.sightings ?? [];
  const row = $('#sightings-row');
  row.hidden = sightings.length === 0 || frame.hidden;
  const here = sightings.filter((s) => s.view === state.shown).length;
  $('#sightings-count').textContent = `(${here} in this frame, ${sightings.length} in all)`;
  const show = result && !row.hidden && input('#sightings-on').checked && frame.naturalWidth > 0;
  overlay.innerHTML = show
    ? renderSightings(sightings, result.procedure.objects, state.shown, {
        width: frame.naturalWidth,
        height: frame.naturalHeight,
      })
    : '';
}

// ---------------------------------------------------------------------------------------------
// Planning

async function plan(): Promise<void> {
  const goal = input('#goal').value.trim();
  if (goal.length < 3) return toast('Write a goal first.');
  const models = state.selected;
  if (!models.length) return toast('Pick at least one model.');
  if (state.scene.kind === 'scenario') return runScenario(state.scene.scenario, models);
  if (state.scene.kind === 'live') {
    const images = await snapshots();
    if (!images) return;
    setScene({ kind: 'captured', images, at: new Date() });
  }
  if (state.scene.kind !== 'captured') return;
  const context = textarea('#context').value.trim();
  const revise = state.revise;
  const body: BenchPlanRequest = {
    goal,
    ...(context ? { context } : {}),
    images: state.scene.images,
    ...(revise
      ? {
          revise: {
            planId: revise.base.id,
            fromStepIndex: revise.fromStepIndex,
            reason: revise.reason,
            base: revise.base,
          },
        }
      : {}),
  };
  const budget = budgetMs();
  const ask = (model: string, stage?: PlanStage, rest?: BenchRevise) => () =>
    api.benchPlan({
      ...body,
      ...(stage ? { stage } : {}),
      ...(rest
        ? {
            revise: {
              planId: rest.base.id,
              fromStepIndex: rest.fromStepIndex,
              reason: rest.reason,
              base: rest.base,
            },
          }
        : {}),
      model,
      ...(budget === undefined ? {} : { budgetMs: budget }),
    });
  await Promise.all(
    models.map((model) =>
      twoStages()
        ? planInStages(model, (stage, rest) => ask(model, stage, rest)())
        : track(model, ask(model)),
    ),
  );
}

async function runScenario(scenario: BenchScenario, models: string[]): Promise<void> {
  const saved = await saveScenarioEdits(scenario);
  if (!saved) return;
  const budget = budgetMs();
  await Promise.all(
    models.map((model) =>
      twoStages()
        ? planInStages(model, (stage, revise) =>
            api.runScenario(saved.id, model, budget, { stage, ...(revise ? { revise } : {}) }),
          )
        : track(model, () => api.runScenario(saved.id, model, budget)),
    ),
  );
  await refreshLibrary();
}

function twoStages(): boolean {
  return input('#two-stage').checked;
}

/**
 * A plan in two stages, as the headset would make it: stage 1 writes step 1 in full and the rest
 * as an outline; as soon as it is in, the rest stage rewrites the outline from the same frames.
 */
async function planInStages(
  model: string,
  ask: (stage: PlanStage, rest?: BenchRevise) => Promise<BenchRun>,
): Promise<void> {
  const sceneKey = state.sceneKey;
  const first = await track(model, () => ask('first'), { stage: 'first' });
  if (!first || state.sceneKey !== sceneKey) return;
  const rest = restRevise(first);
  if (!rest) {
    if (first.result.ok && first.result.outlineFrom === undefined) {
      toast(
        `${shortModel(model)} answered stage 1 with a whole plan: there is no outline to refine.`,
      );
    }
    return;
  }
  const refined = await track(model, () => ask('rest', rest), { stage: 'rest', after: first.id });
  if (refined) onRefined(first, refined);
}

/**
 * The rest of a two-stage plan came in: show it instead of stage 1, and if stage 1 is being
 * watched live, swap the refined steps in for the ones not done yet without losing progress.
 */
function onRefined(first: BenchRun, rest: BenchRun): void {
  const from = first.result.ok ? first.result.outlineFrom : undefined;
  if (rest.result.ok && from !== undefined) {
    if (state.runId === first.id) state.runId = rest.id;
    const watch = state.watch;
    if (watch?.runId === first.id) {
      watch.session.refine(rest.result.procedure.steps, from, Date.now());
      watch.runId = rest.id;
      watch.procedure = rest.result.procedure;
      watch.title = rest.result.procedure.title;
      watch.suggest = false;
      void keepBefore(watch);
      renderWatch(true);
      toast('The rest of the plan is refined: the steps not done yet are the refined ones now.');
    }
  }
  renderChips();
  renderRunView();
}

/** Shows a run in flight, then adds its answer to the scene it was asked for. */
async function track(
  model: string,
  ask: () => Promise<BenchRun>,
  options: { stage?: PlanStage; after?: string } = {},
): Promise<BenchRun | null> {
  const sceneKey = state.sceneKey;
  const pending: Pending = { key: ++pendingKey, model, started: performance.now(), ...options };
  state.pending.push(pending);
  startTicker();
  renderChips();
  if (!selectedRun() || (options.after && options.after === state.runId)) renderRunView();
  try {
    const run = await ask();
    if (state.sceneKey !== sceneKey) return null;
    state.runs.unshift(run);
    if (!state.runId || !state.runs.some((r) => r.id === state.runId)) state.runId = run.id;
    else if (state.pending.length === 1 && state.runs.length === 1) state.runId = run.id;
    renderRunView();
    return run;
  } catch (err) {
    if (state.sceneKey === sceneKey) toast(`${model}: ${message(err)}`);
    return null;
  } finally {
    state.pending = state.pending.filter((p) => p.key !== pending.key);
    renderChips();
  }
}

function startTicker(): void {
  if (ticker) return;
  ticker = setInterval(() => {
    if (!state.pending.length && ticker) {
      clearInterval(ticker);
      ticker = null;
    }
    renderChips();
  }, 200);
}

async function replanFrom(stepIndex: number, reason: string): Promise<void> {
  const run = selectedRun();
  if (!run?.result.ok) return;
  if (!canLeaveScene()) return;
  const images = webcam ? await snapshots() : await sceneImages();
  if (!images) return;
  state.revise = { base: run.result.procedure, fromStepIndex: stepIndex, reason };
  fillSaveForm(null);
  setScene({ kind: 'captured', images, at: new Date() });
  await plan();
}

// ---------------------------------------------------------------------------------------------
// The run view: grades, the judge, step checks

/** The planning budget when slow models get more time than the headset gives them. */
function budgetMs(): number | undefined {
  return input('#slow').checked ? SLOW_BUDGET_MS : undefined;
}

function selectedRun(): BenchRun | undefined {
  return state.runs.find((r) => r.id === state.runId);
}

function savedScenario(): BenchScenario | null {
  return state.scene.kind === 'scenario' ? state.scene.scenario : null;
}

function renderChips(): void {
  const now = performance.now();
  const goal = input('#goal')?.value.trim();
  const pending = state.pending.map((p) => ({
    model: p.model,
    elapsedMs: now - p.started,
    ...(p.stage ? { stage: p.stage } : {}),
    ...(p.after ? { after: p.after } : {}),
  }));
  $('#chips').innerHTML = renderChipList(state.runs, pending, {
    selected: state.runId,
    ...(goal === undefined ? {} : { goal }),
  });
}

/** The two stages a run belongs to, when it is one of a two-stage plan. */
function stageViewOf(run: BenchRun): StageView | undefined {
  const pairs = pairStages(state.runs);
  if (run.request.stage === 'first') {
    const rest = pairs.get(run.id);
    const refining = state.pending.some((p) => p.after === run.id);
    return { first: run, ...(rest ? { rest } : {}), refining };
  }
  if (run.request.stage !== 'rest') return undefined;
  const first = state.runs.find((r) => r.id === firstOf(pairs, run));
  return first ? { first, rest: run, refining: false } : undefined;
}

/** Steps a plan starts with done when watched: those kept from before a re-plan. */
function doneBeforeOf(run: BenchRun): number {
  if (run.request.stage !== 'rest') return run.request.revise?.fromStepIndex ?? 0;
  const first = state.runs.find((r) => r.id === firstOf(pairStages(state.runs), run));
  return first?.request.revise?.fromStepIndex ?? 0;
}

function renderRunView(): void {
  const run = selectedRun();
  const view = $('#run');
  if (!run) {
    view.innerHTML = state.pending.length
      ? '<p class="empty">Planning…</p>'
      : `<div class="empty">
          <h2>Put the planner in a difficult spot</h2>
          <p>Set up a scene in front of the camera, write a goal on the left and press <strong>Capture &amp; plan</strong>. Tick more models to compare them on the same frames.</p>
          <p>Ideas: look-alike distractors, a task that is already half done, something missing or broken, a hazard in view, a goal that doesn't fit the scene. Then re-plan from a step after changing the scene.</p>
          <p>Save the scenes worth keeping with what a correct plan must do. The judge grades runs against those expectations, and <strong>Run all shown</strong> replays every saved scene.</p>
        </div>`;
    renderOverlay();
    return;
  }
  const scenario = savedScenario();
  const stage = stageViewOf(run);
  view.innerHTML = renderRun(run, {
    saved: scenario !== null,
    judgeBlocked: judgeBlocked(run, scenario),
    judgeModel: state.judgeModel || state.models?.judgeModel || 'judge',
    judging: state.judging.has(run.id),
    checks: state.checks.get(run.id) ?? new Map(),
    watching: state.watch?.runId === run.id,
    canWatch: webcam !== null && state.models !== null,
    ...(stage ? { stage } : {}),
  });
  applyWatchBadges();
  renderOverlay();
}

function judgeBlocked(run: BenchRun, scenario: BenchScenario | null): string | null {
  if (!state.models) return 'Gemini is off.';
  if (!run.result.ok) return 'There is no plan to judge.';
  if (!scenario) return 'Save the scenario to judge its runs.';
  if (!expectLines().length) return 'Write what a correct plan must do, then judge.';
  return null;
}

async function grade(g: 'pass' | 'partial' | 'fail'): Promise<void> {
  const run = selectedRun();
  if (!run) return;
  const notes = document.querySelector<HTMLInputElement>('#run .grade-notes')?.value.trim() ?? '';
  const verdict = run.verdict?.grade === g ? null : { grade: g, ...(notes ? { notes } : {}) };
  await setVerdict(run, verdict);
}

async function saveNotes(notes: string): Promise<void> {
  const run = selectedRun();
  if (!run?.verdict) return;
  const trimmed = notes.trim();
  await setVerdict(run, { grade: run.verdict.grade, ...(trimmed ? { notes: trimmed } : {}) });
}

async function setVerdict(
  run: BenchRun,
  verdict: { grade: 'pass' | 'partial' | 'fail'; notes?: string } | null,
): Promise<void> {
  const scenario = savedScenario();
  try {
    let next: BenchRun;
    if (scenario) {
      next = await api.gradeRun(scenario.id, run.id, verdict);
    } else {
      const { verdict: _old, ...rest } = run;
      next = verdict ? { ...rest, verdict: { ...verdict, at: new Date().toISOString() } } : rest;
    }
    replaceRun(next);
    if (scenario) await refreshLibrary();
  } catch (err) {
    toast(`Could not save the grade: ${message(err)}`);
  }
}

async function judge(): Promise<void> {
  const run = selectedRun();
  const scenario = savedScenario();
  if (!run || !scenario) return;
  const saved = await saveScenarioEdits(scenario);
  if (!saved) return;
  state.judging.add(run.id);
  renderRunView();
  try {
    replaceRun(await api.judgeRun(saved.id, run.id, state.judgeModel));
    await refreshLibrary();
  } catch (err) {
    toast(`Judge: ${message(err)}`);
  } finally {
    state.judging.delete(run.id);
    renderRunView();
  }
}

function replaceRun(run: BenchRun): void {
  state.runs = state.runs.map((r) => (r.id === run.id ? run : r));
  renderChips();
  renderRunView();
}

/** Asks the step watcher's question about one step, on fresh frames from the camera. */
async function checkStep(stepIndex: number): Promise<void> {
  const run = selectedRun();
  if (!run?.result.ok) return;
  const step = run.result.procedure.steps[stepIndex];
  if (!step) return;
  const checks = state.checks.get(run.id) ?? new Map<number, StepCheckState>();
  state.checks.set(run.id, checks);
  checks.set(stepIndex, { pending: true });
  renderStepCheck(run.id, stepIndex);
  try {
    const images = webcam ? await snapshots() : await sceneImages();
    if (!images) throw new Error('no frames');
    const { objects, confusions } = stepCheckHints(run.result.procedure, stepIndex);
    const result = await api.benchCheck({
      goal: run.request.goal,
      step: {
        id: step.id,
        instruction: step.instruction,
        ...(step.doneWhen ? { doneWhen: step.doneWhen } : {}),
      },
      images,
      ...(objects.length ? { objects } : {}),
      ...(confusions.length ? { confusions } : {}),
      model: run.model,
    });
    checks.set(stepIndex, { pending: false, result });
  } catch (err) {
    checks.set(stepIndex, { pending: false, error: message(err) });
  }
  renderStepCheck(run.id, stepIndex);
}

/** Re-renders the run view only if it still shows that run, keeping what is typed elsewhere. */
function renderStepCheck(runId: string, _stepIndex: number): void {
  if (state.runId !== runId) return;
  const typing = document.activeElement;
  if (typing instanceof HTMLInputElement && typing.closest('#run')) return;
  renderRunView();
}

// ---------------------------------------------------------------------------------------------
// Watching live: follow a plan step by step while you do it in front of the camera

function startWatch(): void {
  const run = selectedRun();
  if (!run?.result.ok) return;
  if (!webcam) {
    toast('Watching needs the live camera. Allow camera access and reload.');
    return;
  }
  stopWatch();
  const now = Date.now();
  const procedure = run.result.procedure;
  const watch: Watch = {
    runId: run.id,
    title: procedure.title,
    goal: run.request.goal,
    procedure,
    session: new WatchSession(procedure.steps, now, doneBeforeOf(run)),
    model: run.model,
    intervalMs: prefs.watchEveryMs,
    autoAdvance: prefs.watchAuto,
    needed: prefs.watchInARow,
    paused: false,
    looking: false,
    suggest: false,
    before: null,
    saving: null,
    timer: null,
    clock: setInterval(() => renderWatchStatusOnly(), 1000),
  };
  state.watch = watch;
  $('#watch').innerHTML = `
    <section class="watch">
      <div id="watch-status"></div>
      <div id="watch-controls" class="watch-controls"></div>
      <details id="watch-log" class="watch-log"></details>
      <div id="watch-save"></div>
    </section>`;
  void keepBefore(watch);
  renderWatch(true);
  renderScene();
  renderRunView();
  $('#watch').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  scheduleLook(1500);
}

function stopWatch(): void {
  const watch = state.watch;
  if (!watch) return;
  if (watch.timer) clearTimeout(watch.timer);
  clearInterval(watch.clock);
  state.watch = null;
  $('#watch').innerHTML = '';
  renderScene();
  if (state.runs.some((r) => r.id === watch.runId)) renderRunView();
}

function scheduleLook(delayMs: number): void {
  const watch = state.watch;
  if (!watch) return;
  if (watch.timer) clearTimeout(watch.timer);
  watch.timer = setTimeout(() => void look(watch), delayMs);
}

/** Keeps a frame from the moment the focused step gained focus, to send with its looks. */
async function keepBefore(watch: Watch): Promise<Watch['before']> {
  const turn = watch.session.focusTurn;
  if (watch.before?.turn === turn) return watch.before;
  if (!webcam || watch.session.focus === null) return null;
  const [image] = await webcam.snapshots(1).catch(() => []);
  if (!image || state.watch !== watch || watch.session.focusTurn !== turn) return null;
  watch.before = { turn, image, url: dataUrl(image) };
  return watch.before;
}

/**
 * One look at the focused step. It sends the frame from when the step gained focus, what the
 * step's objects look like and its likely mix-ups. The next look starts a moment after the
 * answer, or `intervalMs` after this one started.
 */
async function look(watch: Watch): Promise<void> {
  watch.timer = null;
  const { session } = watch;
  if (state.watch !== watch || watch.paused || watch.looking || session.focus === null) return;
  if (document.hidden) return; // picks up again when the page is shown
  const stepIndex = session.focus;
  const step = session.steps[stepIndex];
  if (!step || !webcam) return;
  const started = performance.now();
  watch.looking = true;
  renderWatchStatusOnly();
  const before = await keepBefore(watch);
  const asked: LookAsked = {
    step: {
      id: step.id,
      instruction: step.instruction,
      ...(step.doneWhen ? { doneWhen: step.doneWhen } : {}),
    },
    ...stepCheckHints({ ...watch.procedure, steps: session.steps }, stepIndex),
  };
  let entry: WatchLook;
  let image: ImagePayload | undefined;
  try {
    [image] = await webcam.snapshots(1);
    if (!image) throw new Error('no frame');
    const answer = await api.benchCheck({
      goal: watch.goal,
      step: asked.step,
      images: [image],
      ...(before ? { before: [before.image] } : {}),
      ...(asked.objects.length ? { objects: asked.objects } : {}),
      ...(asked.confusions.length ? { confusions: asked.confusions } : {}),
      model: watch.model,
    });
    entry = {
      at: Date.now(),
      step: stepIndex,
      verdict: answer.verdict,
      observation: answer.observation,
      latencyMs: answer.latencyMs,
      model: answer.model,
      ...(answer.progress === undefined ? {} : { progress: answer.progress }),
      ...(answer.wrong?.trim() ? { wrong: answer.wrong.trim() } : {}),
      ...(answer.evidence ? { evidence: answer.evidence } : {}),
      ...(answer.hazard?.trim() ? { hazard: answer.hazard.trim() } : {}),
    };
  } catch (err) {
    entry = { at: Date.now(), step: stepIndex, error: message(err), model: watch.model };
  }
  entry.asked = asked;
  if (image) entry.image = dataUrl(image);
  if (before) entry.before = before.url;
  watch.looking = false;
  if (state.watch !== watch) return;
  const outcome = session.record(entry, { autoAdvance: watch.autoAdvance, needed: watch.needed });
  watch.suggest = outcome.suggest;
  if (outcome.advanced) void keepBefore(watch);
  renderWatch(outcome.advanced);
  if (outcome.advanced) flashWatch();
  if (!session.complete && !watch.paused && !watch.timer) {
    const took = performance.now() - started;
    scheduleLook(nextLookDelay(watch.intervalMs, took, entry.error !== undefined));
  }
}

function onWatchClick(e: Event): void {
  const watch = state.watch;
  const target = (e.target as HTMLElement).closest<HTMLElement>('button[data-watch]');
  if (!watch || !target) return;
  const { session } = watch;
  const now = Date.now();
  const focus = session.focus;
  const action = target.dataset.watch ?? '';
  switch (action) {
    case 'stop':
      stopWatch();
      return;
    case 'save-test':
      watch.saving = session.looks.find((l) => String(l.n) === target.dataset.look) ?? null;
      renderSaveForm(true);
      return;
    case 'save-cancel':
      watch.saving = null;
      renderSaveForm(false);
      return;
    case 'pause':
      watch.paused = !watch.paused;
      if (!watch.paused) scheduleLook(300);
      break;
    case 'look':
      watch.paused = false;
      scheduleLook(0);
      break;
    case 'done':
      if (focus !== null) session.markDone(focus, now);
      break;
    case 'skip':
      if (focus !== null) session.skip(focus, now);
      break;
    case 'back':
      session.back(now);
      break;
    case 'focus':
      session.focusOn(Number(target.dataset.step), now);
      break;
  }
  if (['done', 'skip', 'back', 'focus'].includes(action)) {
    watch.suggest = false;
    void keepBefore(watch);
    if (!watch.paused && !session.complete) scheduleLook(nextLookDelay(watch.intervalMs, 0));
  }
  renderWatch(true);
}

/** The form that keeps a look as a watcher test, under the log. */
function renderSaveForm(scroll: boolean): void {
  const watch = state.watch;
  const el = document.querySelector<HTMLElement>('#watch-save');
  if (!el) return;
  el.innerHTML = watch?.saving ? renderSaveTest(watch.saving, watch.goal) : '';
  if (scroll && watch?.saving) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/** Saves the look whose form is open as a watcher test, with the answer it should have given. */
async function saveLookAsTest(form: HTMLFormElement): Promise<void> {
  const watch = state.watch;
  const look = watch?.saving;
  if (!watch || !look?.asked || !look.image) return;
  const data = new FormData(form);
  const expect = data.get('expect')?.toString() as BenchCheckExpect | undefined;
  const title = data.get('title')?.toString().trim() ?? '';
  if (!expect || !title) return toast('Pick the answer it should have given, and give it a title.');
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (submit) submit.disabled = true;
  const { step, objects, confusions } = look.asked;
  const seen =
    look.verdict && look.model
      ? {
          verdict: look.verdict,
          observation: look.observation ?? '',
          model: look.model,
          latencyMs: look.latencyMs ?? 0,
          ...(look.progress === undefined ? {} : { progress: look.progress }),
          ...(look.wrong ? { wrong: look.wrong } : {}),
          ...(look.evidence ? { evidence: look.evidence } : {}),
        }
      : undefined;
  try {
    const detail = await api.createCheckTest({
      title,
      expect,
      goal: watch.goal,
      step,
      images: [payloadOf(look.image)],
      ...(look.before ? { before: [payloadOf(look.before)] } : {}),
      ...(objects.length ? { objects } : {}),
      ...(confusions.length ? { confusions } : {}),
      ...(seen ? { seen } : {}),
    });
    if (state.watch === watch && watch.saving === look) {
      watch.saving = null;
      renderSaveForm(false);
    }
    toast(`Saved the watcher test “${detail.test.title}”: it should say ${expectText(expect)}.`);
    await refreshTests();
  } catch (err) {
    toast(`Could not save the watcher test: ${message(err)}`);
    if (submit) submit.disabled = false;
  }
}

function onWatchChange(e: Event): void {
  const watch = state.watch;
  const target = e.target as HTMLInputElement | HTMLSelectElement;
  if (!watch || !target.dataset.watch) return;
  switch (target.dataset.watch) {
    case 'interval': {
      const ms = Number(target.value);
      watch.intervalMs = Number.isFinite(ms) && ms >= 0 ? ms : AS_FAST_AS_IT_ANSWERS;
      if (!watch.looking && !watch.paused) scheduleLook(nextLookDelay(watch.intervalMs, 0));
      break;
    }
    case 'model':
      watch.model = target.value;
      break;
    case 'auto':
      watch.autoAdvance = (target as HTMLInputElement).checked;
      break;
    case 'needed':
      watch.needed = Number(target.value) || 1;
      break;
  }
  savePrefs();
  renderWatchStatusOnly();
}

/** Redraws the panel; the controls only when asked, so an open dropdown stays open. */
function renderWatch(withControls: boolean): void {
  const watch = state.watch;
  if (!watch) return;
  renderWatchStatusOnly();
  if (withControls) {
    const models = state.models?.models ?? [];
    $('#watch-controls').innerHTML = renderWatchControls({
      paused: watch.paused,
      complete: watch.session.complete,
      intervalMs: watch.intervalMs,
      autoAdvance: watch.autoAdvance,
      needed: watch.needed,
      model: watch.model,
      models: models.includes(watch.model) ? models : [watch.model, ...models],
    });
  }
  const log = document.querySelector<HTMLDetailsElement>('#watch-log');
  if (log) {
    const open = log.open;
    log.innerHTML = renderWatchLog(watch.session);
    log.open = open;
    log.hidden = watch.session.looks.length === 0;
  }
  applyWatchBadges();
}

function renderWatchStatusOnly(): void {
  const watch = state.watch;
  const el = document.querySelector<HTMLElement>('#watch-status');
  if (!watch || !el) return;
  el.innerHTML = renderWatchStatus(watch.session, watch.title, {
    now: Date.now(),
    paused: watch.paused,
    looking: watch.looking,
    needed: watch.needed,
    suggest: watch.suggest,
  });
  updateWatchBadge(watch);
}

/** Marks the watched plan's steps in its run view: done, skipped, or being done now. */
function applyWatchBadges(): void {
  const watch = state.watch;
  for (const card of document.querySelectorAll<HTMLElement>('#run .step')) {
    const i = Number(card.dataset.step);
    const progress = watch?.runId === state.runId ? watch.session.progress[i] : undefined;
    const focused = progress !== undefined && watch?.session.focus === i;
    card.classList.toggle('watch-now-step', focused);
    card.classList.toggle('watch-done-step', progress?.status === 'done');
    const slot = card.querySelector('.watch-status');
    if (slot) slot.innerHTML = progress ? stepBadge(progress, focused) : '';
  }
}

function updateWatchBadge(watch: Watch): void {
  const focus = watch.session.focus;
  const where = focus === null ? '' : ` · step ${focus + 1} of ${watch.session.steps.length}`;
  $('#scene-badge').textContent =
    `${watchState(watch.session, watch.paused, watch.looking)}${where}`;
  $('#scene-badge').className = 'scene-badge live';
}

/** A short highlight when the watcher moves on to the next step by itself. */
function flashWatch(): void {
  const panel = document.querySelector<HTMLElement>('#watch .watch');
  if (!panel) return;
  panel.classList.remove('advanced');
  void panel.offsetWidth;
  panel.classList.add('advanced');
}

// ---------------------------------------------------------------------------------------------
// Saving and the scenario library

function expectLines(): string[] {
  return textarea('#expect')
    .value.split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

function tagList(): string[] {
  return input('#tags')
    .value.split(',')
    .map((t) =>
      t
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, ''),
    )
    .filter(Boolean)
    .slice(0, 10);
}

async function save(): Promise<void> {
  const scene = state.scene;
  if (scene.kind === 'scenario') {
    if (await saveScenarioEdits(scene.scenario)) toast('Saved.');
    return;
  }
  if (scene.kind !== 'captured') return toast('Capture a scene first.');
  const goal = input('#goal').value.trim();
  if (goal.length < 3) return toast('Write a goal first.');
  const context = textarea('#context').value.trim();
  const title = input('#title').value.trim() || goal;
  const revise = state.revise;
  // Only runs that asked what the scenario asks belong to it, and the rest stages that refined them.
  const asked = state.runs.filter(
    (r) =>
      r.request.goal === goal &&
      (r.request.context ?? '') === context &&
      r.request.stage !== 'rest' &&
      r.request.revise?.fromStepIndex === revise?.fromStepIndex &&
      r.request.revise?.reason === revise?.reason,
  );
  const pairs = pairStages(state.runs);
  const refined = asked.flatMap((r) => pairs.get(r.id) ?? []);
  const runs = state.runs.filter((r) => asked.includes(r) || refined.includes(r));
  try {
    const detail = await api.createScenario({
      title: title.slice(0, 120),
      goal,
      ...(context ? { context } : {}),
      ...(revise ? { revise } : {}),
      expect: expectLines(),
      tags: tagList(),
      images: scene.images,
      runs,
    });
    const dropped = state.runs.length - runs.length;
    const selected = state.runId;
    state.revise = null;
    setScene({ kind: 'scenario', scenario: detail.scenario });
    state.runs = detail.runs;
    state.runId = detail.runs.some((r) => r.id === selected)
      ? selected
      : (detail.runs[0]?.id ?? null);
    fillSaveForm(detail.scenario);
    renderChips();
    renderRunView();
    await refreshLibrary();
    toast(
      `Saved “${detail.scenario.title}”.${dropped ? ` ${dropped} run${dropped === 1 ? '' : 's'} with another goal or context were not kept.` : ''}`,
    );
  } catch (err) {
    toast(`Could not save: ${message(err)}`);
  }
}

/** Saves what changed in the form; returns the scenario as stored, or null when saving failed. */
async function saveScenarioEdits(scenario: BenchScenario): Promise<BenchScenario | null> {
  const goal = input('#goal').value.trim();
  const context = textarea('#context').value.trim();
  const title = input('#title').value.trim() || scenario.title;
  const expect = expectLines();
  const tags = tagList();
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
  const patch = {
    ...(title !== scenario.title ? { title } : {}),
    ...(goal !== scenario.goal ? { goal } : {}),
    ...(context !== (scenario.context ?? '') ? { context: context || null } : {}),
    ...(!same(expect, scenario.expect) ? { expect } : {}),
    ...(!same(tags, scenario.tags) ? { tags } : {}),
  };
  if (!Object.keys(patch).length) return scenario;
  try {
    const updated = await api.updateScenario(scenario.id, patch);
    if (state.scene.kind === 'scenario' && state.scene.scenario.id === updated.id) {
      state.scene = { kind: 'scenario', scenario: updated };
      renderScene();
    }
    await refreshLibrary();
    return updated;
  } catch (err) {
    toast(`Could not save the scenario: ${message(err)}`);
    return null;
  }
}

async function deleteScenario(): Promise<void> {
  const scenario = savedScenario();
  if (!scenario) return;
  if (!confirm(`Delete “${scenario.title}”? It moves to data/bench/deleted/.`)) return;
  try {
    await api.deleteScenario(scenario.id);
    backToLive();
    await refreshLibrary();
  } catch (err) {
    toast(`Could not delete: ${message(err)}`);
  }
}

async function refreshLibrary(): Promise<void> {
  try {
    state.library = (await api.scenarios()).scenarios;
  } catch {
    state.library = [];
  }
  renderLibrary();
}

function filteredLibrary(): BenchScenarioSummary[] {
  const words = input('#lib-filter').value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return state.library.filter((s) => {
    const text = `${s.title} ${s.goal} ${s.tags.join(' ')}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

function renderLibrary(): void {
  const shown = filteredLibrary();
  const active = state.scene.kind === 'scenario' ? state.scene.scenario.id : null;
  $('#lib-count').textContent =
    shown.length === state.library.length
      ? `(${state.library.length})`
      : `(${shown.length} of ${state.library.length})`;
  $('#library').innerHTML = shown.length
    ? shown.map((s) => renderScenarioItem(s, api.viewUrl(s.id, 1), s.id === active)).join('')
    : `<li class="muted empty-list">${state.library.length ? 'Nothing matches.' : 'No saved scenarios yet.'}</li>`;
  button('#run-all').disabled = !state.batch && (!shown.length || !state.models);
}

/** Runs every scenario in the list with every selected model, one at a time, and judges each. */
async function runAll(): Promise<void> {
  if (state.batch) {
    state.batch.stop = true;
    return;
  }
  const scenarios = filteredLibrary();
  const models = state.selected;
  const withJudge = input('#run-all-judge').checked;
  if (!scenarios.length || !models.length) return;
  const batch: Batch = {
    done: 0,
    total: scenarios.length * models.length,
    label: '',
    stop: false,
    planned: 0,
    judged: 0,
    passed: 0,
  };
  state.batch = batch;
  button('#run-all').textContent = 'Stop';
  for (const s of scenarios) {
    for (const model of models) {
      if (batch.stop) break;
      batch.label = `${s.title} · ${shortModel(model)}`;
      renderBatch();
      try {
        let run = await api.runScenario(s.id, model, budgetMs());
        if (run.result.ok) batch.planned++;
        if (withJudge && s.expectCount > 0 && run.result.ok) {
          run = await api.judgeRun(s.id, run.id, state.judgeModel);
          batch.judged++;
          if (run.judgement?.passed) batch.passed++;
        }
        if (state.scene.kind === 'scenario' && state.scene.scenario.id === s.id) {
          state.runs.unshift(run);
          renderChips();
        }
      } catch (err) {
        toast(`${s.title} with ${model}: ${message(err)}`);
      }
      batch.done++;
      await refreshLibrary();
    }
  }
  state.batch = null;
  button('#run-all').textContent = 'Run all shown';
  $('#batch').hidden = false;
  $('#batch').textContent =
    `${batch.stop ? 'Stopped after' : 'Done:'} ${batch.done} run${batch.done === 1 ? '' : 's'}, ${batch.planned} planned` +
    (withJudge ? `, ${batch.passed} of ${batch.judged} judged passed` : '');
  renderLibrary();
}

function renderBatch(): void {
  const batch = state.batch;
  const el = $('#batch');
  el.hidden = !batch;
  if (batch) el.textContent = `Running ${batch.done + 1} of ${batch.total}: ${batch.label}…`;
}

// ---------------------------------------------------------------------------------------------
// Watcher tests: looks kept from the live watch, run again with the ticked models

async function refreshTests(): Promise<void> {
  try {
    state.tests = (await api.checkTests()).tests;
  } catch {
    state.tests = [];
  }
  renderTests();
}

function renderTests(): void {
  const open = state.openTest;
  $('#tests-count').textContent = `(${state.tests.length})`;
  $('#tests').innerHTML = state.tests.length
    ? state.tests
        .map((t) =>
          renderCheckTestItem(
            t,
            api.checkFrameUrl(t.id, t.thumb),
            open?.test.id === t.id
              ? renderCheckTestDetail(open, {
                  frameUrl: (file) => api.checkFrameUrl(t.id, file),
                  running: state.testsRunning.get(t.id) ?? [],
                  models: state.selected,
                })
              : undefined,
          ),
        )
        .join('')
    : '<li class="muted empty-list">No watcher tests yet. Watch a plan live and press <strong>Save as test</strong> on a look in <strong>Every look</strong>.</li>';
  button('#tests-run-all').disabled =
    !state.testBatch && (!state.tests.length || !state.models || !state.selected.length);
}

function onTestsClick(e: Event): void {
  const target = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
  const id = target?.dataset.id;
  if (!target || !id) return;
  switch (target.dataset.action) {
    case 'open-test':
      void openTest(id);
      break;
    case 'run-test':
      void runTest(id, state.selected);
      break;
    case 'delete-test':
      void deleteTest(id);
      break;
  }
}

async function openTest(id: string): Promise<void> {
  if (state.openTest?.test.id === id) {
    state.openTest = null;
    return renderTests();
  }
  try {
    state.openTest = await api.checkTest(id);
  } catch (err) {
    toast(`Could not load the watcher test: ${message(err)}`);
  }
  renderTests();
}

/** Asks one watcher test with each model at once; returns how many passed. */
async function runTest(id: string, models: string[]): Promise<number> {
  if (!models.length) {
    toast('Tick a model to run the test with.');
    return 0;
  }
  state.testsRunning.set(id, models);
  renderTests();
  const passes = await Promise.all(
    models.map(async (model) => {
      try {
        return (await api.runCheckTest(id, model)).passed;
      } catch (err) {
        toast(`Watcher test ${id} with ${model}: ${message(err)}`);
        return false;
      }
    }),
  );
  state.testsRunning.delete(id);
  if (state.openTest?.test.id === id) {
    state.openTest = await api.checkTest(id).catch(() => state.openTest);
  }
  await refreshTests();
  return passes.filter(Boolean).length;
}

/** Runs every watcher test with the ticked models, one test at a time. */
async function runAllTests(): Promise<void> {
  if (state.testBatch) {
    state.testBatch.stop = true;
    return;
  }
  const tests = state.tests.map((t) => t.id);
  const models = [...state.selected];
  if (!tests.length || !models.length) return;
  const batch: TestBatch = { done: 0, total: tests.length * models.length, passed: 0, stop: false };
  state.testBatch = batch;
  button('#tests-run-all').textContent = 'Stop';
  const el = $('#tests-batch');
  el.hidden = false;
  for (const id of tests) {
    if (batch.stop) break;
    el.textContent = `Running ${batch.done + 1} of ${batch.total}…`;
    batch.passed += await runTest(id, models);
    batch.done += models.length;
  }
  state.testBatch = null;
  button('#tests-run-all').textContent = 'Run all tests';
  el.textContent = `${batch.stop ? 'Stopped after' : 'Done:'} ${batch.passed} of ${batch.done} passed`;
  renderTests();
}

async function setTestExpect(id: string, expect: BenchCheckExpect): Promise<void> {
  try {
    const test = await api.updateCheckTest(id, { expect });
    if (state.openTest?.test.id === id) state.openTest = { ...state.openTest, test };
    await refreshTests();
  } catch (err) {
    toast(`Could not change the test: ${message(err)}`);
  }
}

async function deleteTest(id: string): Promise<void> {
  const test = state.tests.find((t) => t.id === id);
  if (
    !confirm(`Delete the watcher test “${test?.title ?? id}”? It moves to data/bench/deleted/.`)
  ) {
    return;
  }
  try {
    await api.deleteCheckTest(id);
    if (state.openTest?.test.id === id) state.openTest = null;
    await refreshTests();
  } catch (err) {
    toast(`Could not delete: ${message(err)}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Small helpers

function loadPrefs(): Prefs {
  const defaults: Prefs = {
    goal: '',
    context: '',
    models: [],
    judgeModel: '',
    camera: '',
    frames: 2,
    twoStage: false,
    sightings: true,
    watchEveryMs: AS_FAST_AS_IT_ANSWERS,
    watchAuto: true,
    watchInARow: 2,
  };
  try {
    return {
      ...defaults,
      ...(JSON.parse(localStorage.getItem('clio.bench') ?? '{}') as Partial<Prefs>),
    };
  } catch {
    return defaults;
  }
}

function savePrefs(): void {
  const next: Prefs = {
    goal: input('#goal').value,
    context: textarea('#context').value,
    models: state.selected,
    judgeModel: state.judgeModel,
    camera: webcam?.deviceId ?? prefs.camera,
    frames: Number(select('#frames').value) || 2,
    twoStage: input('#two-stage').checked,
    sightings: input('#sightings-on').checked,
    watchEveryMs: state.watch?.intervalMs ?? prefs.watchEveryMs,
    watchAuto: state.watch?.autoAdvance ?? prefs.watchAuto,
    watchInARow: state.watch?.needed ?? prefs.watchInARow,
  };
  Object.assign(prefs, next);
  try {
    localStorage.setItem('clio.bench', JSON.stringify(next));
  } catch {
    // Private windows may refuse storage; preferences are only a convenience.
  }
}

const dataUrl = (image: ImagePayload) => `data:${image.mimeType};base64,${image.data}`;

/** A frame kept as a data URL, back as an image payload. */
function payloadOf(url: string): ImagePayload {
  const mimeType = url.slice('data:'.length, url.indexOf(';')) as ImagePayload['mimeType'];
  return { mimeType, data: url.slice(url.indexOf(',') + 1) };
}

function base64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;
function toast(text: string): void {
  const el = $('#toast');
  el.textContent = text;
  el.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 7000);
}

function setStatus(text: string, tone: 'ok' | 'bad'): void {
  const el = $('#status');
  el.textContent = text;
  el.className = `status ${tone}`;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

function $(sel: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(sel);
  if (!el) throw new Error(`Missing ${sel}`);
  return el;
}
const input = (sel: string) => $(sel) as HTMLInputElement;
const textarea = (sel: string) => $(sel) as HTMLTextAreaElement;
const select = (sel: string) => $(sel) as HTMLSelectElement;
const button = (sel: string) => $(sel) as HTMLButtonElement;
const form = (sel: string) => $(sel) as HTMLFormElement;
const video = () => $('#video') as HTMLVideoElement;

const root = document.getElementById('bench');
if (root) void init(root);

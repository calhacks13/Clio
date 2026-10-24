import './bench.css';
import type {
  BenchModelsResponse,
  BenchPlanRequest,
  BenchRevise,
  BenchRun,
  BenchScenario,
  BenchScenarioSummary,
  ImagePayload,
} from '@clio/protocol';
import { BenchClient } from './bench-client';
import {
  esc,
  renderPendingChip,
  renderRun,
  renderRunChip,
  renderScenarioItem,
  type StepCheckState,
  shortModel,
} from './plan-view';
import { Webcam } from './webcam';

// The planner bench (bench.html, docs/planner-bench.md). Point the laptop camera at a scene,
// give the planner a goal, and read the plan it writes, from one model or several at once. A
// scene worth keeping becomes a scenario: its frames, its request and what a correct plan must
// do. Saved scenarios can be re-run with any model, graded by hand or by a judge model, and run
// all together after a prompt or model change.

type Scene =
  | { kind: 'live' }
  | { kind: 'captured'; images: ImagePayload[]; at: Date }
  | { kind: 'scenario'; scenario: BenchScenario };

interface Pending {
  key: number;
  model: string;
  started: number;
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
  renderScene();
  renderChips();
  renderRunView();
  await Promise.all([loadModels(), openCamera(prefs.camera || undefined), refreshLibrary()]);
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
          <span id="scene-badge" class="scene-badge">Live</span>
          <p id="camera-error" class="camera-error" hidden></p>
        </div>
        <div id="thumbs" class="thumbs"></div>
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
  $('#model-list').addEventListener('change', () => {
    state.selected = [...document.querySelectorAll<HTMLInputElement>('#model-list input:checked')]
      .map((i) => i.value)
      .filter(Boolean);
    renderModels();
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
    if (!chip?.dataset.run) return;
    state.runId = chip.dataset.run;
    renderChips();
    renderRunView();
  });
  $('#run').addEventListener('click', (e) => onRunClick(e));
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
}

function onRunClick(e: Event): void {
  const target = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
  if (!target) return;
  const step = Number(target.dataset.step);
  switch (target.dataset.action) {
    case 'grade':
      void grade(target.dataset.grade as 'pass' | 'partial' | 'fail');
      break;
    case 'judge':
      void judge();
      break;
    case 'check':
      void checkStep(step);
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
  const live = frames.length === 0;
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
  await Promise.all(
    models.map((model) =>
      track(model, () =>
        api.benchPlan({ ...body, model, ...(budget === undefined ? {} : { budgetMs: budget }) }),
      ),
    ),
  );
}

async function runScenario(scenario: BenchScenario, models: string[]): Promise<void> {
  const saved = await saveScenarioEdits(scenario);
  if (!saved) return;
  const budget = budgetMs();
  await Promise.all(
    models.map((model) => track(model, () => api.runScenario(saved.id, model, budget))),
  );
  await refreshLibrary();
}

/** Shows a run in flight, then adds its answer to the scene it was asked for. */
async function track(model: string, ask: () => Promise<BenchRun>): Promise<void> {
  const sceneKey = state.sceneKey;
  const pending: Pending = { key: ++pendingKey, model, started: performance.now() };
  state.pending.push(pending);
  startTicker();
  renderChips();
  if (!selectedRun()) renderRunView();
  try {
    const run = await ask();
    if (state.sceneKey !== sceneKey) return;
    state.runs.unshift(run);
    if (!state.runId || !state.runs.some((r) => r.id === state.runId)) state.runId = run.id;
    else if (state.pending.length === 1 && state.runs.length === 1) state.runId = run.id;
    renderRunView();
  } catch (err) {
    if (state.sceneKey === sceneKey) toast(`${model}: ${message(err)}`);
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
  const chips = [
    ...state.pending.map((p) => renderPendingChip(p.model, now - p.started)),
    ...state.runs.map((r) =>
      renderRunChip(r, r.id === state.runId, goal !== undefined && r.request.goal !== goal),
    ),
  ];
  $('#chips').innerHTML = chips.join('');
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
    return;
  }
  const scenario = savedScenario();
  view.innerHTML = renderRun(run, {
    saved: scenario !== null,
    judgeBlocked: judgeBlocked(run, scenario),
    judgeModel: state.judgeModel || state.models?.judgeModel || 'judge',
    judging: state.judging.has(run.id),
    checks: state.checks.get(run.id) ?? new Map(),
  });
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
    const result = await api.benchCheck({
      goal: run.request.goal,
      step: {
        id: step.id,
        instruction: step.instruction,
        ...(step.doneWhen ? { doneWhen: step.doneWhen } : {}),
      },
      images,
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
  // Only runs that asked what the scenario asks belong to it.
  const runs = state.runs.filter(
    (r) =>
      r.request.goal === goal &&
      (r.request.context ?? '') === context &&
      r.request.revise?.fromStepIndex === revise?.fromStepIndex &&
      r.request.revise?.reason === revise?.reason,
  );
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
// Small helpers

function loadPrefs(): Prefs {
  const defaults: Prefs = {
    goal: '',
    context: '',
    models: [],
    judgeModel: '',
    camera: '',
    frames: 2,
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
  };
  try {
    localStorage.setItem('clio.bench', JSON.stringify(next));
  } catch {
    // Private windows may refuse storage; preferences are only a convenience.
  }
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

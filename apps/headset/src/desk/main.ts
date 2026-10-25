import './desk.css';
import type { HealthResponse } from '@clio/protocol';
import { ApiClient } from '../adapters/net/api-client';
import { trackerUrl } from '../adapters/net/tracker-client';
import { createLogger } from '../core/log';
import type { LessonPhase } from '../domain/events';
import { readDeskConfig } from './config';
import { DeskCamera } from './desk-camera';
import { type CoachChoice, DeskLab } from './desk-lab';
import { DeskSpeaker } from './desk-speaker';
import { ER_FADE_MS } from './er-boxes';
import { ToolLog, Transcript } from './logs';
import { DeskOverlay, type ErAnswerView } from './overlay';
import {
  type ErLogEntry,
  erHtml,
  esc,
  type LocateLine,
  lessonHtml,
  statsHtml,
  toolsHtml,
  transcriptHtml,
  type WatchLine,
} from './panel';

// The desk lab (desk.html, docs/dev-setup.md §2): a whole Clio lesson on the laptop's camera and
// microphone, without the headset. The page shows the webcam with what the tracker follows drawn
// over it, and a side panel with the lesson, the conversation, every coach tool call, Robotics-ER's
// looks and the tracker's numbers. DeskLab (desk-lab.ts) composes the real lesson; this file is the
// page around it. `window.desk` is the handle for the console, like the headset's `window.clio`.

const log = createLogger('desk');
const PREFS_KEY = 'clio.desk';
/** The lesson's pipeline runs this often (ms); a timer, so it goes on while the tab is in the back. */
const TICK_MS = 33;
/** The tracker's numbers are redrawn this often (ms). */
const STATS_MS = 250;

interface Prefs {
  camera: string;
  goal: string;
}

const config = readDeskConfig(location.search);
const root = document.querySelector<HTMLElement>('#desk');
if (root) void boot(root);

async function boot(el: HTMLElement): Promise<void> {
  const prefs = loadPrefs();
  el.innerHTML = layout();
  const $ = <T extends HTMLElement>(selector: string) => el.querySelector(selector) as T;
  const video = $<HTMLVideoElement>('#video');
  const camera = new DeskCamera(video);
  const overlay = new DeskOverlay($<HTMLCanvasElement>('#overlay'), video);
  const speaker = new DeskSpeaker();
  const api = new ApiClient();
  const health: HealthResponse | null = await api.health().catch((err: unknown) => {
    log.warn(`server unreachable: ${String(err)}`);
    return null;
  });
  const lab = new DeskLab({
    config,
    api,
    health,
    camera,
    speaker,
    version: __CLIO_VERSION__,
    trackerUrl: config.trackerPort
      ? `ws://localhost:${config.trackerPort}/track`
      : trackerUrl(location),
    visible: () => document.visibilityState === 'visible',
  });

  // ---- what the panel shows -------------------------------------------------------------------
  const transcript = new Transcript();
  const tools = new ToolLog();
  const er: { answers: ErAnswerView[]; log: ErLogEntry[]; wired: boolean } = {
    answers: [],
    log: [],
    wired: false,
  };
  let phase: LessonPhase = 'idle';
  let detail: string | null = null;
  let watch: WatchLine | null = null;
  let locate: LocateLine | null = null;
  let coachState = 'off';
  let voice = 'off';
  const dirty = new Set<'lesson' | 'transcript' | 'tools' | 'er' | 'status'>([
    'lesson',
    'transcript',
    'tools',
    'er',
    'status',
  ]);
  const { bus } = lab;
  bus.on('coach.caption', ({ t, role, text, final }) => {
    if (lab.typing) transcript.typed(t, text);
    else transcript.caption(t, role, text, final);
    dirty.add('transcript');
  });
  bus.on('coach.narration', ({ t, text }) => {
    transcript.narration(t, text);
    dirty.add('transcript');
  });
  bus.on('coach.tool_call', ({ t, callId, name, args }) => {
    tools.call(t, callId, name, args);
    dirty.add('tools');
  });
  bus.on('coach.tool_result', ({ t, callId, ok, result }) => {
    tools.result(t, callId, ok, result);
    dirty.add('tools');
  });
  bus.on('lesson.phase', ({ phase: p, detail: d }) => {
    phase = p;
    detail = d ?? null;
    dirty.add('lesson');
  });
  bus.on('plan.failed', ({ error }) => {
    detail = `planning failed: ${error}`;
    dirty.add('lesson');
  });
  bus.on('plan.slow', ({ elapsedMs }) => {
    detail = `planning, ${Math.round(elapsedMs / 1000)} s so far`;
    dirty.add('lesson');
  });
  bus.on('annotation', ({ t, label, data }) => {
    if (label !== 'step.watch' || !data || typeof data !== 'object') return;
    watch = { t, ...(data as Omit<WatchLine, 't'>) };
    dirty.add('lesson');
  });
  bus.on('object.detected', ({ t, objectId, found, source, latencyMs }) => {
    if (!locate || locate.t !== t || locate.source !== source) {
      locate = { t, source, found: [], missing: [], latencyMs };
    }
    (found ? locate.found : locate.missing).push(objectId);
  });
  bus.on('coach.status', ({ state, detail: d }) => {
    coachState = d ? `${state} (${d})` : state;
    dirty.add('status');
  });
  bus.on('coach.voice', ({ voice: v }) => {
    voice = v;
    dirty.add('status');
  });
  for (const type of [
    'plan.ready',
    'plan.changed',
    'step.entered',
    'step.completed',
    'procedure.completed',
    'procedure.aborted',
    'overlay.highlight',
  ] as const) {
    bus.on(type, () => dirty.add('lesson'));
  }

  // ---- controls -------------------------------------------------------------------------------
  const startButton = $<HTMLButtonElement>('#start');
  const coachSelect = $<HTMLSelectElement>('#coach');
  const cameraSelect = $<HTMLSelectElement>('#camera');
  const muteButton = $<HTMLButtonElement>('#mute');
  const sayInput = $<HTMLInputElement>('#say');
  const goalInput = $<HTMLInputElement>('#goal');
  coachSelect.value = config.coach;
  goalInput.value = config.goal ?? prefs.goal;

  const start = async () => {
    if (lab.running) return;
    startButton.disabled = true;
    try {
      // A click: the only moment the browser lets the page open its audio output.
      await speaker.unlock().catch((err: unknown) => log.warn(`no audio output: ${String(err)}`));
      await lab.start();
    } finally {
      startButton.disabled = false;
      dirty.add('status');
    }
  };
  const stop = async () => {
    startButton.disabled = true;
    try {
      await lab.stop();
    } finally {
      startButton.disabled = false;
      coachState = 'off';
      voice = 'off';
      dirty.add('status');
    }
  };
  const setMuted = (muted: boolean) => {
    lab.setMuted(muted);
    dirty.add('status');
  };
  const say = (text: string): boolean => {
    const sent = lab.say(text);
    if (!sent) toast(lab.running ? 'The scripted coach does not listen.' : 'Start the lab first.');
    return sent;
  };
  const startLesson = (goal: string) => {
    const outcome = lab.startLesson(goal);
    if (!outcome.ok) toast(outcome.error);
    savePrefs({ goal });
    return outcome;
  };
  const openCamera = async (deviceId?: string) => {
    const error = $('#camera-error');
    try {
      await camera.open(deviceId);
      error.hidden = true;
    } catch (err) {
      if (deviceId) return openCamera();
      error.textContent = `No camera: ${err instanceof Error ? err.message : String(err)}. Allow camera access for this page and reload.`;
      error.hidden = false;
    }
    const cameras = await DeskCamera.cameras().catch(() => []);
    cameraSelect.innerHTML = cameras
      .map(
        (c, i) =>
          `<option value="${esc(c.deviceId)}">${esc(c.label || `Camera ${i + 1}`)}</option>`,
      )
      .join('');
    if (camera.deviceId) cameraSelect.value = camera.deviceId;
    savePrefs({ camera: camera.deviceId ?? '' });
  };

  startButton.addEventListener('click', () => void (lab.running ? stop() : start()));
  coachSelect.addEventListener('change', () => {
    void lab.setCoach(coachSelect.value as CoachChoice).then(() => dirty.add('status'));
  });
  cameraSelect.addEventListener('change', () => void openCamera(cameraSelect.value));
  muteButton.addEventListener('click', () => setMuted(!lab.micMuted));
  $<HTMLFormElement>('#say-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (say(sayInput.value)) sayInput.value = '';
  });
  $<HTMLFormElement>('#goal-form').addEventListener('submit', (e) => {
    e.preventDefault();
    startLesson(goalInput.value);
  });
  $<HTMLButtonElement>('#done').addEventListener('click', () => {
    const outcome = lab.done();
    if (!outcome.ok) toast(outcome.error);
  });

  function toast(text: string): void {
    const t = $('#toast');
    t.textContent = text;
    t.hidden = false;
    setTimeout(() => {
      t.hidden = true;
    }, 3500);
  }

  // ---- loops ------------------------------------------------------------------------------------
  setInterval(() => lab.tick(), TICK_MS);
  let statsT = 0;
  let litKey = '';
  const frame = (now: number) => {
    er.answers = er.answers.filter((a) => now - a.t < ER_FADE_MS);
    const objects = lab.tracker.objects();
    overlay.draw(objects, er.answers, now);
    // What is lit changes without a lesson event (a highlight runs out): redraw the list then.
    const lit = objects
      .filter((o) => o.lit)
      .map((o) => `${o.id}:${o.style ?? ''}`)
      .join(',');
    if (lit !== litKey) {
      litKey = lit;
      dirty.add('lesson');
    }
    if (dirty.has('status')) renderStatus();
    if (dirty.has('lesson')) render('#lesson', lessonPanel());
    if (dirty.has('transcript')) render('#transcript', transcriptHtml(transcript.lines), true);
    if (dirty.has('tools')) render('#tools', toolsHtml(tools.entries, tools.counts()), true);
    if (dirty.has('er')) render('#er', erHtml(er.log, er.wired), true);
    if (now - statsT >= STATS_MS) {
      statsT = now;
      render('#tracker', statsHtml(lab.tracker.stats(), locate));
    }
    dirty.clear();
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  function lessonPanel(): string {
    return lessonHtml({
      plan: lab.plan(),
      phase,
      detail,
      objects: lab.tracker.objects(),
      watch,
    });
  }

  /** Puts a section's HTML in place; a log that was scrolled to its end stays there. */
  function render(selector: string, html: string, follow = false): void {
    const box = $(selector);
    const atEnd = box.scrollTop + box.clientHeight >= box.scrollHeight - 24;
    box.innerHTML = html;
    if (follow && atEnd) box.scrollTop = box.scrollHeight;
  }

  function renderStatus(): void {
    const server = health
      ? `server ${esc(health.version)}${health.coach.configured ? '' : ' · <span class="bad">no Gemini key</span>'}`
      : '<span class="bad">server unreachable: run pnpm dev</span>';
    const coach = lab.running
      ? `${esc(lab.coachKind ?? '?')}${lab.coachModel ? ` ${esc(lab.coachModel)}` : ''} · ${esc(coachState)} · ${esc(voice)}`
      : 'stopped';
    $('#status').innerHTML = `${server} · coach ${coach}`;
    startButton.textContent = lab.running ? 'Stop' : 'Start';
    startButton.classList.toggle('primary', !lab.running);
    muteButton.textContent = lab.micMuted ? 'Unmute mic' : 'Mute mic';
    muteButton.classList.toggle('on', lab.micMuted);
    coachSelect.value = lab.coachChoice;
  }

  // ---- the console handle -----------------------------------------------------------------------
  (window as unknown as { desk: unknown }).desk = {
    lab,
    bus: lab.bus,
    lesson: lab.lesson,
    registry: lab.registry,
    tracker: lab.tracker,
    camera,
    transcript,
    tools,
    er,
    plan: () => lab.plan(),
    objects: () => lab.tracker.objects(),
    stats: () => lab.tracker.stats(),
    start,
    stop,
    say,
    goal: startLesson,
    done: () => lab.done(),
    coach: (choice: CoachChoice) => lab.setCoach(choice),
    mute: (muted = true) => setMuted(muted),
    openCamera: (deviceId?: string) => openCamera(deviceId),
  };

  await openCamera(prefs.camera || undefined);
}

function layout(): string {
  return `
    <header class="desk-top">
      <h1>Desk lab</h1>
      <button id="start" class="primary" type="button">Start</button>
      <label>Coach <select id="coach">
        <option value="gemini">Gemini Live</option>
        <option value="scripted">Scripted</option>
      </select></label>
      <label>Camera <select id="camera"></select></label>
      <button id="mute" type="button">Mute mic</button>
      <span id="status" class="status">Connecting…</span>
    </header>
    <main class="desk">
      <section class="stage">
        <div class="viewer">
          <video id="video" autoplay muted playsinline></video>
          <canvas id="overlay"></canvas>
          <p id="camera-error" class="camera-error" hidden></p>
        </div>
        <form id="say-form" class="row">
          <input id="say" autocomplete="off" placeholder="Type what the learner says, as if spoken (Enter sends)">
          <button type="submit">Say</button>
        </form>
        <form id="goal-form" class="row">
          <input id="goal" maxlength="300" autocomplete="off" placeholder="Goal: start a lesson directly, e.g. water the basil">
          <button type="submit">Start lesson</button>
          <button id="done" type="button" title="The learner's Done button: confirm the focused step">Done</button>
        </form>
      </section>
      <aside class="side">
        <details open><summary>Lesson</summary><div id="lesson" class="section"></div></details>
        <details open><summary>Conversation</summary><div id="transcript" class="section log"></div></details>
        <details open><summary>Coach tool calls</summary><div id="tools" class="section log"></div></details>
        <details open><summary>Robotics-ER focus</summary><div id="er" class="section log"></div></details>
        <details open><summary>Tracker</summary><div id="tracker" class="section"></div></details>
      </aside>
    </main>
    <div id="toast" class="toast" hidden></div>`;
}

function loadPrefs(): Prefs {
  const fallback: Prefs = { camera: '', goal: '' };
  try {
    return { ...fallback, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') };
  } catch {
    return fallback;
  }
}

function savePrefs(change: Partial<Prefs>): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ ...loadPrefs(), ...change }));
  } catch {
    // Private windows may refuse storage; the page works without it.
  }
}

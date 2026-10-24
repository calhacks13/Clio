import type { HealthResponse, Procedure, ProcedureSummary } from '@clio/protocol';
import { MicCapture } from '../adapters/audio/mic-capture';
import { SpeakerOutput } from '../adapters/audio/voice-output';
import { PassthroughCamera } from '../adapters/camera/passthrough-camera';
import { ApiClient, isAccessDenied } from '../adapters/net/api-client';
import { isArSupported } from '../adapters/xr/xr-session';
import { createLogger } from '../core/log';
import { ClioApp } from './clio-app';
import { readConfig } from './config';

// The 2D launch page: checks the server and the headset, collects what to learn, requests
// permissions (they can't be prompted inside an immersive session), then enters AR.

const log = createLogger('boot');
const isQuest = () => /OculusBrowser|Quest/.test(navigator.userAgent);

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export async function boot(root: HTMLElement): Promise<void> {
  const config = readConfig(location.search);
  const emulated =
    config.emulate || (import.meta.env.DEV && !isQuest() && !(await isArSupported()));
  if (emulated) {
    const { installEmulator } = await import('../adapters/xr/emulator');
    const handle = await installEmulator();
    (window as unknown as { clio: unknown }).clio = handle;
  }

  const api = new ApiClient();
  // Health stays open on a server with an access key; the procedure list says if we lack it.
  let locked = false;
  const [health, procedures, ar] = await Promise.all([
    api.health().catch((err: unknown) => {
      log.warn(`server unreachable: ${String(err)}`);
      return null;
    }),
    api
      .procedures()
      .then((r) => r.procedures)
      .catch((err: unknown) => {
        locked = isAccessDenied(err);
        return [] as ProcedureSummary[];
      }),
    isArSupported(),
  ]);

  root.innerHTML = render(health, procedures, ar, config.goal ?? '', locked);
  const $ = <T extends HTMLElement>(sel: string) => root.querySelector(sel) as T;
  $<HTMLSelectElement>('#procedure').value = config.procedureId ?? '';
  $<HTMLInputElement>('#calibrate').checked = config.calibrate;
  $<HTMLInputElement>('#record').checked = config.mode === 'record_demo';

  $<HTMLButtonElement>('#enter').addEventListener('click', async () => {
    const button = $<HTMLButtonElement>('#enter');
    const status = $<HTMLElement>('#status');
    button.disabled = true;
    try {
      const speaker = new SpeakerOutput();
      await speaker.unlock();
      status.textContent = 'Requesting microphone and camera…';
      if (config.coach === 'gemini') await MicCapture.requestPermission();
      const camera = config.camera ? await PassthroughCamera.open() : null;
      const procedureId = $<HTMLSelectElement>('#procedure').value;
      const procedure: Procedure | null = procedureId ? await api.procedure(procedureId) : null;
      const goal = $<HTMLInputElement>('#goal').value.trim() || null;
      const app = new ClioApp({
        config: {
          ...config,
          calibrate: $<HTMLInputElement>('#calibrate').checked,
          mode: $<HTMLInputElement>('#record').checked ? 'record_demo' : config.mode,
        },
        container: $<HTMLElement>('#xr'),
        api,
        health,
        camera,
        speaker,
        emulated,
        procedure,
        goal: procedure ? null : goal,
        version: __CLIO_VERSION__,
      });
      status.textContent = 'Entering AR…';
      await app.enterXr();
      root.classList.add('in-xr');
      status.textContent = camera ? 'In AR.' : 'In AR (no camera: objects are found by pinching).';
    } catch (err) {
      log.error(String(err));
      status.textContent = `Could not start: ${err instanceof Error ? err.message : String(err)}`;
      button.disabled = false;
    }
  });
}

function render(
  health: HealthResponse | null,
  procedures: ProcedureSummary[],
  ar: boolean,
  goal: string,
  locked: boolean,
): string {
  const check = (ok: boolean, label: string) =>
    `<li class="${ok ? 'ok' : 'bad'}">${ok ? '✓' : '✗'} ${label}</li>`;
  const options = procedures
    .map(
      (p) =>
        `<option value="${esc(p.id)}">${esc(p.title)}${p.source === 'generated' ? ' (AI-planned)' : ''}</option>`,
    )
    .join('');
  return `
    <main class="boot">
      <h1>Clio</h1>
      <p class="tag">Every lesson trains two students: you, and a robot.</p>
      <ul class="checks">
        ${check(!!health, health ? `server ${esc(health.version)}` : 'server unreachable (run pnpm dev)')}
        ${locked ? check(false, 'no access key: open the link with ?key=…') : ''}
        ${check(!!health?.coach.configured, health?.coach.configured ? `voice coach ${esc(health.coach.liveModel)}` : 'no Gemini key: offline coach')}
        ${check(ar, ar ? 'passthrough AR available' : 'no immersive-ar (use a Quest, or ?emulate=1)')}
      </ul>
      <label class="field">What do you want to learn?
        <input id="goal" type="text" placeholder="e.g. refill windshield washer fluid" value="${esc(goal)}">
        <small>Leave empty to just talk to Clio once you're in.</small>
      </label>
      <label class="field">…or run a saved lesson
        <select id="procedure"><option value="">(none)</option>${options}</select>
      </label>
      <label class="check"><input id="calibrate" type="checkbox"> Calibrate the table first (pinch two corners)</label>
      <label class="check"><input id="record" type="checkbox"> Record expert demonstrations</label>
      <button id="enter" ${ar ? '' : 'disabled'}>Enter AR</button>
      <p id="status" class="status"></p>
    </main>
    <div id="xr"></div>`;
}

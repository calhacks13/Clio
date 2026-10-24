import type { Procedure, ProcedureSummary } from '@clio/protocol';
import { MicCapture } from '../adapters/audio/mic-capture';
import { SpeakerOutput } from '../adapters/audio/voice-output';
import { PassthroughCamera } from '../adapters/camera/passthrough-camera';
import { ApiClient } from '../adapters/net/api-client';
import { isArSupported } from '../adapters/xr/xr-session';
import { createLogger } from '../core/log';
import { renderBoot } from './boot-view';
import { ClioApp } from './clio-app';
import { readConfig } from './config';

// The 2D launch page: checks the server and the headset, collects what to learn, requests
// permissions (they can't be prompted inside an immersive session), then enters AR.

const log = createLogger('boot');
const isQuest = () => /OculusBrowser|Quest/.test(navigator.userAgent);

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
  const [health, procedures, ar] = await Promise.all([
    api.health().catch((err: unknown) => {
      log.warn(`server unreachable: ${String(err)}`);
      return null;
    }),
    api
      .procedures()
      .then((r) => r.procedures)
      .catch(() => [] as ProcedureSummary[]),
    isArSupported(),
  ]);

  root.innerHTML = renderBoot({ health, procedures, ar, goal: config.goal ?? '' });
  const $ = <T extends HTMLElement>(sel: string) => root.querySelector(sel) as T;
  $<HTMLSelectElement>('#procedure').value = config.procedureId ?? '';
  $<HTMLInputElement>('#calibrate').checked = config.calibrate;
  $<HTMLInputElement>('#record').checked = config.mode === 'record_demo';

  $<HTMLButtonElement>('#enter').addEventListener('click', async () => {
    const button = $<HTMLButtonElement>('#enter');
    const status = $<HTMLElement>('#status');
    button.disabled = true;
    try {
      // The coach speaks only from the headset; elsewhere (the Mac, the emulator) it is silent
      // unless ?audio=1 asks for sound.
      const speaker = new SpeakerOutput(
        !isQuest() && new URLSearchParams(location.search).get('audio') !== '1',
      );
      await speaker.unlock();
      status.textContent = 'Requesting microphone and camera…';
      if (config.coach === 'gemini') await MicCapture.requestPermission();
      const camera = config.camera
        ? await PassthroughCamera.open({ storedCalibration: true })
        : null;
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

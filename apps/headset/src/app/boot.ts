import type { Procedure, ProcedureSummary } from '@clio/protocol';
import { MicCapture } from '../adapters/audio/mic-capture';
import { SpeakerOutput } from '../adapters/audio/voice-output';
import { PassthroughCamera } from '../adapters/camera/passthrough-camera';
import { ApiClient } from '../adapters/net/api-client';
import { isArSupported } from '../adapters/xr/xr-session';
import { createLogger } from '../core/log';
import {
  type BootChoice,
  type BootProgress,
  bindBootView,
  renderBoot,
  setBootProgress,
} from './boot-view';
import { ClioApp } from './clio-app';
import { readConfig } from './config';

// The 2D launch page: checks the server and the headset, collects what to learn, requests
// permissions (they can't be prompted inside an immersive session), then enters AR. The page
// itself (boot-view.ts) shows what is wrong only when something is, and its button narrates the
// start.

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

  root.innerHTML = renderBoot({
    health,
    procedures,
    ar,
    goal: config.goal ?? '',
    procedureId: config.procedureId,
    calibrate: config.calibrate,
    record: config.mode === 'record_demo',
  });
  const progress = (p: BootProgress) => setBootProgress(root, p);

  const start = async (choice: BootChoice) => {
    try {
      // The coach speaks only from the headset; elsewhere (the Mac, the emulator) it is silent
      // unless ?audio=1 asks for sound.
      const speaker = new SpeakerOutput(
        !isQuest() && new URLSearchParams(location.search).get('audio') !== '1',
      );
      const mic = config.coach === 'gemini';
      const only = mic ? 'Allow the microphone' : 'Allow the camera';
      // Busy from the first moment, so a second press cannot start twice.
      if (mic && config.camera) progress({ kind: 'permissions' });
      else if (mic || config.camera) progress({ kind: 'permissions', message: only });
      else progress({ kind: 'entering' });
      await speaker.unlock();
      if (mic) await MicCapture.requestPermission();
      const camera = config.camera
        ? await PassthroughCamera.open({ storedCalibration: true })
        : null;
      progress({ kind: 'entering' });
      const procedure: Procedure | null = choice.procedureId
        ? await api.procedure(choice.procedureId)
        : null;
      // ?mode=record_demo only prefills the switch; the switch decides.
      const learn = config.mode === 'record_demo' ? 'learn' : config.mode;
      const app = new ClioApp({
        config: {
          ...config,
          calibrate: choice.calibrate,
          mode: choice.record ? 'record_demo' : learn,
        },
        container: root.querySelector('#xr') as HTMLElement,
        api,
        health,
        camera,
        speaker,
        emulated,
        procedure,
        // A saved lesson overrides the goal.
        goal: procedure ? null : choice.goal,
        version: __CLIO_VERSION__,
      });
      await app.enterXr();
      root.classList.add('in-xr');
      if (!camera) log.info('in AR without the camera: objects are found by pinching');
      progress({ kind: 'inside' });
    } catch (err) {
      log.error(String(err));
      progress({ kind: 'error', message: reason(err) });
    }
  };
  bindBootView(root, (choice) => void start(choice));
}

/** The reason alone, without Chrome's "Failed to execute 'requestSession' on 'XRSystem': ". */
const reason = (err: unknown) =>
  (err instanceof Error ? err.message : String(err)).replace(
    /^Failed to execute '[^']+' on '[^']+': /,
    '',
  );

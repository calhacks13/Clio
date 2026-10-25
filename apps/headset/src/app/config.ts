import type { EpisodeMode } from '@clio/protocol';

// Runtime options from the URL, e.g. /?coach=scripted&procedure=shirt-fold&debug=1.
// Invalid values fall back to defaults: a typo must never stop the app from booting at the venue.

export interface AppConfig {
  /** gemini: live voice coach. scripted: offline coach (TTS, Done button). off: no coach. */
  coach: 'gemini' | 'scripted' | 'off';
  /** relay: through the laptop server (no key on the headset). direct: ephemeral token. */
  transport: 'relay' | 'direct';
  mode: EpisodeMode;
  /** Run a saved procedure instead of planning one. */
  procedureId: string | null;
  /** Plan this goal immediately (skips asking). */
  goal: string | null;
  /** Install the IWER Quest 3 emulator (desktop development). */
  emulate: boolean;
  debug: boolean;
  /** Use the passthrough camera (grounding, coach vision). */
  camera: boolean;
  /** Play each step's demonstration when it starts. */
  autoDemo: boolean;
  /** Pinch two corners to calibrate the table before the lesson. */
  calibrate: boolean;
  /** auto: snap the workspace to the detected table when the session starts. off: in front. */
  table: 'auto' | 'off';
  /** Gemini prebuilt voice name. */
  voice: string | null;
  /** How often to look again at what the step shows, in ms (0: only when the step starts). */
  showRefreshMs: number;
  /** Follow what each step shows live with the tracker's /track, when it answers. */
  live: boolean;
  /** A tracker on this local port instead of the one Vite proxies (to compare models). */
  trackerPort: number | null;
  /** Width of the frames streamed to the tracker (frame-stream.ts takes 640, 512, 480 or 320). */
  frameWidth: number | null;
  /** Keep an object's live light on while it is in hand (0: hide it, as the other outlines do). */
  liveHeld: boolean;
  /**
   * Robotics-ER 2's action focus: every few seconds it boxes the step's objects for the tracker and
   * names the next thing to touch (needs the camera, the live tracker and a Gemini key).
   */
  focus: boolean;
}

const DEFAULTS: AppConfig = {
  coach: 'gemini',
  transport: 'relay',
  mode: 'learn',
  procedureId: null,
  goal: null,
  emulate: false,
  debug: false,
  camera: true,
  autoDemo: true,
  calibrate: false,
  table: 'auto',
  voice: null,
  showRefreshMs: 3000,
  live: true,
  trackerPort: null,
  frameWidth: null,
  liveHeld: true,
  focus: true,
};

function oneOf<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function flag(value: string | null, fallback: boolean): boolean {
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  return fallback;
}

const text = (value: string | null) => (value?.trim() ? value.trim() : null);

/** A positive whole number, else null. */
function whole(value: string | null): number | null {
  const n = value === null || value.trim() === '' ? Number.NaN : Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function millis(value: string | null, fallback: number): number {
  const ms = value === null || value.trim() === '' ? Number.NaN : Number(value);
  return Number.isFinite(ms) && ms >= 0 ? ms : fallback;
}

export function readConfig(search: string): AppConfig {
  const q = new URLSearchParams(search);
  return {
    coach: oneOf(q.get('coach'), ['gemini', 'scripted', 'off'], DEFAULTS.coach),
    transport: oneOf(q.get('transport'), ['relay', 'direct'], DEFAULTS.transport),
    mode: oneOf(q.get('mode'), ['learn', 'record_demo', 'free'], DEFAULTS.mode),
    procedureId: text(q.get('procedure')),
    goal: text(q.get('goal')),
    emulate: flag(q.get('emulate'), DEFAULTS.emulate),
    debug: flag(q.get('debug'), DEFAULTS.debug),
    camera: flag(q.get('camera'), DEFAULTS.camera),
    autoDemo: flag(q.get('autoDemo'), DEFAULTS.autoDemo),
    calibrate: flag(q.get('calibrate'), DEFAULTS.calibrate),
    table: oneOf(q.get('table'), ['auto', 'off'], DEFAULTS.table),
    voice: text(q.get('voice')),
    showRefreshMs: millis(q.get('showRefresh'), DEFAULTS.showRefreshMs),
    live: flag(q.get('live'), DEFAULTS.live),
    trackerPort: whole(q.get('tracker')),
    frameWidth: whole(q.get('frame')),
    liveHeld: flag(q.get('liveHeld'), DEFAULTS.liveHeld),
    focus: flag(q.get('focus'), DEFAULTS.focus),
  };
}

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
  /** Gemini prebuilt voice name. */
  voice: string | null;
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
  voice: null,
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
    voice: text(q.get('voice')),
  };
}

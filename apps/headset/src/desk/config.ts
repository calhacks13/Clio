// The desk lab's options from the URL, e.g. /desk.html?coach=scripted&goal=water+the+basil. Like the
// headset's (app/config.ts), a bad value falls back to its default rather than stopping the page.

export interface DeskConfig {
  /** gemini: the live voice (falls back to scripted without a key). scripted: offline, TTS. */
  coach: 'gemini' | 'scripted';
  /** relay: through the laptop server. direct: an ephemeral token. */
  transport: 'relay' | 'direct';
  /** Plan this lesson as soon as the lab starts. */
  goal: string | null;
  /** Run this curated lesson (procedures/) as soon as the lab starts. */
  procedureId: string | null;
  /** Width of the frames streamed to the tracker: 640, 512, 480 or 320 (frame-stream.ts). */
  frameWidth: number;
  /** A tracker on this local port instead of the one the page's origin proxies. */
  trackerPort: number | null;
  /** Robotics-ER's action focus, every few seconds while a step is focused (once it is wired). */
  focus: boolean;
  /** Start with the microphone muted. */
  muted: boolean;
  /** Gemini prebuilt voice name. */
  voice: string | null;
  /** How often to look again at what a step shows while the tracker is down (ms). */
  showRefreshMs: number;
}

/** The desk streams sharper frames than the Quest: the Mac encodes them, and jev sees them. */
const DEFAULT_FRAME_WIDTH = 640;

export const DESK_DEFAULTS: DeskConfig = {
  coach: 'gemini',
  transport: 'relay',
  goal: null,
  procedureId: null,
  frameWidth: DEFAULT_FRAME_WIDTH,
  trackerPort: null,
  focus: true,
  muted: false,
  voice: null,
  showRefreshMs: 3000,
};

const FRAME_WIDTHS = [640, 512, 480, 320];

const text = (value: string | null) => (value?.trim() ? value.trim() : null);

function flag(value: string | null, fallback: boolean): boolean {
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  return fallback;
}

function port(value: string | null): number | null {
  const n = Number(value);
  return value !== null && Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}

function millis(value: string | null, fallback: number): number {
  const ms = value === null || value.trim() === '' ? Number.NaN : Number(value);
  return Number.isFinite(ms) && ms >= 0 ? ms : fallback;
}

export function readDeskConfig(search: string): DeskConfig {
  const q = new URLSearchParams(search);
  const coach = q.get('coach');
  const transport = q.get('transport');
  const frame = Number(q.get('frame'));
  return {
    coach: coach === 'scripted' ? 'scripted' : DESK_DEFAULTS.coach,
    transport: transport === 'direct' ? 'direct' : DESK_DEFAULTS.transport,
    goal: text(q.get('goal')),
    procedureId: text(q.get('procedure')),
    frameWidth: FRAME_WIDTHS.includes(frame) ? frame : DESK_DEFAULTS.frameWidth,
    trackerPort: port(q.get('tracker')),
    focus: flag(q.get('focus'), DESK_DEFAULTS.focus),
    muted: !flag(q.get('mic'), !DESK_DEFAULTS.muted),
    voice: text(q.get('voice')),
    showRefreshMs: millis(q.get('showRefresh'), DESK_DEFAULTS.showRefreshMs),
  };
}

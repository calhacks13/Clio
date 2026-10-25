import { createLogger } from '../../core/log';

// three.js asks for the next frame only after its loop callback returns (WebGLAnimation), so one
// exception in a frame's update or render stops the loop for good: nothing more is submitted and
// the headset shows only passthrough, with no way back short of reloading. Every page runs its
// frames through a FrameGuard instead: a step that throws is skipped for that frame, counted and
// logged (once per distinct message), and the next frame runs as usual. Code inside three's render
// that is ours (a glow's onBeforeRender) reports here too, so its failure costs that one object
// and not the frame. window.__frames (and window.__occlusion.stats.frames) show the counts.

const log = createLogger('frame');
/** Distinct messages logged, so a step that throws every frame cannot flood the log. */
const MAX_LOGGED = 8;

export interface FrameHealth {
  /** Frames run. */
  frames: number;
  /** Steps that threw, in all. */
  errors: number;
  /** ...by step ('tick', 'render', 'glow', ...). */
  byStep: Record<string, number>;
  lastError: string | null;
  /** The frame (count) it happened in. */
  lastErrorFrame: number | null;
}

const errorText = (err: unknown): string =>
  err instanceof Error ? `${err.name}: ${err.message}` : String(err);

export class FrameGuard {
  readonly health: FrameHealth = {
    frames: 0,
    errors: 0,
    byStep: {},
    lastError: null,
    lastErrorFrame: null,
  };
  private readonly logged = new Set<string>();

  constructor(private readonly report: (message: string) => void = (m) => log.error(m)) {}

  /** Runs one step of a frame; false when it threw (counted, and logged the first time). */
  run(step: string, fn: () => void): boolean {
    try {
      fn();
      return true;
    } catch (err) {
      this.fail(step, err);
      return false;
    }
  }

  /** A step failed with `err`. */
  fail(step: string, err: unknown): void {
    const message = `${step}: ${errorText(err)}`;
    const { health } = this;
    health.errors++;
    health.byStep[step] = (health.byStep[step] ?? 0) + 1;
    health.lastError = message;
    health.lastErrorFrame = health.frames;
    if (this.logged.has(message) || this.logged.size >= MAX_LOGGED) return;
    this.logged.add(message);
    this.report(`${message} (the frame goes on; later repeats are only counted)`);
  }

  /**
   * An animation-loop callback that runs `tick` and then `render`, each guarded: a tick that
   * throws still renders the frame, and a render that throws leaves the next frame to try again.
   */
  loop<F>(
    tick: (time: number, frame: F | undefined) => void,
    render: () => void,
  ): (time: number, frame?: F) => void {
    return (time, frame) => {
      this.health.frames++;
      this.run('tick', () => tick(time, frame));
      this.run('render', render);
    };
  }
}

/** The page's guard: one renderer, one loop per page. */
export const frameGuard = new FrameGuard();

/** window.__frames: the page's frame health, for DevTools on the headset. */
export function installFrameDebug(guard: FrameGuard = frameGuard): void {
  if (typeof window === 'undefined') return;
  Object.defineProperty(window, '__frames', {
    get: () => ({ ...guard.health, byStep: { ...guard.health.byStep } }),
    configurable: true,
  });
}

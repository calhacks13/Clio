import { Quaternion, Vector3 } from 'three';
import type { TimerWidget, WidgetSnapshot } from '../../../domain/widgets/types';
import type { ObjectEstimate } from '../../../domain/world/object-registry';
import type { PresentContext, Presenter } from '../presenter';
import { onTopGroup } from './layering';
import { tween } from './motion';
import { type TextFactory, troikaText } from './text-port';
import { WIDGET_THEME } from './theme';
import { CHIP_ORDERS } from './views/face';
import { TimerChip } from './views/pill';

// A timer's chip beside the lesson object it is about (workspace frame, docs/widgets.md): its ring,
// time and label on a small white pill to the object's right as the learner sees it (the glow and
// markers put names above objects), facing the eye with no roll, a little larger further away. It
// shows only while the object is placed, not lost and not held, with 300 ms of hysteresis either
// way; two timers about one object stack, the older on top. The dock always shows the timer too,
// so a chip needs no fallback; the coach is never told.
// Like the names over objects, a chip draws on top (layering.ts), under the step card and the dock.

export interface WidgetChipsOptions {
  source: () => WidgetSnapshot;
  /** troikaText by default; fakeText in tests. */
  text?: TextFactory;
}

/** Presence hysteresis, fades and position smoothing (ms). */
export const CHIP_MOTION = {
  presentMs: 300,
  fadeInMs: 200,
  fadeOutMs: 160,
  smoothMs: 120,
} as const;
/** The chip's scale at distance d (m) from the eye: 1 at the card's 0.65 m, within 0.8 to 1.6. */
export const chipScale = (d: number): number => Math.min(1.6, Math.max(0.8, d / 0.65));

const LIFT = 0.01;
const CLEARANCE = 0.03;
/** From one chip to the next below it about the same object, at scale 1 (m). */
const STACK = WIDGET_THEME.size.chipHeight + WIDGET_THEME.size.gap;

class Chip {
  readonly object = onTopGroup();
  face: TimerChip | null = null;
  widget: TimerWidget;
  /** When the estimate turned valid or invalid, or null. */
  validSince: number | null = null;
  invalidSince: number | null = null;
  shown = false;
  /** Opacity when the last fade started, and when it started. */
  fadeFrom = 0;
  fadeAt = Number.NEGATIVE_INFINITY;
  placed = false;
  removed = false;
  seen = 0;

  constructor(widget: TimerWidget) {
    this.widget = widget;
    this.object.visible = false;
  }

  get objectId(): string | null {
    return this.widget.objectId;
  }

  opacity(t: number): number {
    const k = tween(t, this.fadeAt, this.shown ? CHIP_MOTION.fadeInMs : CHIP_MOTION.fadeOutMs);
    return this.fadeFrom + ((this.shown ? 1 : 0) - this.fadeFrom) * k;
  }

  toggle(shown: boolean, t: number): void {
    if (shown === this.shown) return;
    this.fadeFrom = this.opacity(t);
    this.fadeAt = t;
    this.shown = shown;
  }
}

function findObject(objects: readonly ObjectEstimate[], id: string): ObjectEstimate | null {
  for (const est of objects) if (est.id === id) return est;
  return null;
}

export class WidgetChipsPresenter implements Presenter {
  readonly object = onTopGroup();
  private readonly text: TextFactory;
  private readonly chips: Chip[] = [];
  private last: WidgetSnapshot | null = null;
  private pass = 0;
  // Scratch, so a frame allocates nothing.
  private readonly q = new Quaternion();
  private readonly qInverse = new Quaternion();
  private readonly origin = new Vector3();
  private readonly eye = new Vector3();
  private readonly world = new Vector3();
  private readonly target = new Vector3();

  constructor(private readonly options: WidgetChipsOptions) {
    this.text = options.text ?? troikaText;
    this.object.name = 'widget-chips';
  }

  /** Chips by timer, for tests and the preview. */
  get count(): number {
    return this.chips.length;
  }

  /** Every chip showing has its text laid out (the preview waits for this). */
  get ready(): boolean {
    for (const chip of this.chips) if (chip.face && !chip.face.ready) return false;
    return true;
  }

  update(ctx: PresentContext): void {
    if (ctx.calibration) {
      this.object.visible = false;
      return;
    }
    // Drawn last frame, unless hidden for calibration.
    const seen = this.object.visible;
    this.object.visible = true;
    const t = ctx.t;
    const snap = this.options.source();
    if (snap !== this.last) {
      this.last = snap;
      this.reconcile(snap, t, seen);
    }
    if (this.chips.length === 0) return;

    const pose = ctx.worldFromWorkspace;
    this.q.set(pose.q[0], pose.q[1], pose.q[2], pose.q[3]);
    this.qInverse.copy(this.q).invert();
    this.origin.set(pose.p[0], pose.p[1], pose.p[2]);
    this.eye.set(ctx.head.p[0], ctx.head.p[1], ctx.head.p[2]);
    this.object.updateWorldMatrix(true, false);
    const smooth = 1 - Math.exp(-ctx.dt / CHIP_MOTION.smoothMs);

    for (let i = this.chips.length - 1; i >= 0; i--) {
      const chip = this.chips[i] as Chip;
      const est = chip.objectId === null ? null : findObject(ctx.objects, chip.objectId);
      const valid =
        !chip.removed && est !== null && est.lostAt === undefined && est.heldBy === null;
      this.presence(chip, valid, t);
      const opacity = chip.opacity(t);
      if (chip.removed && !chip.shown && opacity <= 0.002) {
        chip.face?.dispose();
        chip.object.removeFromParent();
        this.chips.splice(i, 1);
        continue;
      }
      chip.object.visible = opacity > 0.002;
      if (est && valid) this.place(chip, est, smooth, this.stackIndex(i, est.id));
      if (!chip.object.visible) continue;
      const face = this.faceOf(chip, t);
      face.frame(t, opacity);
    }
  }

  dispose(): void {
    for (const chip of this.chips) chip.face?.dispose();
    this.chips.length = 0;
  }

  /**
   * New timers about an object get chips, changed records go to their chip, and a chip whose timer
   * is gone fades out; one nobody saw last frame (hidden for calibration, or not showing) goes at
   * once, so a timer that closed during calibration never flashes back to fade.
   */
  private reconcile(snap: WidgetSnapshot, t: number, seen: boolean): void {
    const pass = ++this.pass;
    for (const w of snap.widgets) {
      if (w.kind !== 'timer' || w.objectId === null) continue;
      let chip: Chip | null = null;
      for (const c of this.chips) {
        if (!c.removed && c.widget.seq === w.seq) {
          chip = c;
          break;
        }
      }
      if (!chip) {
        chip = new Chip(w);
        this.chips.push(chip);
        this.object.add(chip.object);
      } else if (chip.widget !== w) {
        chip.widget = w;
        chip.face?.set(w, t);
      }
      chip.seen = pass;
    }
    for (let i = this.chips.length - 1; i >= 0; i--) {
      const chip = this.chips[i] as Chip;
      if (chip.seen === pass) continue;
      if (seen && chip.object.visible) {
        chip.removed = true;
      } else {
        chip.face?.dispose();
        chip.object.removeFromParent();
        this.chips.splice(i, 1);
      }
    }
  }

  /** Shows after 300 ms of a valid estimate; hides after 300 ms of an invalid one, at once when its timer is gone. */
  private presence(chip: Chip, valid: boolean, t: number): void {
    if (valid) {
      chip.invalidSince = null;
      if (chip.validSince === null) chip.validSince = t;
      if (!chip.shown && t - chip.validSince >= CHIP_MOTION.presentMs) chip.toggle(true, t);
      return;
    }
    chip.validSince = null;
    if (chip.invalidSince === null) chip.invalidSince = t;
    if (chip.shown && (chip.removed || t - chip.invalidSince >= CHIP_MOTION.presentMs)) {
      chip.toggle(false, t);
    }
  }

  /**
   * How many chips about the same object sit above chip `i`: the older ones whose timer is still up
   * or that are still fading out, so a second timer's chip moves up once the first one's has gone.
   */
  private stackIndex(i: number, objectId: string): number {
    let k = 0;
    for (let j = 0; j < i; j++) {
      const other = this.chips[j] as Chip;
      if (other.objectId === objectId && (!other.removed || other.object.visible)) k++;
    }
    return k;
  }

  /**
   * Beside the object, to its right as the eye sees it, facing the eye without roll; `stack` chips
   * lower when older chips about the same object sit above it.
   */
  private place(chip: Chip, est: ObjectEstimate, smooth: number, stack: number): void {
    const p = est.position;
    // The object in world space; "right" is horizontal there, whatever the workspace's tilt.
    const world = this.world.set(p[0], p[1], p[2]).applyQuaternion(this.q).add(this.origin);
    let dx = world.x - this.eye.x;
    let dz = world.z - this.eye.z;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len;
    dz /= len;
    const offset = Math.max(est.spec.radius, 0.03) + CLEARANCE;
    const target = this.target.set(world.x - dz * offset, world.y + LIFT, world.z + dx * offset);
    const scale = chipScale(target.distanceTo(this.eye));
    chip.object.scale.setScalar(scale);
    target.y -= stack * STACK * scale;
    // Back into the workspace frame, the chip's parent.
    target.sub(this.origin).applyQuaternion(this.qInverse);
    if (!chip.placed) {
      chip.placed = true;
      chip.object.position.copy(target);
    } else {
      chip.object.position.lerp(target, smooth);
    }
    chip.object.lookAt(this.eye);
  }

  private faceOf(chip: Chip, t: number): TimerChip {
    if (!chip.face) {
      const face = new TimerChip(this.text);
      face.set(chip.widget, t);
      face.setOrders(CHIP_ORDERS, 0);
      face.object.position.y = WIDGET_THEME.size.chipHeight / 2;
      chip.object.add(face.object);
      chip.face = face;
    }
    return chip.face;
  }
}

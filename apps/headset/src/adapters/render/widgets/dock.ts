import { type Handedness, type HandSample, jointOffset } from '@clio/protocol';
import { Matrix4, type Object3D, Quaternion, Vector3 } from 'three';
import type { Pose, Vec3 } from '../../../core/math';
import type { WidgetIntent, WidgetSnapshot } from '../../../domain/widgets/types';
import { isInstructionPanelClear } from '../panel-placement';
import type { PresentContext, Presenter } from '../presenter';
import { FINGERTIP_NEAR, FingertipOccluder } from './fingertip-occluder';
import { onTopGroup } from './layering';
import { type DockItem, layoutDock } from './layout';
import { easeInCubic, tween } from './motion';
import {
  DOCK,
  type DockOffset,
  type DockSide,
  dockOffset,
  dockYaw,
  dockYawFloor,
} from './placement';
import { type TextFactory, troikaText } from './text-port';
import { WIDGET_THEME } from './theme';
import { type HitTarget, TOUCH, TouchCooldowns, TouchLatch } from './touch';
import { WidgetView } from './views/view';

// The coach's widgets beside the step card (docs/widgets.md): a column of Clio cards beside the
// card, on the same 0.65 m cylinder, its top level with the card's top edge. The column follows
// the real card: every frame it copies the pose of the card's group (which has already moved this
// frame) and turns out past the card's actual width, easing when a new step resizes the card;
// while a fingertip is near a touchable card it holds still so buttons stay under the finger, then
// eases back, or fades back when the card went far meanwhile. Like the card, it keeps clear of the
// objects: when one comes behind the column and the mirrored place on the card's other side is
// clear, it fades out there and in on that side. When it first shows, and when the card has gone
// somewhere new, it takes the clear side nearer where the head faces; otherwise it stays put.
// Views are built the first time a widget shows; a frame reads one snapshot reference, writes
// uniforms, checks one box against the objects and touches nothing else.

/** What the dock hangs off: the step card (InstructionPanelPresenter) satisfies it as is. */
export interface DockAnchor {
  /** The card's group (read only). The dock hides while it does (until it is first placed). */
  readonly object: Object3D;
  /** The card's actual width (m). */
  readonly panelWidth: number;
}

export interface WidgetDockOptions {
  source: () => WidgetSnapshot;
  onIntent: (intent: WidgetIntent) => void;
  /** The step card in the app; a stand-in posed by hand in tests. */
  anchor: DockAnchor;
  /** troikaText by default; fakeText in tests. */
  text?: TextFactory;
}

const W = WIDGET_THEME.size.dockWidth;
/** Touch and the freeze run only while a fingertip is this close to the column (m). */
const REACH = 0.3;
/** The freeze box around the column (m): sides, above and below, behind, in front. */
const FREEZE_SIDE = 0.05;
const FREEZE_BEHIND = -0.05;
const FREEZE_FRONT = 0.12;
const RELEASE_MS = 400;
const EASE_MS = 200;
const SETTLE_DISTANCE = 0.001;
const SETTLE_ANGLE = 0.002;
/** A blocked column changes sides once the other side has been clear this long (tracker jitter). */
export const SWITCH_DWELL_MS = 300;
/**
 * A card this far (m) or turned this much (rad) from where the column last chose its side has gone
 * somewhere new; a column held for a touch this far from the card fades back rather than glides.
 */
const MOVED_DISTANCE = 0.03;
const MOVED_ANGLE = (4 * Math.PI) / 180;
/** Less than this between frames (m, rad), and the card is still. */
const STILL_DISTANCE = 1e-4;
const STILL_ANGLE = 1e-4;
/** The other side must be nearer where the head faces by more than this (rad) to be worth a move. */
const FACING_MARGIN = (4 * Math.PI) / 180;
const M = WIDGET_THEME.motion;
const Y_AXIS = new Vector3(0, 1, 0);
const FORWARD = new Vector3(0, 0, -1);
const NO_HITS: readonly HitTarget[] = Object.freeze([]);

const INTERMEDIATE = jointOffset('index-finger-phalanx-intermediate');
const DISTAL = jointOffset('index-finger-phalanx-distal');
const TIP = jointOffset('index-finger-tip');

/** A joint of a workspace-frame hand sample in world space. */
function jointWorld(
  hand: HandSample,
  offset: number,
  pose: Pose,
  q: Quaternion,
  out: Vector3,
): Vector3 {
  const j = hand.joints;
  out.set(j[offset] ?? 0, j[offset + 1] ?? 0, j[offset + 2] ?? 0).applyQuaternion(q);
  return out.set(out.x + pose.p[0], out.y + pose.p[1], out.z + pose.p[2]);
}

export class WidgetDockPresenter implements Presenter {
  readonly object = onTopGroup();
  /** Copies the card's pose (both live in worldRoot), except while frozen for a touch. */
  readonly follow = onTopGroup();
  /** The column: origin at its top centre, x right, y up, z toward the eye. */
  readonly column = onTopGroup();
  private readonly text: TextFactory;
  private readonly views: WidgetView[] = [];
  private last: WidgetSnapshot | null = null;
  private pass = 0;
  private dirty = false;
  private height = 0;
  private hits: HitTarget[] = [];
  private readonly cooldowns = new TouchCooldowns();
  private readonly latches: readonly [TouchLatch, TouchLatch];
  private readonly hovered: [HitTarget | null, HitTarget | null] = [null, null];
  private occluder: FingertipOccluder | null = null;
  private frozen = false;
  private easing = false;
  private lastInside = Number.NEGATIVE_INFINITY;
  /** Following a shown card; false until it first shows, and again while it or the dock hides. */
  private placed = false;
  private sideNow: DockSide = DOCK.side;
  /** The column's turn off the card's centre line (rad), easing to dockYaw(card width). */
  private yaw = 0;
  /** The card as of the last frame, to tell a relocation from a resize in place. */
  private cardWidth = 0;
  private readonly cardP = new Vector3();
  private readonly cardQ = new Quaternion();
  /** The card moved since the frame before (a jump from rest is a relocation). */
  private cardMoving = false;
  /** Where the card was when the column last chose its side. */
  private readonly pickedP = new Vector3();
  private readonly pickedQ = new Quaternion();
  /** Nothing has shown since the column was hidden or empty: the next widget picks its side. */
  private fresh = true;
  /** Since when the column has been blocked with the other side clear, or null. */
  private blockedSince: number | null = null;
  /**
   * Moving unseen: when the column began to fade out, the side it fades in on, and whether it is
   * coming back to a card that went far while it was held (it then picks its side on arrival).
   */
  private leaveAt: number | null = null;
  private arriveSide: DockSide = DOCK.side;
  private returning = false;
  private arriveAt = Number.NEGATIVE_INFINITY;
  /** A view was drawn last frame; a column nobody has seen (yet, or since hiding) moves at once. */
  private showing = false;
  // Scratch, so a frame allocates nothing.
  private readonly offset: DockOffset = { position: [0, 0, 0], yaw: 0 };
  private readonly pose: Pose = { p: [0, 0, 0], q: [0, 0, 0, 1] };
  private readonly at = new Vector3();
  private readonly turn = new Quaternion();
  private readonly inverse = new Matrix4();
  private readonly coverInverse = new Matrix4();
  private readonly coverLocal = new Vector3();
  private readonly columnWorld = new Vector3();
  private readonly workspaceQ = new Quaternion();
  private readonly tipWorld = new Vector3();
  private readonly tipLocal = new Vector3();
  private readonly local: Vec3 = [0, 0, 0];
  private readonly a = new Vector3();
  private readonly b = new Vector3();
  private readonly c = new Vector3();
  private readonly gaze = new Vector3();
  private readonly toColumn = new Vector3();

  constructor(private readonly options: WidgetDockOptions) {
    this.text = options.text ?? troikaText;
    this.latches = [
      new TouchLatch('left', this.cooldowns),
      new TouchLatch('right', this.cooldowns),
    ];
    this.follow.add(this.column);
    this.object.add(this.follow);
    this.object.name = 'widget-dock';
  }

  /** The column's touch targets (column frame), as of the last layout. */
  get targets(): readonly HitTarget[] {
    return this.hits;
  }

  /** How far the column reaches below the card's top edge (m). */
  get columnHeight(): number {
    return this.height;
  }

  /** Every view showing has its text laid out (the preview waits for this). */
  get ready(): boolean {
    for (const view of this.views) if (!view.exiting && !view.ready) return false;
    return true;
  }

  /** Frozen for a fingertip near a touchable card. */
  get isFrozen(): boolean {
    return this.frozen;
  }

  /** The side of the card the column is on, or is moving to. */
  get side(): DockSide {
    return this.leaveAt === null ? this.sideNow : this.arriveSide;
  }

  /**
   * A fingertip (world space) over the cards the column shows, at about their depth. The column
   * draws over the step card, and while held for a touch the card can glide under it, so a poke
   * there is the widget's and never the card's Done. Beside the card, as it sits, it never is.
   */
  covers(tip: Vector3): boolean {
    if (!this.object.visible || !this.showing || this.height <= 0) return false;
    this.column.updateWorldMatrix(true, false);
    this.coverInverse.copy(this.column.matrixWorld).invert();
    const { x, y, z } = this.coverLocal.copy(tip).applyMatrix4(this.coverInverse);
    return (
      Math.abs(x) <= W / 2 && y <= 0 && y >= -this.height && z >= FREEZE_BEHIND && z <= FREEZE_FRONT
    );
  }

  update(ctx: PresentContext): void {
    if (ctx.calibration || !this.options.anchor.object.visible) {
      this.object.visible = false;
      this.placed = false;
      this.showing = false;
      // A switch decided before hiding is stale: shown again, the column picks its side afresh.
      this.fresh = true;
      this.leaveAt = null;
      this.returning = false;
      this.arriveAt = Number.NEGATIVE_INFINITY;
      this.blockedSince = null;
      return;
    }
    this.object.visible = true;
    this.followCard(ctx);
    const t = ctx.t;
    const snap = this.options.source();
    if (snap !== this.last) {
      this.last = snap;
      this.reconcile(snap, t);
    }
    if (this.dirty) this.layout(t);
    this.keepClear(ctx);
    const opacity = this.columnOpacity(t);
    let showing = false;
    for (let i = this.views.length - 1; i >= 0; i--) {
      const view = this.views[i] as WidgetView;
      if (view.finished(t)) {
        view.dispose();
        this.views.splice(i, 1);
        continue;
      }
      view.frame(t, opacity);
      showing ||= view.object.visible;
    }
    this.showing = showing;
    this.touch(ctx);
  }

  dispose(): void {
    for (const view of this.views) view.dispose();
    this.views.length = 0;
    this.occluder?.dispose();
  }

  /**
   * Copies the card's pose and turns the column out past its actual width. A new width eases the
   * turn (lerp min(1, dt / 200)), never so slowly that the column sits over a card that grew; a
   * resize that came with a move is the card relocating for its new size, and is followed at once.
   * After a touch it eases back to the card, unless the card went far (MOVED_DISTANCE or
   * MOVED_ANGLE) meanwhile: then it fades out, moves and fades in, never gliding across the card.
   * A card that jumps from rest has relocated: the column, which jumps with it, picks its side.
   */
  private followCard(ctx: PresentContext): void {
    const dt = ctx.dt;
    const anchor = this.options.anchor;
    const card = anchor.object;
    const width = anchor.panelWidth;
    const step = this.cardP.distanceTo(card.position);
    const turn = this.cardQ.angleTo(card.quaternion);
    const jumped = width !== this.cardWidth && (step > SETTLE_DISTANCE || turn > SETTLE_ANGLE);
    const moving = step > STILL_DISTANCE || turn > STILL_ANGLE;
    const relocated = moving && !this.cardMoving && (step > MOVED_DISTANCE || turn > MOVED_ANGLE);
    this.cardMoving = moving;
    this.cardWidth = width;
    this.cardP.copy(card.position);
    this.cardQ.copy(card.quaternion);
    const target = dockYaw(width);
    if (!this.placed) {
      this.placed = true;
      this.frozen = false;
      this.easing = false;
      this.cardMoving = false;
      this.yaw = target;
      this.follow.position.copy(card.position);
      this.follow.quaternion.copy(card.quaternion);
      this.placeColumn();
      return;
    }
    if (this.frozen || this.returning) return;
    if (jumped) {
      this.yaw = target;
    } else if (this.yaw !== target) {
      this.yaw += (target - this.yaw) * Math.min(1, dt / EASE_MS);
      if (Math.abs(target - this.yaw) < SETTLE_ANGLE) this.yaw = target;
    }
    this.yaw = Math.max(this.yaw, dockYawFloor(width));
    this.placeColumn();
    if (this.easing && this.far(this.follow.position, this.follow.quaternion)) {
      // Back from a touch to a card that went far: unseen, never across the card or the objects.
      this.easing = false;
      this.returning = true;
      this.arriveSide = this.sideNow;
      if (this.leaveAt === null) this.leaveAt = ctx.t;
      return;
    }
    if (!this.easing) {
      this.follow.position.copy(card.position);
      this.follow.quaternion.copy(card.quaternion);
      if (relocated && this.leaveAt === null && this.height > 0) this.pickSide(ctx, true);
      return;
    }
    const k = Math.min(1, dt / EASE_MS);
    this.follow.position.lerp(card.position, k);
    this.follow.quaternion.slerp(card.quaternion, k);
    if (
      this.follow.position.distanceTo(card.position) < SETTLE_DISTANCE &&
      this.follow.quaternion.angleTo(card.quaternion) < SETTLE_ANGLE
    ) {
      this.easing = false;
      this.follow.position.copy(card.position);
      this.follow.quaternion.copy(card.quaternion);
    }
  }

  /** Whether a pose is somewhere new relative to the card: MOVED_DISTANCE or MOVED_ANGLE away. */
  private far(p: Vector3, q: Quaternion): boolean {
    return p.distanceTo(this.cardP) > MOVED_DISTANCE || q.angleTo(this.cardQ) > MOVED_ANGLE;
  }

  private placeColumn(): void {
    const offset = dockOffset(this.sideNow, this.yaw, this.offset);
    this.column.position.set(offset.position[0], offset.position[1], offset.position[2]);
    this.column.rotation.y = offset.yaw;
  }

  /**
   * Keeps the column clear of every known object as the card is (panel-placement.ts): its actual
   * box, both eyes, 6 cm at its depth. It stays on a clear side. A blocked column checks the other
   * side too, and moves there once that has been clear for SWITCH_DWELL_MS: it fades out, moves
   * and fades in, so it never sweeps across the card. With both sides blocked it stays. A column
   * nobody has seen yet moves at once. When its first widget shows, and when the card has settled
   * somewhere new, it takes the clear side nearer where the head faces (pickSide); a card that went
   * somewhere new while the column moved unseen is chosen for as the column arrives.
   */
  private keepClear(ctx: PresentContext): void {
    const t = ctx.t;
    if (this.leaveAt !== null) {
      if (t - this.leaveAt < M.exitMs) return;
      this.leaveAt = null;
      const returning = this.returning;
      if (returning) {
        this.returning = false;
        this.follow.position.copy(this.cardP);
        this.follow.quaternion.copy(this.cardQ);
        this.yaw = dockYaw(this.cardWidth);
      }
      // Back to a card that went far while it was held, or to one that went somewhere new while
      // the column was unseen: it takes its side where the card is now, so it moves only once.
      if (returning || this.far(this.pickedP, this.pickedQ)) {
        this.arriveSide = this.preferredSide(ctx);
        this.pickedP.copy(this.cardP);
        this.pickedQ.copy(this.cardQ);
      }
      this.sideNow = this.arriveSide;
      this.placeColumn();
      this.arriveAt = t;
      return;
    }
    if (this.height <= 0) {
      this.fresh = true;
      this.blockedSince = null;
      return;
    }
    if (this.frozen || t - this.arriveAt < M.enterMs) {
      this.blockedSince = null;
      return;
    }
    if (this.fresh) {
      this.fresh = false;
      this.pickSide(ctx, false);
      return;
    }
    if (!this.easing && !this.cardMoving && ctx.dt > 0 && this.far(this.pickedP, this.pickedQ)) {
      this.pickSide(ctx, false);
      return;
    }
    const other = -this.sideNow as DockSide;
    if (this.clearAt(ctx, this.sideNow) || !this.clearAt(ctx, other)) {
      this.blockedSince = null;
      return;
    }
    if (!this.showing) {
      this.sideNow = other;
      this.placeColumn();
      return;
    }
    this.blockedSince ??= t;
    if (t - this.blockedSince >= SWITCH_DWELL_MS) {
      this.blockedSince = null;
      this.leaveAt = t;
      this.arriveSide = other;
    }
  }

  /**
   * Chooses the column's side afresh where the card is now, and remembers that pose: at once when
   * nobody sees the column or `now` (it jumped with the card), else by fading out and in.
   */
  private pickSide(ctx: PresentContext, now: boolean): void {
    this.pickedP.copy(this.cardP);
    this.pickedQ.copy(this.cardQ);
    this.blockedSince = null;
    const side = this.preferredSide(ctx);
    if (side === this.sideNow) return;
    if (now || !this.showing) {
      this.sideNow = side;
      this.placeColumn();
      return;
    }
    this.leaveAt = ctx.t;
    this.arriveSide = side;
  }

  /**
   * The side to show the column on: the clear one, or of two clear sides the one nearer where the
   * head faces (by more than FACING_MARGIN, else the side it is on). With neither clear, it stays.
   */
  private preferredSide(ctx: PresentContext): DockSide {
    const here = this.sideNow;
    const there = -here as DockSide;
    const clearHere = this.clearAt(ctx, here);
    const clearThere = this.clearAt(ctx, there);
    if (!clearThere) return here;
    if (!clearHere) return there;
    return this.facing(ctx, there) + FACING_MARGIN < this.facing(ctx, here) ? there : here;
  }

  /** The angle (rad) between where the head faces and the middle of the column on `side`. */
  private facing(ctx: PresentContext, side: DockSide): number {
    const offset = dockOffset(side, this.yaw, this.offset);
    const head = ctx.head;
    const f = this.follow;
    const p = this.toColumn
      .set(offset.position[0], offset.position[1] - this.height / 2, offset.position[2])
      .applyQuaternion(f.quaternion)
      .add(f.position);
    p.set(p.x - head.p[0], p.y - head.p[1], p.z - head.p[2]);
    const q = this.turn.set(head.q[0], head.q[1], head.q[2], head.q[3]);
    return this.gaze.copy(FORWARD).applyQuaternion(q).angleTo(p);
  }

  /** Whether the column's box on `side` (at the follow group's pose, in worldRoot) is clear. */
  private clearAt(ctx: PresentContext, side: DockSide): boolean {
    const offset = dockOffset(side, this.yaw, this.offset);
    const f = this.follow;
    const p = this.at
      .set(offset.position[0], offset.position[1], offset.position[2])
      .applyQuaternion(f.quaternion)
      .add(f.position);
    const q = this.turn.setFromAxisAngle(Y_AXIS, offset.yaw).premultiply(f.quaternion);
    const pose = this.pose;
    pose.p[0] = p.x;
    pose.p[1] = p.y;
    pose.p[2] = p.z;
    pose.q[0] = q.x;
    pose.q[1] = q.y;
    pose.q[2] = q.z;
    pose.q[3] = q.w;
    return isInstructionPanelClear(ctx, W, this.height, 0, pose);
  }

  /** The column's opacity: fading out to move unseen, then in where it arrives. */
  private columnOpacity(t: number): number {
    if (this.leaveAt !== null) return 1 - tween(t, this.leaveAt, M.exitMs, easeInCubic);
    return tween(t, this.arriveAt, M.enterMs);
  }

  /** Moving unseen: nothing to touch until the column has faded in again. */
  private switching(t: number): boolean {
    return this.leaveAt !== null || t - this.arriveAt < M.enterMs;
  }

  /**
   * New ids get views, changed records go to their view, ids that are gone start their exit. One
   * nobody saw last frame (the dock or the card was hidden, or it was not drawn yet) goes at once:
   * a widget that closed while the dock was hidden never flashes back to fade out.
   */
  private reconcile(snap: WidgetSnapshot, t: number): void {
    const pass = ++this.pass;
    for (const w of snap.widgets) {
      let view: WidgetView | null = null;
      for (const v of this.views) {
        if (!v.exiting && v.seq === w.seq) {
          view = v;
          break;
        }
      }
      if (!view) {
        view = new WidgetView(w, this.text, t);
        this.views.push(view);
        this.column.add(view.object);
        this.dirty = true;
      } else if (view.widget !== w) {
        view.set(w, t);
        this.dirty = true;
      }
      view.seen = pass;
    }
    for (let i = this.views.length - 1; i >= 0; i--) {
      const view = this.views[i] as WidgetView;
      if (view.seen === pass || view.exiting) continue;
      this.dirty = true;
      if (this.showing && view.object.visible) {
        view.exit(t);
      } else {
        view.dispose();
        this.views.splice(i, 1);
      }
    }
  }

  /**
   * Stacks the live views and rebuilds the touch targets. A column nobody saw last frame takes its
   * new slots at once: shown again, it is the column as it is now, not one still rearranging.
   */
  private layout(t: number): void {
    this.dirty = false;
    const live = this.views.filter((v) => !v.exiting);
    const items: DockItem[] = live.map((v) => {
      const w = v.widget;
      return {
        id: w.id,
        kind: w.kind,
        createdT: w.createdT,
        updatedT: w.updatedT,
        doneT: w.doneT,
        open: w.kind === 'choices' && w.status === 'active' && w.chosen === null,
        height: v.height,
      };
    });
    const slots = layoutDock(items);
    this.height = 0;
    for (const [i, slot] of slots.entries()) {
      const view = live.find((v) => v.id === slot.id);
      if (!view) continue;
      view.place(slot.top, slot.collapsed, t, i * 0.01, !this.showing);
      this.height = Math.max(this.height, slot.top + slot.height);
    }
    const hits: HitTarget[] = [];
    for (const view of live) {
      for (const { index, rect } of view.touchRects()) {
        hits.push({
          widgetId: view.id,
          index,
          cx: rect.x + rect.w / 2 - W / 2,
          cy: -(view.slotTop + rect.y + rect.h / 2),
          w: rect.w,
          h: rect.h,
        });
      }
    }
    this.hits = hits;
    for (const slot of [0, 1] as const) {
      const prev = this.hovered[slot];
      if (prev) this.view(prev.widgetId)?.setTouch(prev.index, 'none', t);
      this.hovered[slot] = null;
    }
  }

  /** Fingertips: hover, press and the freeze, only while one is near the column. */
  private touch(ctx: PresentContext): void {
    const hands = ctx.hands;
    const t = ctx.t;
    const hits = this.switching(t) ? NO_HITS : this.hits;
    let near = false;
    let inside = false;
    let inverted = false;
    if (hands) {
      const q = ctx.worldFromWorkspace.q;
      this.workspaceQ.set(q[0], q[1], q[2], q[3]);
      this.column.updateWorldMatrix(true, false);
      this.columnWorld.setFromMatrixPosition(this.column.matrixWorld);
    }
    for (let slot = 0; slot < 2; slot++) {
      const latch = this.latches[slot as 0 | 1];
      const sample = hands ? (slot === 0 ? hands.left : hands.right) : null;
      let tip: Vec3 | null = null;
      if (sample) {
        const world = jointWorld(
          sample,
          TIP,
          ctx.worldFromWorkspace,
          this.workspaceQ,
          this.tipWorld,
        );
        if (world.distanceTo(this.columnWorld) <= REACH + this.height) {
          near = true;
          if (!inverted) {
            this.inverse.copy(this.column.matrixWorld).invert();
            inverted = true;
          }
          this.tipLocal.copy(world).applyMatrix4(this.inverse);
          tip = this.local;
          tip[0] = this.tipLocal.x;
          tip[1] = this.tipLocal.y;
          tip[2] = this.tipLocal.z;
          if (
            Math.abs(tip[0]) <= W / 2 + FREEZE_SIDE &&
            tip[1] <= FREEZE_SIDE &&
            tip[1] >= -(this.height + FREEZE_SIDE) &&
            tip[2] >= FREEZE_BEHIND &&
            tip[2] <= FREEZE_FRONT
          ) {
            inside = true;
          }
        }
      }
      const result = latch.update(tip, hits, t);
      this.hover(slot as 0 | 1, result.near, t);
      if (result.pressed) this.press(result.pressed, latch.hand, t);
      this.occlude(slot as 0 | 1, sample, tip, hits, ctx);
    }
    const touchable = hits.length > 0;
    if (inside && touchable) {
      this.frozen = true;
      this.lastInside = t;
    } else if (this.frozen && t - this.lastInside >= RELEASE_MS) {
      this.frozen = false;
      this.easing = true;
    }
    if (!near && this.occluder) this.occluder.object.visible = false;
  }

  private hover(slot: 0 | 1, target: HitTarget | null, t: number): void {
    const prev = this.hovered[slot];
    if (prev === target) {
      if (target) this.view(target.widgetId)?.setTouch(target.index, 'hover', t);
      return;
    }
    if (prev) this.view(prev.widgetId)?.setTouch(prev.index, 'none', t);
    if (target) this.view(target.widgetId)?.setTouch(target.index, 'hover', t);
    this.hovered[slot] = target;
  }

  private press(target: HitTarget, hand: Handedness, t: number): void {
    const view = this.view(target.widgetId);
    if (!view) return;
    view.setTouch(target.index, 'pressed', t);
    const type = view.widget.kind === 'choices' ? 'choose' : 'tick';
    this.options.onIntent({ type, widgetId: target.widgetId, index: target.index, hand });
  }

  /**
   * The finger's hole punch, while its tip is within reach of a touch target and in front of the
   * column, or no deeper behind it than a press counts; only what is in front of the plane punches.
   */
  private occlude(
    slot: 0 | 1,
    sample: HandSample | null,
    tip: Vec3 | null,
    hits: readonly HitTarget[],
    ctx: PresentContext,
  ) {
    if (!sample || !tip || tip[2] < TOUCH.behindZ || !nearTarget(tip, hits)) {
      this.occluder?.hide(slot);
      return;
    }
    if (!this.occluder) {
      this.occluder = new FingertipOccluder();
      this.object.add(this.occluder.object);
    }
    this.occluder.setColumn(this.column.matrixWorld, W / 2, this.height);
    const pose = ctx.worldFromWorkspace;
    this.occluder.place(
      slot,
      jointWorld(sample, INTERMEDIATE, pose, this.workspaceQ, this.a),
      jointWorld(sample, DISTAL, pose, this.workspaceQ, this.b),
      jointWorld(sample, TIP, pose, this.workspaceQ, this.c),
    );
  }

  private view(widgetId: string): WidgetView | null {
    for (const view of this.views) if (!view.exiting && view.id === widgetId) return view;
    return null;
  }
}

function nearTarget(tip: Vec3, hits: readonly HitTarget[]): boolean {
  for (const target of hits) {
    const dx = Math.max(0, Math.abs(tip[0] - target.cx) - target.w / 2);
    const dy = Math.max(0, Math.abs(tip[1] - target.cy) - target.h / 2);
    if (Math.hypot(dx, dy, tip[2]) <= FINGERTIP_NEAR) return true;
  }
  return false;
}

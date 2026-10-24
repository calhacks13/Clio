import { Group, Mesh, MeshBasicMaterial, PlaneGeometry, Quaternion, Vector3 } from 'three';
import { rotateVec, yawOnly } from '../../../core/math';
import { jointPosition } from '../../../domain/hands/features';
import type { PresentContext, Presenter } from '../presenter';
import { makeText, setText } from '../text';

// The floating instruction card. It lazily follows the learner's gaze (re-centering only when it
// drifts out of view), shows the current step, progress, coach captions and corrections, and has a
// touchable "Done" button so a learner can confirm a step even when voice fails.

const W = 0.44;
const H = 0.17;
const FOLLOW_DISTANCE = 0.65;
const FOLLOW_DROP = 0.17;
const RECENTER_BEYOND = 0.3;
const BUTTON_TOUCH = 0.03;
const BUTTON_COOLDOWN_MS = 1500;

const TOAST_COLOR = { mistake: 0xff6b78, success: 0x7dffa4, info: 0xd6e4ff } as const;

export class InstructionPanelPresenter implements Presenter {
  readonly object = new Group();
  private readonly header = makeText({ size: 0.014, color: 0x9fb4d8, bold: true });
  private readonly instruction = makeText({ size: 0.026, maxWidth: W - 0.08, bold: true });
  private readonly detail = makeText({ size: 0.016, color: 0xb9c4d6, maxWidth: W - 0.08 });
  private readonly status = makeText({ size: 0.016, maxWidth: W - 0.04, anchorY: 'bottom' });
  private readonly bar = new Mesh(
    new PlaneGeometry(1, 0.006),
    new MeshBasicMaterial({ color: 0x4fe3ff }),
  );
  private readonly button = new Group();
  private readonly buttonMaterial = new MeshBasicMaterial({
    color: 0x2a7d5a,
    transparent: true,
    opacity: 0.85,
  });
  private readonly target = new Vector3();
  private initialized = false;
  private lastPress = Number.NEGATIVE_INFINITY;

  /** @param onDone called when the learner touches the Done button. */
  constructor(private readonly onDone: () => void) {
    const bg = new Mesh(
      new PlaneGeometry(W, H),
      new MeshBasicMaterial({ color: 0x0b1220, transparent: true, opacity: 0.72 }),
    );
    this.header.position.set(-W / 2 + 0.02, H / 2 - 0.015, 0.001);
    this.instruction.position.set(-W / 2 + 0.02, H / 2 - 0.038, 0.001);
    this.detail.position.set(-W / 2 + 0.02, -0.005, 0.001);
    this.status.position.set(-W / 2 + 0.02, -H / 2 + 0.02, 0.001);
    this.bar.position.set(-W / 2, -H / 2 + 0.004, 0.002);

    const buttonBg = new Mesh(new PlaneGeometry(0.06, 0.035), this.buttonMaterial);
    const buttonLabel = makeText({ size: 0.014, anchorX: 'center', anchorY: 'middle', bold: true });
    setText(buttonLabel, 'Done');
    buttonLabel.position.z = 0.001;
    this.button.add(buttonBg, buttonLabel);
    this.button.position.set(W / 2 - 0.04, -H / 2 + 0.03, 0.003);

    this.object.add(
      bg,
      this.header,
      this.instruction,
      this.detail,
      this.status,
      this.bar,
      this.button,
    );
  }

  update(ctx: PresentContext): void {
    this.follow(ctx);
    const s = ctx.snapshot;

    if (ctx.calibration) {
      setText(this.header, 'SET UP YOUR WORK AREA');
      setText(this.instruction, ctx.calibration.text);
      setText(
        this.detail,
        ctx.calibration.error ?? 'Touch the table with your index finger and thumb together.',
      );
    } else if (s.instruction) {
      const i = s.instruction;
      setText(
        this.header,
        `${(s.title ?? 'LESSON').toUpperCase()}  ·  STEP ${i.index + 1} OF ${i.total}`,
      );
      setText(this.instruction, i.text);
      setText(this.detail, i.detail ?? '');
    } else {
      setText(this.header, s.title ? s.title.toUpperCase() : 'CLIO');
      setText(this.instruction, PHASE_TEXT[s.phase] ?? '');
      setText(this.detail, s.phase === 'idle' ? 'Say what you want to learn.' : '');
    }

    const missing = s.missing.length
      ? `Can't see: ${s.missing.join(', ')}. Pinch it to show me.`
      : '';
    const line = s.toast?.text ?? missing ?? '';
    setText(
      this.status,
      line ||
        (s.caption ? `${s.caption.role === 'coach' ? 'Clio' : 'You'}: ${s.caption.text}` : ''),
    );
    this.status.color = s.toast ? TOAST_COLOR[s.toast.kind] : 0xd6e4ff;

    const progress = s.instruction?.progress ?? 0;
    this.bar.visible = progress > 0;
    this.bar.scale.x = Math.max(0.0001, progress * W);
    this.bar.position.x = -W / 2 + (progress * W) / 2;

    this.button.visible = !!s.instruction;
    if (this.button.visible) this.pressCheck(ctx);
  }

  private follow(ctx: PresentContext): void {
    const yaw = yawOnly(ctx.head.q);
    const ahead = rotateVec(yaw, [0, 0, -FOLLOW_DISTANCE]);
    this.target.set(
      ctx.head.p[0] + ahead[0],
      ctx.head.p[1] - FOLLOW_DROP,
      ctx.head.p[2] + ahead[2],
    );
    if (!this.initialized || this.object.position.distanceTo(this.target) > RECENTER_BEYOND) {
      this.initialized = true;
      this.object.position.copy(this.target);
    } else {
      this.object.position.lerp(this.target, Math.min(1, ctx.dt / 600));
    }
    // A plane faces +z; the head's yaw turns +z back toward the learner.
    this.object.quaternion.slerp(new Quaternion(...yaw), Math.min(1, ctx.dt / 300));
  }

  /** Index fingertip (either hand) touching the button, in world space. */
  private pressCheck(ctx: PresentContext): void {
    if (!ctx.hands || ctx.t - this.lastPress < BUTTON_COOLDOWN_MS) return;
    const center = this.button.getWorldPosition(new Vector3());
    for (const hand of [ctx.hands.left, ctx.hands.right]) {
      if (!hand) continue;
      // Hands are in workspace space; convert the fingertip to world space.
      const tip = jointPosition(hand, 'index-finger-tip');
      const w = ctx.worldFromWorkspace;
      const r = rotateVec(w.q, tip);
      const world = new Vector3(w.p[0] + r[0], w.p[1] + r[1], w.p[2] + r[2]);
      if (world.distanceTo(center) < BUTTON_TOUCH) {
        this.lastPress = ctx.t;
        this.buttonMaterial.color.setHex(0x7dffa4);
        setTimeout(() => this.buttonMaterial.color.setHex(0x2a7d5a), 300);
        this.onDone();
        return;
      }
    }
  }
}

const PHASE_TEXT: Partial<Record<string, string>> = {
  idle: 'What do you want to learn?',
  planning: 'Planning your lesson…',
  locating: 'Looking for the objects…',
  calibrating: 'Setting up…',
  done: 'Lesson complete!',
  failed: 'Something went wrong.',
};

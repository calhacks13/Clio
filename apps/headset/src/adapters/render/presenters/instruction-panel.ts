import {
  CircleGeometry,
  Color,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  RingGeometry,
  Vector3,
} from 'three';
import type { Text } from 'troika-three-text';
import { rotateVec, yawOnly } from '../../../core/math';
import { jointPosition } from '../../../domain/hands/features';
import { type CoachStatusState, coachStatus } from '../../../domain/overlay/coach-status';
import { OBJECT_HIGHLIGHT_COLOR } from '../object-highlight';
import type { PresentContext, Presenter } from '../presenter';
import { makeText, setText } from '../text';

// The floating instruction card. It lazily follows the learner's gaze (re-centering only when it
// drifts out of view), shows the current step, progress, coach captions and corrections, and has a
// touchable "Done" button so a learner can confirm a step even when voice fails. At the right of
// the header row a small light and a word say what the voice coach is doing (coachStatus).

const W = 0.44;
const H = 0.17;
const FOLLOW_DISTANCE = 0.65;
const FOLLOW_DROP = 0.17;
const RECENTER_BEYOND = 0.3;
const BUTTON_TOUCH = 0.03;
const BUTTON_COOLDOWN_MS = 1500;

const PANEL_COLOR = 0x0b1220;
const HEADER_COLOR = 0x9fb4d8;
const HEADER_SIZE = 0.014;
const TOAST_COLOR = { mistake: 0xff6b78, success: 0x7dffa4, info: 0xd6e4ff } as const;

const HEADER_X = -W / 2 + 0.02;
const HEADER_Y = H / 2 - 0.015;
/** The status mark's outer radius. It keeps the header row's right end, whatever the word. */
const MARK_R = 0.0058;
const MARK_X = W / 2 - 0.02 - MARK_R;
/** Centred on the header's capitals. */
const MARK_Y = HEADER_Y - 0.0085;
const LABEL_X = MARK_X - MARK_R - 0.006;
/** "Voice offline", the widest label (measured). */
const LABEL_MAX_W = 0.085;
/**
 * Beside the mark the header keeps to this many characters (the title gives way; nothing moves),
 * and is clipped short of the widest label in case wide letters still reach it.
 */
const HEADER_CHARS_BESIDE_MARK = 34;
const HEADER_CLIP = [-1, -1, LABEL_X - LABEL_MAX_W - 0.012 - HEADER_X, 1];

type ClippedText = Text & { clipRect: number[] | null };

export class InstructionPanelPresenter implements Presenter {
  readonly object = new Group();
  private readonly header = makeText({
    size: HEADER_SIZE,
    color: HEADER_COLOR,
    bold: true,
  }) as ClippedText;
  private readonly coachLabel = makeText({
    size: HEADER_SIZE,
    color: HEADER_COLOR,
    anchorX: 'right',
    bold: true,
  });
  private readonly coachMark = new CoachMark();
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
      new MeshBasicMaterial({ color: PANEL_COLOR, transparent: true, opacity: 0.72 }),
    );
    this.header.position.set(HEADER_X, HEADER_Y, 0.001);
    this.coachLabel.position.set(LABEL_X, HEADER_Y, 0.001);
    this.coachMark.object.position.set(MARK_X, MARK_Y, 0.002);
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
      this.coachLabel,
      this.coachMark.object,
    );
  }

  update(ctx: PresentContext): void {
    this.follow(ctx);
    const s = ctx.snapshot;
    const coach = coachStatus(s);
    const chars = coach ? HEADER_CHARS_BESIDE_MARK : Number.POSITIVE_INFINITY;

    if (ctx.calibration) {
      setText(this.header, clip('SET UP YOUR WORK AREA', chars));
      setText(this.instruction, ctx.calibration.text);
      setText(
        this.detail,
        ctx.calibration.error ?? 'Touch the table with your index finger and thumb together.',
      );
    } else if (s.instruction) {
      const i = s.instruction;
      setText(this.header, stepHeader(s.title, i.index, i.total, chars));
      setText(this.instruction, i.text);
      setText(this.detail, i.detail ?? '');
    } else {
      setText(this.header, clip(s.title ? s.title.toUpperCase() : 'CLIO', chars));
      setText(this.instruction, PHASE_TEXT[s.phase] ?? '');
      setText(this.detail, s.phase === 'idle' ? 'Say what you want to learn.' : '');
    }
    this.header.clipRect = coach ? HEADER_CLIP : null;

    this.coachLabel.visible = coach !== null;
    if (coach) {
      setText(this.coachLabel, coach.label);
      // The one state that needs the learner: the voice is gone, so the Done button is the way on.
      this.coachLabel.color = coach.state === 'offline' ? TOAST_COLOR.mistake : HEADER_COLOR;
    }
    this.coachMark.update(coach?.state ?? null, ctx.t);

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

/**
 * "TITLE   STEP n OF m", where `index` counts the steps done so far. Over `chars` characters, the
 * title gives way and the step count stays.
 */
export function stepHeader(
  title: string | null,
  index: number,
  total: number,
  chars = Number.POSITIVE_INFINITY,
): string {
  const count = `   STEP ${Math.min(index + 1, total)} OF ${total}`;
  return `${clip((title ?? 'LESSON').toUpperCase(), chars - count.length)}${count}`;
}

/** `text` in at most `chars` characters, cut after a whole word when one is near and marked. */
function clip(text: string, chars: number): string {
  if (text.length <= chars) return text;
  const cut = text.slice(0, Math.max(0, chars - 1));
  const space = cut.lastIndexOf(' ');
  return `${(space > cut.length / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

const CYAN = new Color(OBJECT_HIGHLIGHT_COLOR);
const AMBER = new Color(0xffaa33);
const RED = new Color(TOAST_COLOR.mistake);
// Dimmed by mixing in the panel's color, so the mark stays opaque.
const CYAN_DIM = CYAN.clone().lerp(new Color(PANEL_COLOR), 0.35);
const AMBER_DIM = AMBER.clone().lerp(new Color(PANEL_COLOR), 0.75);

const RING_IN = 0.0045;
const DOT_R = 0.0024;
const LAMP_R = 0.0042;
const BAR_W = 0.0022;
const BAR_GAP = 0.0035;
const BAR_MIN = 0.0035;
const BAR_MAX = 0.0116;
/** The glow's breath (DESIGN.md). */
const BREATH_MS = 3600;
const TURN_MS = 1200;
const BLINK_MS = 1000;
/** Per bar: two periods (ms) and a phase, so the three never move in step. */
const BAR_WAVES = [
  [430, 190, 0],
  [340, 230, 2.1],
  [510, 170, 4.2],
] as const;

/**
 * The coach status mark: listening is a cyan dot in a ring that breathes like the glow, hearing the
 * same ring pulsing faster, speaking three white bars, planning a turning cyan arc, connecting a
 * blinking amber lamp, and offline a still red one. Solid, opaque, and nothing allocated per frame.
 */
class CoachMark {
  readonly object = new Group();
  private readonly lampMaterial = new MeshBasicMaterial({ color: CYAN });
  private readonly ringMaterial = new MeshBasicMaterial({ color: CYAN });
  private readonly lamp = new Mesh(new CircleGeometry(1, 32), this.lampMaterial);
  private readonly ring = new Mesh(new RingGeometry(RING_IN, MARK_R, 48), this.ringMaterial);
  private readonly arc = new Mesh(
    new RingGeometry(RING_IN, MARK_R, 36, 1, 0, Math.PI * 1.5),
    this.ringMaterial,
  );
  private readonly bars: Mesh[] = [];

  constructor() {
    const geometry = new PlaneGeometry(1, 1);
    const material = new MeshBasicMaterial({ color: 0xffffff });
    for (let i = 0; i < BAR_WAVES.length; i++) {
      const bar = new Mesh(geometry, material);
      bar.position.x = (i - 1) * BAR_GAP;
      bar.scale.set(BAR_W, BAR_MIN, 1);
      this.bars.push(bar);
    }
    this.object.add(this.lamp, this.ring, this.arc, ...this.bars);
    this.object.visible = false;
  }

  update(state: CoachStatusState | null, t: number): void {
    this.object.visible = state !== null;
    if (state === null) return;
    const listening = state === 'listening' || state === 'hearing';
    this.ring.visible = listening;
    this.arc.visible = state === 'planning';
    this.lamp.visible = state !== 'speaking' && state !== 'planning';
    for (const bar of this.bars) bar.visible = state === 'speaking';

    switch (state) {
      case 'listening': {
        const k = wave(t, BREATH_MS);
        this.ring.scale.setScalar(0.94 + 0.12 * k);
        this.ringMaterial.color.lerpColors(CYAN_DIM, CYAN, 0.4 + 0.6 * k);
        this.lamp.scale.setScalar(DOT_R);
        this.lampMaterial.color.copy(CYAN);
        break;
      }
      case 'hearing': {
        // Two quick waves, so it reads as reacting to a voice rather than ticking.
        const k = 0.6 * wave(t, 620) + 0.4 * wave(t, 370, 1.1);
        this.ring.scale.setScalar(1 + 0.22 * k);
        this.ringMaterial.color.copy(CYAN);
        this.lamp.scale.setScalar(DOT_R * (1 + 0.35 * k));
        this.lampMaterial.color.copy(CYAN);
        break;
      }
      case 'speaking':
        for (let i = 0; i < this.bars.length; i++) {
          const [a, b, phase] = BAR_WAVES[i] ?? BAR_WAVES[0];
          const k = 0.65 * wave(t, a, phase) + 0.35 * wave(t, b);
          this.bars[i]?.scale.setY(BAR_MIN + (BAR_MAX - BAR_MIN) * k);
        }
        break;
      case 'planning':
        this.ringMaterial.color.copy(CYAN);
        this.arc.rotation.z = -((t % TURN_MS) / TURN_MS) * 2 * Math.PI;
        break;
      case 'connecting': {
        // A blink with soft edges: mostly on or off, never a hard flicker.
        const k = smoothstep(0.35, 0.65, wave(t, BLINK_MS));
        this.lamp.scale.setScalar(LAMP_R);
        this.lampMaterial.color.lerpColors(AMBER_DIM, AMBER, k);
        break;
      }
      case 'offline':
        this.lamp.scale.setScalar(LAMP_R);
        this.lampMaterial.color.copy(RED);
        break;
    }
  }
}

/** 0 to 1 and back over `period` ms. */
function wave(t: number, period: number, phase = 0): number {
  return 0.5 + 0.5 * Math.sin((2 * Math.PI * t) / period + phase);
}

function smoothstep(a: number, b: number, x: number): number {
  const k = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return k * k * (3 - 2 * k);
}

const PHASE_TEXT: Partial<Record<string, string>> = {
  idle: 'What do you want to learn?',
  planning: 'Planning your lesson…',
  locating: 'Looking for the objects…',
  calibrating: 'Setting up…',
  done: 'Lesson complete!',
  failed: 'Something went wrong.',
};

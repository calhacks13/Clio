import { Group, Mesh, MeshBasicMaterial, PlaneGeometry, Vector3 } from 'three';
import type { Text } from 'troika-three-text';
import { rotateVec } from '../../../core/math';
import { jointPosition } from '../../../domain/hands/features';
import { drawOnTop } from '../on-top';
import { InstructionPanelMotion } from '../panel-motion';
import type { PresentContext, Presenter } from '../presenter';
import { makeText, setText } from '../text';
import {
  ARMED_W,
  CLOSE_D,
  CloseButton,
  roundedRect,
  STRIP_H,
  VoiceStrip,
  type VoiceStripState,
} from './card-controls';

// A content-fitted instruction card, placed beside the objects by panel-placement.ts. The step and
// instruction lead; corrections appear only when the learner needs them. Conversation stays in
// the voice channel, without a duplicate transcript: the voice strip across the card's top only
// moves while someone speaks or Clio thinks (card-controls.ts). Its red close button ends the
// lesson, whatever stage it is at, and the card asks what the learner wants instead.

const TOP = 0.15;
/** The card's fixed top edge; width and height come from its rendered content. */
export const PANEL_TOP = TOP;
const MIN_WIDTH = 0.2;
const MIN_PHASE_WIDTH = 0.16;
const MAX_WIDTH = 0.38;
const BUTTON_TOUCH = 0.03;
const BUTTON_COOLDOWN_MS = 1500;
const PANEL_COLOR = 0xffffff;
const BUTTON_COLOR = 0x0f1117;
const INK = 0x0f1117;
const MUTED = 0x5b6472;
const ERROR = 0xa52d3d;
const HEADER_SIZE = 0.012;
const LINE = 1.21;
const PAD = 0.022;
const HEADER_Y = TOP - PAD;
const MAX_TEXT_W = MAX_WIDTH - PAD * 2;
const GAP_HEADER = 0.014;
const GAP_DETAIL = 0.01;
const GAP_STATUS = 0.016;
const GAP_BUTTON = 0.018;
const PAD_BOTTOM = 0.022;
const BUTTON_W = 0.076;
const BUTTON_H = 0.037;
const HEADER_LINE = HEADER_SIZE * LINE;
/** Between the step count and the close button. */
const CONTROL_GAP = 0.008;
/** The voice strip sits this far below the card's top edge, and this far above the top row. */
const STRIP_MARGIN = 0.01;
const STRIP_GAP = 0.009;
const MOTION_PREFERENCE =
  typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;

export class InstructionPanelPresenter implements Presenter {
  readonly object = new Group();
  private readonly header = makeText({ size: HEADER_SIZE, color: MUTED, maxWidth: MAX_TEXT_W });
  private readonly instruction = makeText({
    size: 0.023,
    color: INK,
    maxWidth: MAX_TEXT_W,
    bold: true,
  });
  private readonly detail = makeText({ size: 0.015, color: MUTED, maxWidth: MAX_TEXT_W });
  private readonly status = makeText({ size: 0.015, color: ERROR, maxWidth: MAX_TEXT_W });
  private readonly background = new Mesh(
    roundedRect(MIN_WIDTH, 0.1, 0.014),
    new MeshBasicMaterial({ color: PANEL_COLOR }),
  );
  private readonly bar = new Mesh(
    new PlaneGeometry(1, 0.0025),
    new MeshBasicMaterial({ color: 0x1768d9 }),
  );
  private readonly button = new Group();
  private readonly buttonMaterial = new MeshBasicMaterial({ color: BUTTON_COLOR });
  private readonly strip = new VoiceStrip();
  private readonly close = new CloseButton();
  /** The card keeps room for the voice strip: a coach listens, or a lesson is being planned. */
  private stripSlot = false;
  private readonly tips: Vector3[] = [];
  private lastPress = Number.NEGATIVE_INFINITY;
  private panelW = MIN_WIDTH;
  private panelH = 0.1;
  private progress = 0;
  private latestContext: PresentContext | null = null;
  // Detached texts measure actual font metrics without wrapping. They are never added to the scene.
  private readonly measures = [
    makeText({ size: HEADER_SIZE, color: MUTED }),
    makeText({ size: 0.023, color: INK, bold: true }),
    makeText({ size: 0.015, color: MUTED }),
    makeText({ size: 0.015, color: ERROR }),
  ];
  private readonly measureDone = () => this.applyMeasuredWidth();
  private readonly motion = new InstructionPanelMotion({
    reducedMotion: () => MOTION_PREFERENCE?.matches ?? false,
  });
  /** Text lays itself out asynchronously; each finished layout re-stacks the panel. */
  private readonly relayout = () => this.layout();

  /**
   * Whether a fingertip (world space) is on something drawn over the card (the widgets' column),
   * so touching there does not press Done. Null: nothing is.
   */
  coveredBy: ((tip: Vector3) => boolean) | null = null;

  /**
   * @param onDone called when the learner touches the Done button.
   * @param onClose called when the learner ends the lesson with the close button; without it the
   *   card has none.
   */
  constructor(
    private readonly onDone: () => void,
    private readonly onClose?: () => void,
  ) {
    const buttonBg = new Mesh(roundedRect(BUTTON_W, BUTTON_H, BUTTON_H / 2), this.buttonMaterial);
    const buttonLabel = makeText({
      size: 0.014,
      color: 0xffffff,
      anchorX: 'center',
      anchorY: 'middle',
      bold: true,
    });
    setText(buttonLabel, 'Done');
    buttonLabel.position.z = 0.001;
    buttonLabel.outlineWidth = 0;
    this.button.add(buttonBg, buttonLabel);
    this.button.position.z = 0.003;
    this.button.visible = false;
    for (const text of [this.header, this.instruction, this.detail, this.status]) {
      text.position.set(0, HEADER_Y, 0.001);
      text.overflowWrap = 'break-word';
      text.outlineWidth = 0;
      text.addEventListener('synccomplete', this.relayout);
    }
    for (const measure of this.measures) measure.addEventListener('synccomplete', this.measureDone);
    this.object.visible = false;
    this.bar.position.z = 0.002;
    this.strip.object.position.z = 0.002;
    this.close.object.position.z = 0.003;
    this.close.object.visible = false;
    this.object.add(
      this.background,
      this.header,
      this.instruction,
      this.detail,
      this.status,
      this.bar,
      this.button,
      this.strip.object,
      this.close.object,
    );
    // Over the glow and the hands (on-top.ts), layered by renderOrder: the card, then the bar and
    // the text, then the buttons and the voice strip, then the buttons' labels.
    this.background.renderOrder = 0;
    this.bar.renderOrder = 1;
    for (const text of [this.header, this.instruction, this.detail, this.status]) {
      text.renderOrder = 2;
    }
    buttonBg.renderOrder = 3;
    buttonLabel.renderOrder = 4;
    drawOnTop(this.object);
    this.layout();
  }

  /** Actual dimensions of the visible content and its padding, in metres. */
  get panelWidth(): number {
    return this.panelW;
  }

  get panelHeight(): number {
    return this.panelH;
  }

  /** What the voice strip shows now, and each bar's height (m). */
  get voiceStrip(): { state: VoiceStripState; levels: readonly number[] } {
    return { state: this.strip.showing, levels: this.strip.levels };
  }

  /** Where the close button's circle is, world space (written into `out`). */
  closeButtonAt(out: Vector3): Vector3 {
    return this.close.object.getWorldPosition(out);
  }

  /** Whether the close button shows, and whether its next touch ends the lesson. */
  get closeButton(): { visible: boolean; armed: boolean } {
    return { visible: this.close.object.visible, armed: this.close.armed };
  }

  update(ctx: PresentContext): void {
    this.latestContext = ctx;
    const s = ctx.snapshot;
    let header = '';
    let instruction = '';
    let detail = '';
    if (ctx.calibration) {
      header = 'Work area';
      instruction = ctx.calibration.text;
      detail =
        ctx.calibration.error ?? 'Touch the table with your index finger and thumb together.';
    } else if (s.instruction) {
      const i = s.instruction;
      header = stepHeader(i.index, i.total);
      instruction = i.text;
      detail = i.detail ?? '';
    } else {
      instruction = PHASE_TEXT[s.phase] ?? '';
    }

    const withButton = !!s.instruction && !ctx.calibration;
    const withClose = !!this.onClose && !ctx.calibration && s.phase !== 'idle';
    const stripSlot = s.voice !== 'off' || s.phase === 'planning';
    if (
      this.button.visible !== withButton ||
      this.close.object.visible !== withClose ||
      this.stripSlot !== stripSlot
    ) {
      this.button.visible = withButton;
      this.close.object.visible = withClose;
      if (!withClose) this.close.disarm();
      this.stripSlot = stripSlot;
      this.layout();
    }
    const missing = s.missing.length
      ? `Can't see: ${s.missing.join(', ')}. Pinch it to show me.`
      : '';
    const offline =
      withButton && (s.coach === 'error' || s.coach === 'closed')
        ? 'Voice offline. Use Done to continue.'
        : '';
    const line = s.toast?.kind === 'mistake' ? s.toast.text : missing || offline;
    const content = [header, instruction, detail, line];
    this.measures.forEach((measure, index) => {
      setText(measure, content[index] ?? '');
    });
    this.applyMeasuredWidth();
    this.status.color = s.toast?.kind === 'mistake' || offline ? ERROR : MUTED;

    this.progress = Math.max(0, Math.min(1, s.instruction?.progress ?? 0));
    this.layout();
    this.follow(ctx);
    const voice: VoiceStripState =
      s.voice === 'speaking' || s.voice === 'hearing'
        ? s.voice
        : s.voice === 'thinking' || s.phase === 'planning'
          ? 'thinking'
          : null;
    this.strip.update(stripSlot ? voice : null, ctx.t, ctx.dt, MOTION_PREFERENCE?.matches ?? false);
    if (withButton && this.object.visible) this.pressCheck(ctx);
    if (withClose && this.object.visible) this.closeCheck(ctx);
    // Armed, the close button's pill takes the top row.
    this.header.visible = !this.close.armed;
  }

  /** Choose a wrap measure from real unwrapped glyph area, never a character-count estimate. */
  private applyMeasuredWidth(): void {
    if (!this.measures.every(currentLayout)) return;
    const widths = this.measures.map(measuredWidth);
    const area = this.measures.reduce(
      (sum, measure) => sum + measuredWidth(measure) * measuredHeight(measure),
      0,
    );
    const minWidth = this.button.visible ? MIN_WIDTH : MIN_PHASE_WIDTH;
    const simple =
      !this.button.visible &&
      this.measures.every((measure, index) => index === 1 || measure.text === '');
    const preferred = simple
      ? Math.max(...widths)
      : Math.min(Math.max(...widths), Math.sqrt(area * 2.4));
    const wrap = Math.min(MAX_TEXT_W, Math.max(minWidth - PAD * 2, preferred));
    const lines = [this.header, this.instruction, this.detail, this.status];
    lines.forEach((line, index) => {
      const value = this.measures[index]?.text ?? '';
      if (line.text !== value || Math.abs(line.maxWidth - wrap) > 1e-6) {
        line.text = value;
        line.maxWidth = wrap;
        line.sync();
      }
    });
  }

  private layout(): void {
    // The voice strip across the top, then the top row: the step count, and the close button on
    // the right.
    const rowTop = this.stripSlot ? TOP - STRIP_MARGIN - STRIP_H - STRIP_GAP : HEADER_Y;
    const headerHeight = measuredHeight(this.header);
    const headerLine = headerHeight > 0 ? Math.max(headerHeight, HEADER_LINE) : 0;
    const withClose = this.close.object.visible;
    const rowHeight = Math.max(headerLine, withClose ? CLOSE_D : 0);
    const controls = withClose ? CLOSE_D : 0;
    const rowCenter = rowTop - rowHeight / 2;
    this.header.position.y = rowCenter + headerLine / 2;
    let y = rowTop - rowHeight;
    const instruction = measuredHeight(this.instruction);
    if (instruction > 0) {
      // A row taller than the step count keeps the text's spacing, not the controls'.
      const gap =
        rowHeight > 0 ? Math.max(0.006, GAP_HEADER - Math.max(0, rowHeight - HEADER_LINE) / 2) : 0;
      this.instruction.position.y = y - gap;
      y -= gap + instruction;
    }
    const detail = measuredHeight(this.detail);
    if (detail > 0) {
      this.detail.position.y = y - GAP_DETAIL;
      y -= GAP_DETAIL + detail;
    }
    const status = measuredHeight(this.status);
    if (status > 0) {
      this.status.position.y = y - GAP_STATUS;
      y -= GAP_STATUS + status;
    }
    const contentBottom = this.button.visible ? y - GAP_BUTTON - BUTTON_H : y;
    const bottom = contentBottom - PAD_BOTTOM;
    const height = TOP - bottom;
    const minWidth = this.button.visible ? MIN_WIDTH : MIN_PHASE_WIDTH;
    const lines = [this.header, this.instruction, this.detail, this.status];
    const headerWidth = measuredWidth(this.header);
    const row = headerWidth + controls + (headerWidth > 0 && controls > 0 ? CONTROL_GAP * 2 : 0);
    const width = Math.max(
      minWidth,
      ...lines.map(measuredWidth).map((w) => w + PAD * 2),
      row + PAD * 2,
      withClose ? ARMED_W + PAD * 2 : 0,
    );
    const resized = Math.abs(width - this.panelW) > 1e-6 || Math.abs(height - this.panelH) > 1e-6;
    if (resized) {
      this.background.geometry.dispose();
      this.background.geometry = roundedRect(width, height, 0.014);
      this.panelW = width;
      this.panelH = height;
    }
    const left = -this.panelW / 2 + PAD;
    for (const line of lines) line.position.x = left;
    this.background.position.y = TOP - this.panelH / 2;
    this.button.position.set(
      this.panelW / 2 - PAD - BUTTON_W / 2,
      bottom + PAD_BOTTOM + BUTTON_H / 2,
      0.003,
    );
    const closeX = this.panelW / 2 - PAD - CLOSE_D / 2;
    this.close.object.position.set(closeX, rowCenter, 0.003);
    this.strip.setWidth(this.panelW - PAD * 2);
    this.strip.object.position.set(0, TOP - STRIP_MARGIN - STRIP_H / 2, 0.002);
    this.bar.visible = this.progress > 0;
    this.bar.scale.x = Math.max(0.0001, this.progress * (this.panelW - PAD * 2));
    this.bar.position.x = left + (this.progress * (this.panelW - PAD * 2)) / 2;
    this.bar.position.y = bottom + 0.008;
    if (
      this.latestContext &&
      lines.every((line, index) => currentLayout(line) && line.text === this.measures[index]?.text)
    ) {
      this.object.visible = lines.some((line) => line.text.trim().length > 0);
    }
    // Troika finishes between frames. Resize and mask clearance must change together.
    if (resized && this.latestContext) this.follow(this.latestContext);
  }

  private follow(ctx: PresentContext): void {
    const pose = this.motion.update(ctx, this.panelW, this.panelH, TOP);
    this.object.position.set(...pose.p);
    this.object.quaternion.set(...pose.q);
  }

  /** Index fingertip (either hand) touching the button, in world space. */
  private pressCheck(ctx: PresentContext): void {
    if (!ctx.hands || ctx.t - this.lastPress < BUTTON_COOLDOWN_MS) return;
    const center = this.button.getWorldPosition(new Vector3());
    for (const hand of [ctx.hands.left, ctx.hands.right]) {
      if (!hand) continue;
      const tip = jointPosition(hand, 'index-finger-tip');
      const w = ctx.worldFromWorkspace;
      const r = rotateVec(w.q, tip);
      const world = new Vector3(w.p[0] + r[0], w.p[1] + r[1], w.p[2] + r[2]);
      if (world.distanceTo(center) < BUTTON_TOUCH && !this.coveredBy?.(world)) {
        this.lastPress = ctx.t;
        this.buttonMaterial.color.setHex(0x24303d);
        setTimeout(() => this.buttonMaterial.color.setHex(BUTTON_COLOR), 300);
        this.onDone();
        return;
      }
    }
  }

  /** Fingertips (either hand) on the close button: the first touch arms it, the next ends. */
  private closeCheck(ctx: PresentContext): void {
    this.tips.length = 0;
    for (const hand of [ctx.hands?.left, ctx.hands?.right]) {
      if (!hand) continue;
      const tip = jointPosition(hand, 'index-finger-tip');
      const w = ctx.worldFromWorkspace;
      const r = rotateVec(w.q, tip);
      this.tips.push(new Vector3(w.p[0] + r[0], w.p[1] + r[1], w.p[2] + r[2]));
    }
    const covered = (tip: Vector3) => this.coveredBy?.(tip) ?? false;
    if (this.close.update(ctx.t, this.tips, covered)) this.onClose?.();
  }

  dispose(): void {
    this.strip.dispose();
    this.close.dispose();
    for (const text of [this.header, this.instruction, this.detail, this.status]) {
      text.removeEventListener('synccomplete', this.relayout);
      text.dispose();
    }
    for (const measure of this.measures) {
      measure.removeEventListener('synccomplete', this.measureDone);
      measure.dispose();
    }
    (this.button.children[1] as Text).dispose();
    (this.button.children[0] as Mesh).geometry.dispose();
    this.background.geometry.dispose();
    this.background.material.dispose();
    this.bar.geometry.dispose();
    this.bar.material.dispose();
    this.buttonMaterial.dispose();
  }
}

export function stepHeader(index: number, total: number): string {
  return `Step ${Math.min(index + 1, total)} of ${total}`;
}

/** A completed result belongs to a specific text and wrap width, not the latest request. */
function currentLayout(text: Text): boolean {
  const info = text.textRenderInfo;
  if (!info) return text.text === '';
  return info.parameters.text === text.text && info.parameters.maxWidth === text.maxWidth;
}

function measuredWidth(text: Text): number {
  const bounds = text.textRenderInfo?.blockBounds;
  return bounds ? bounds[2] - bounds[0] : 0;
}

function measuredHeight(text: Text): number {
  const bounds = text.textRenderInfo?.blockBounds;
  return bounds ? bounds[3] - bounds[1] : 0;
}

const PHASE_TEXT: Partial<Record<string, string>> = {
  idle: 'What can I help you with?',
  planning: 'Planning your lesson…',
  locating: 'Looking for the objects…',
  calibrating: 'Setting up…',
  done: 'Lesson complete!',
  failed: 'Something went wrong.',
};

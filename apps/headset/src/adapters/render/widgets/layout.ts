import { formatClock, formatCount } from '../../../domain/widgets/format';
import type {
  CautionWidget,
  ChecklistWidget,
  ChoicesWidget,
  ProgressWidget,
  TimerWidget,
  ValueWidget,
  Widget,
  WidgetKind,
} from '../../../domain/widgets/types';
import { DOCK, DOCK_ORDER } from './placement';
import { tabularWidth } from './tabular';
import { FIT, fitLine, fitValue, lineHeight, measure, roleSize, wrap } from './text-layout';
import type { TypeRole } from './text-port';
import { MM, WIDGET_THEME } from './theme';

// Pure layout: the dock's column (which cards stack where, which collapse to pills) and each
// kind's card, pill and chip anatomy (§6.4) as rectangles and pre-broken text. Card coordinates
// are metres from the card's top-left corner, x right and y down; views turn them into object
// positions. Runs only when a widget changes, never per frame.

const W = WIDGET_THEME.size.dockWidth;
const PAD_X = WIDGET_THEME.size.padX;
const PAD_Y = WIDGET_THEME.size.padY;
const CONTENT = W - 2 * PAD_X;
const PILL_H = WIDGET_THEME.size.pillHeight;
const CHIP_H = WIDGET_THEME.size.chipHeight;

export const DONE_TEXT = 'Done';
export const TIMES_UP_TEXT = "Time's up";

// ---- the column ---------------------------------------------------------------------------------

export interface DockItem {
  id: string;
  kind: WidgetKind;
  createdT: number;
  updatedT: number;
  doneT: number | null;
  /** An open choices widget: always the lead, never collapsed. */
  open: boolean;
  /** Expanded card height (m), from the view's layout. */
  height: number;
}

export interface DockSlot {
  id: string;
  /** Distance below the column origin (the card's top edge) to the slot's top (m). */
  top: number;
  height: number;
  collapsed: boolean;
}

/** The lead: an open choice, else the latest doneT still lingering, else the latest updatedT. */
export function leadOf(items: readonly DockItem[]): string | null {
  let lead: DockItem | null = null;
  for (const item of items) if (item.open) return item.id;
  for (const item of items) {
    if (item.doneT !== null && (lead === null || item.doneT > (lead.doneT ?? -Infinity))) {
      lead = item;
    }
  }
  if (lead) return lead.id;
  for (const item of items) if (lead === null || item.updatedT > lead.updatedT) lead = item;
  return lead?.id ?? null;
}

/** Top to bottom by DOCK_ORDER, ties by createdT. */
function dockOrder(a: Pick<DockItem, 'kind' | 'createdT'>, b: typeof a): number {
  return DOCK_ORDER.indexOf(a.kind) - DOCK_ORDER.indexOf(b.kind) || a.createdT - b.createdT;
}

/** A caution never collapses: its text is the hazard, and a pill would cut it. */
const neverCollapses = (item: DockItem): boolean => item.open || item.kind === 'caution';

/**
 * Stacks the items in DOCK_ORDER. The lead stays expanded; the others stay expanded while the
 * column fits `budget`, else collapse to pills, the oldest updatedT first. An open choice and the
 * caution never collapse. A column still too tall runs on downward (a caution beside a tall lead).
 */
export function layoutDock(
  items: readonly DockItem[],
  budget: number = DOCK.budget,
  gap: number = DOCK.gap,
  pill: number = PILL_H,
): DockSlot[] {
  const ordered = [...items].sort(dockOrder);
  const lead = leadOf(items);
  const collapsed = new Set<string>();
  const columnHeight = (): number => {
    let h = 0;
    for (const item of ordered) h += collapsed.has(item.id) ? pill : item.height;
    return h + gap * Math.max(0, ordered.length - 1);
  };
  const candidates = ordered
    .filter((item) => item.id !== lead && !neverCollapses(item))
    .sort((a, b) => a.updatedT - b.updatedT);
  for (const item of candidates) {
    if (columnHeight() <= budget + 1e-9) break;
    collapsed.add(item.id);
  }
  const slots: DockSlot[] = [];
  let top = 0;
  for (const item of ordered) {
    const isCollapsed = collapsed.has(item.id);
    const height = isCollapsed ? pill : item.height;
    slots.push({ id: item.id, top, height, collapsed: isCollapsed });
    top += height + gap;
  }
  return slots;
}

// ---- shared pieces ------------------------------------------------------------------------------

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Align = 'left' | 'center' | 'right';

/** Laid-out text: its box, its lines ('\n'-joined) and how it anchors in the box. */
export interface TextBlock {
  role: TypeRole;
  /** Font size (m). */
  size: number;
  text: string;
  lines: number;
  x: number;
  y: number;
  w: number;
  h: number;
  align: Align;
  truncated: boolean;
}

/** Rounds a height up to a whole millimetre. */
const wholeMm = (h: number): number => Math.ceil(h / MM - 1e-6) * MM;

function block(
  role: TypeRole,
  lines: readonly string[],
  x: number,
  y: number,
  w: number,
  align: Align = 'left',
  size: number = roleSize(role),
  truncated = false,
): TextBlock {
  const n = Math.max(1, lines.length);
  return {
    role,
    size,
    text: lines.join('\n'),
    lines: n,
    x,
    y,
    w,
    h: n * lineHeight(role, size),
    align,
    truncated,
  };
}

/** One line of text vertically centred on `cy`, in a box from x to x + w. */
function lineAt(
  role: TypeRole,
  text: string,
  x: number,
  cy: number,
  w: number,
  align: Align = 'left',
  size: number = roleSize(role),
): TextBlock {
  const line = fitLine(text, role, w, size);
  return block(role, [line], x, cy - lineHeight(role, size) / 2, w, align, size, line !== text);
}

/** One line drawn whole (a count, a value): its box is its own width, ending at `right`. */
function wholeLine(
  role: TypeRole,
  text: string,
  right: number,
  cy: number,
  align: Align,
  size: number = roleSize(role),
): TextBlock {
  const w = measure(text, role, size);
  const x = align === 'right' ? right - w : right;
  return block(role, [text], x, cy - lineHeight(role, size) / 2, w, align, size);
}

/** A done mark: a dot, a gap, then a word, centred on `cy`. */
export interface DoneMark {
  dot: Rect;
  text: TextBlock;
  width: number;
}

/** A done mark ending at `edge` (right-aligned), or starting there with `align` left. */
function doneMark(
  word: string,
  edge: number,
  cy: number,
  align: 'left' | 'right' = 'right',
  role: TypeRole = 'status',
): DoneMark {
  const dot = WIDGET_THEME.size.dot;
  const textW = measure(word, role);
  const width = dot + 6 * MM + textW;
  const left = align === 'left' ? edge : edge - width;
  return {
    dot: { x: left, y: cy - dot / 2, w: dot, h: dot },
    text: block(role, [word], left + dot + 6 * MM, cy - lineHeight(role) / 2, textW, 'left'),
    width,
  };
}

/** A ring's geometry: centre, outer diameter, stroke and end-dot diameter (m). */
export interface RingSpec {
  cx: number;
  cy: number;
  outer: number;
  stroke: number;
  dot: number;
}

// ---- cards (§6.4) ------------------------------------------------------------------------------

export interface TimerCardLayout {
  kind: 'timer';
  width: number;
  height: number;
  ring: RingSpec;
  /** The done check in the ring's centre. */
  check: Rect;
  label: TextBlock;
  /** The digits' line box (left, top, height). */
  digits: Rect;
  state: TextBlock;
}

export interface ProgressCardLayout {
  kind: 'progress';
  width: number;
  height: number;
  label: TextBlock;
  /** Right-aligned beside the label or the bar, or left-aligned on a row of its own. */
  count: TextBlock;
  done: DoneMark;
  bar: Rect;
  /** Pill segments (an integer total of at most 12 and no unit), else 1: a continuous bar. */
  segments: number;
}

export interface ChecklistRowLayout {
  /** The whole row, also its touch target. */
  row: Rect;
  circle: Rect;
  text: TextBlock;
  /** The hover tile. */
  tile: Rect;
}

export interface ChecklistCardLayout {
  kind: 'checklist';
  width: number;
  height: number;
  title: TextBlock;
  count: TextBlock;
  /** "Done" in place of the count once all are ticked: the word alone, as wide as the count. */
  done: TextBlock;
  rows: ChecklistRowLayout[];
  dividers: Rect[];
}

export interface ChoiceOptionLayout {
  /** The pill, also its touch target. */
  pill: Rect;
  label: TextBlock;
  /** The label once chosen: beside the check in two columns, left of it when too long. */
  chosenLabel: TextBlock;
  check: Rect;
}

export interface ChoicesCardLayout {
  kind: 'choices';
  width: number;
  height: number;
  question: TextBlock;
  options: ChoiceOptionLayout[];
  twoColumns: boolean;
}

export interface ValueCardLayout {
  kind: 'value';
  width: number;
  height: number;
  label: TextBlock;
  value: TextBlock;
}

export interface CautionCardLayout {
  kind: 'caution';
  width: number;
  height: number;
  disc: Rect;
  text: TextBlock;
}

export type CardLayout =
  | TimerCardLayout
  | ProgressCardLayout
  | ChecklistCardLayout
  | ChoicesCardLayout
  | ValueCardLayout
  | CautionCardLayout;

/** A 40 mm ring, about as tall as the label and 24 mm digits beside it. */
const TIMER_RING = { outer: 40 * MM, stroke: 4 * MM, dot: 7 * MM };
const TIMER_RING_X = PAD_X + TIMER_RING.outer / 2;
const TIMER_TEXT_X = TIMER_RING_X + TIMER_RING.outer / 2 + PAD_X;
const TIMER_TEXT_W = W - PAD_X - TIMER_TEXT_X;
/** The done check in the ring's centre. */
export const TIMER_CHECK = 16 * MM;

export function timerCard(w: Pick<TimerWidget, 'label'>): TimerCardLayout {
  const label = wrap(w.label, 'label', TIMER_TEXT_W, 2);
  const digitsH = lineHeight('display');
  const textH = label.height + 4 * MM + digitsH;
  const height = Math.max(TIMER_RING.outer + 2 * PAD_X, wholeMm(textH + 29 * MM));
  const top = (height - textH) / 2;
  const digitsTop = top + label.height + 4 * MM;
  const stateH = lineHeight('state');
  const cy = height / 2;
  const check = TIMER_CHECK;
  return {
    kind: 'timer',
    width: W,
    height,
    ring: { cx: TIMER_RING_X, cy, ...TIMER_RING },
    check: { x: TIMER_RING_X - check / 2, y: cy - check / 2, w: check, h: check },
    label: block(
      'label',
      label.lines,
      TIMER_TEXT_X,
      top,
      TIMER_TEXT_W,
      'left',
      undefined,
      label.truncated,
    ),
    digits: { x: TIMER_TEXT_X, y: digitsTop, w: TIMER_TEXT_W, h: digitsH },
    state: block(
      'state',
      [TIMES_UP_TEXT],
      TIMER_TEXT_X,
      digitsTop + (digitsH - stateH) / 2,
      TIMER_TEXT_W,
    ),
  };
}

/** `text` with every digit set as the role's widest: as wide as a count of that length gets. */
function widestDigits(text: string, role: TypeRole): string {
  let digit = '0';
  for (const d of '123456789') if (measure(d, role) > measure(digit, role)) digit = d;
  return text.replace(/[0-9]/g, digit);
}

/** Whether a progress bar is segmented: an integer total of at most 12, and no unit. */
export function progressSegments(w: Pick<ProgressWidget, 'total' | 'unit'>): number {
  return Number.isInteger(w.total) && w.total >= 1 && w.total <= 12 && !w.unit ? w.total : 1;
}

/** The least a bar beside the count may be; with less, the count takes a row of its own. */
export const MIN_BAR = 40 * MM;
const PROGRESS_ROW = 23 * MM;
/** The second row's centre: the count beside a shorter bar, or on a row of its own. */
const PROGRESS_ROW_2 = 44 * MM;
const BAR_H = 8 * MM;
/** From a row's centre to the top of a full-width bar under it. */
const BAR_DROP = 17 * MM;
/** Between the count and the label or bar beside it. */
const COUNT_GAP = 12 * MM;

export function progressCard(
  w: Pick<ProgressWidget, 'label' | 'value' | 'total' | 'unit'>,
): ProgressCardLayout {
  const right = W - PAD_X;
  const countText = formatCount(w.value, w.total, w.unit);
  const countW = measure(countText, 'status');
  const doneW = doneMark(DONE_TEXT, right, PROGRESS_ROW).width;
  // So the card keeps one form while the count changes and when it is done, the label and the bar
  // give way to the widest the count gets: any count up to the total, or the done mark.
  const anyCountW = measure(
    widestDigits(formatCount(w.total, w.total, w.unit), 'status'),
    'status',
  );
  const widest = Math.max(countW, anyCountW, doneW);
  const besideW = CONTENT - widest - COUNT_GAP;
  const segments = progressSegments(w);
  const card = (
    height: number,
    label: TextBlock,
    count: TextBlock,
    done: DoneMark,
    bar: Rect,
  ): ProgressCardLayout => ({
    kind: 'progress',
    width: W,
    height: wholeMm(height),
    label,
    count,
    done,
    bar,
    segments,
  });
  if (measure(w.label, 'label') <= besideW * FIT) {
    const barY = PROGRESS_ROW + BAR_DROP;
    return card(
      barY + BAR_H + PAD_Y,
      lineAt('label', w.label, PAD_X, PROGRESS_ROW, besideW),
      wholeLine('status', countText, right, PROGRESS_ROW, 'right'),
      doneMark(DONE_TEXT, right, PROGRESS_ROW),
      { x: PAD_X, y: barY, w: CONTENT, h: BAR_H },
    );
  }
  // A longer count would leave the label a few letters: the label takes the first row, and the
  // count sits beside a shorter bar while that bar keeps MIN_BAR.
  const label = lineAt('label', w.label, PAD_X, PROGRESS_ROW, CONTENT);
  if (besideW >= MIN_BAR) {
    return card(
      PROGRESS_ROW_2 + BAR_H / 2 + PAD_Y,
      label,
      wholeLine('status', countText, right, PROGRESS_ROW_2, 'right'),
      doneMark(DONE_TEXT, right, PROGRESS_ROW_2),
      { x: PAD_X, y: PROGRESS_ROW_2 - BAR_H / 2, w: besideW, h: BAR_H },
    );
  }
  // An amount longer still ("750 of 1000 grams") reads on a row of its own under the label, over
  // a full-width bar; one wider than the row ("9999 of 9999 kilogram") breaks before its unit.
  const lines =
    widest <= CONTENT * FIT || !w.unit
      ? [countText]
      : [formatCount(w.value, w.total, null), w.unit];
  const lh = lineHeight('status');
  let linesW = 0;
  for (const line of lines) linesW = Math.max(linesW, measure(line, 'status'));
  const barY = PROGRESS_ROW_2 + (lines.length - 1) * lh + BAR_DROP;
  return card(
    barY + BAR_H + PAD_Y,
    label,
    block('status', lines, PAD_X, PROGRESS_ROW_2 - lh / 2, linesW, 'left'),
    doneMark(DONE_TEXT, PAD_X, PROGRESS_ROW_2, 'left'),
    { x: PAD_X, y: barY, w: CONTENT, h: BAR_H },
  );
}

const CHECK_CIRCLE = 18 * MM;
const ROW_TEXT_X = 44 * MM;
const ROW_TEXT_W = 120 * MM;

/** "1 of 3": how many items are done. */
export function checklistCount(w: Pick<ChecklistWidget, 'items'>): string {
  let done = 0;
  for (const item of w.items) if (item.done) done++;
  return `${done} of ${w.items.length}`;
}

export function checklistCard(
  w: Pick<ChecklistWidget, 'title' | 'items' | 'status'>,
): ChecklistCardLayout {
  const right = W - PAD_X;
  const headerCy = 25 * MM;
  const count = checklistCount(w);
  // So the title keeps one room while items are ticked and once all are, it gives way to the
  // widest count the list can show (its done count set in the widest digit) or to "Done", which
  // is no wider: an 11-character title stays whole through the 4 s the list shows done.
  const n = w.items.length;
  const widestCount = `${widestDigits(String(n), 'label')} of ${n}`;
  const countW = Math.max(measure(widestCount, 'label'), measure(DONE_TEXT, 'status'));
  const rows: ChecklistRowLayout[] = [];
  const dividers: Rect[] = [];
  let y = 40 * MM;
  for (const [i, item] of w.items.entries()) {
    const text = wrap(item.text, 'body', ROW_TEXT_W, 2);
    const h = text.lines.length > 1 ? 50 * MM : 32 * MM;
    if (i > 0) {
      dividers.push({
        x: ROW_TEXT_X,
        y: y - WIDGET_THEME.size.hairline / 2,
        w: right - ROW_TEXT_X,
        h: WIDGET_THEME.size.hairline,
      });
    }
    const cy = y + h / 2;
    rows.push({
      row: { x: 6 * MM, y, w: W - 12 * MM, h },
      circle: { x: PAD_X, y: cy - CHECK_CIRCLE / 2, w: CHECK_CIRCLE, h: CHECK_CIRCLE },
      text: block(
        'body',
        text.lines,
        ROW_TEXT_X,
        cy - text.height / 2,
        ROW_TEXT_W,
        'left',
        undefined,
        text.truncated,
      ),
      tile: { x: 6 * MM, y, w: W - 12 * MM, h },
    });
    y += h;
  }
  return {
    kind: 'checklist',
    width: W,
    height: y + 10 * MM,
    title: lineAt('title', w.title, PAD_X, headerCy, CONTENT - countW - 8 * MM),
    count: wholeLine('label', count, right, headerCy, 'right'),
    done: wholeLine('status', DONE_TEXT, right, headerCy, 'right'),
    rows,
    dividers,
  };
}

const OPTION_H = 38 * MM;
const OPTION_GAP = 8 * MM;
const OPTION_HALF = (CONTENT - OPTION_GAP) / 2;
/** Two columns only for exactly two options that both measure at most this. */
const TWO_COLUMN_MAX = 42 * MM;
/** A label's room from a pill's round ends: stacked (the chosen check's inset), two columns. */
const OPTION_INSET = 14 * MM;
const OPTION_INSET_HALF = 8 * MM;
const CHOSEN_CHECK = 10 * MM;
/** Between a chosen label and its check. */
const CHECK_GAP = 6 * MM;

export function choicesCard(w: Pick<ChoicesWidget, 'question' | 'options'>): ChoicesCardLayout {
  const question = wrap(w.question, 'title', CONTENT, 4);
  const twoColumns =
    w.options.length === 2 && w.options.every((o) => measure(o, 'strong') <= TWO_COLUMN_MAX);
  const top = PAD_Y + question.height + 12 * MM;
  const options: ChoiceOptionLayout[] = [];
  for (const [i, option] of w.options.entries()) {
    const pill: Rect = twoColumns
      ? { x: PAD_X + i * (OPTION_HALF + OPTION_GAP), y: top, w: OPTION_HALF, h: OPTION_H }
      : { x: PAD_X, y: top + i * (OPTION_H + OPTION_GAP), w: CONTENT, h: OPTION_H };
    const cy = pill.y + pill.h / 2;
    // At rest the label is centred in the pill, clear of its round ends.
    const inset = twoColumns ? OPTION_INSET_HALF : OPTION_INSET;
    const label = lineAt('strong', option, pill.x + inset, cy, pill.w - 2 * inset, 'center');
    const labelW = measure(label.text, 'strong');
    // Chosen, a check sits 14 mm from the pill's right end (stacked): the label stays centred
    // while it clears the check. A longer one, and any in two columns, is centred together with
    // the check, so a chosen answer keeps every letter it had at rest.
    let chosenLabel = label;
    let checkCx = pill.x + pill.w - OPTION_INSET - CHOSEN_CHECK / 2;
    if (twoColumns || labelW > (pill.w - 2 * (OPTION_INSET + CHOSEN_CHECK + CHECK_GAP)) * FIT) {
      const left = pill.x + (pill.w - (labelW + CHECK_GAP + CHOSEN_CHECK)) / 2;
      const y = cy - lineHeight('strong') / 2;
      chosenLabel = block(
        'strong',
        [label.text],
        left,
        y,
        labelW,
        'center',
        undefined,
        label.truncated,
      );
      checkCx = left + labelW + CHECK_GAP + CHOSEN_CHECK / 2;
    }
    options.push({
      pill,
      label,
      chosenLabel,
      check: {
        x: checkCx - CHOSEN_CHECK / 2,
        y: cy - CHOSEN_CHECK / 2,
        w: CHOSEN_CHECK,
        h: CHOSEN_CHECK,
      },
    });
  }
  const optionsH = twoColumns
    ? OPTION_H
    : w.options.length * OPTION_H + Math.max(0, w.options.length - 1) * OPTION_GAP;
  return {
    kind: 'choices',
    width: W,
    height: wholeMm(top + optionsH + PAD_Y),
    question: block(
      'title',
      question.lines,
      PAD_X,
      PAD_Y,
      CONTENT,
      'left',
      undefined,
      question.truncated,
    ),
    options,
    twoColumns,
  };
}

export function valueCard(w: Pick<ValueWidget, 'label' | 'value'>): ValueCardLayout {
  const label = lineAt('label', w.label, PAD_X, PAD_Y + lineHeight('label') / 2, CONTENT);
  const fit = fitValue(w.value, CONTENT);
  const valueTop = PAD_Y + label.h + 4 * MM;
  return {
    kind: 'value',
    width: W,
    height: wholeMm(valueTop + fit.height + PAD_Y),
    label,
    value: block('figure', fit.lines, PAD_X, valueTop, CONTENT, 'left', fit.size),
  };
}

const CAUTION_DISC = 20 * MM;
const CAUTION_TEXT_X = 46 * MM;
const CAUTION_TEXT_W = 118 * MM;

export function cautionCard(w: Pick<CautionWidget, 'text'>): CautionCardLayout {
  const text = wrap(w.text, 'strong', CAUTION_TEXT_W, 5);
  const discCy = PAD_Y + CAUTION_DISC / 2;
  const body = Math.max(CAUTION_DISC, text.height);
  const y = text.lines.length === 1 ? discCy - text.height / 2 : PAD_Y;
  return {
    kind: 'caution',
    width: W,
    height: wholeMm(PAD_Y + body + PAD_Y),
    disc: { x: PAD_X, y: PAD_Y, w: CAUTION_DISC, h: CAUTION_DISC },
    text: block(
      'strong',
      text.lines,
      CAUTION_TEXT_X,
      y,
      CAUTION_TEXT_W,
      'left',
      undefined,
      text.truncated,
    ),
  };
}

/** A widget's expanded card. */
export function cardLayout(w: Widget): CardLayout {
  switch (w.kind) {
    case 'timer':
      return timerCard(w);
    case 'progress':
      return progressCard(w);
    case 'checklist':
      return checklistCard(w);
    case 'choices':
      return choicesCard(w);
    case 'value':
      return valueCard(w);
    case 'caution':
      return cautionCard(w);
  }
}

// ---- pills (the collapsed form, 180 x 34) ------------------------------------------------------

export interface PillLayout {
  kind: WidgetKind;
  width: number;
  height: number;
  /** Timer: the ring. */
  ring: RingSpec | null;
  /** Timer: the digits' line box; their width is the longest clock this timer shows. */
  digits: Rect | null;
  /** Progress: the mini bar. Caution: the "!" disc. */
  mark: Rect | null;
  /** Left text: the label, title, question or caution. */
  primary: TextBlock;
  /** The count, value, answer or "Done", or null. */
  secondary: TextBlock | null;
}

const PILL_PAD = 14 * MM;
const PILL_RING = { outer: 22 * MM, stroke: 3 * MM, dot: 5 * MM };
/** A progress pill's mini bar: short, so a two-word label (about 70 mm) fits beside "3 of 4". */
export const PILL_BAR = { w: 20 * MM, h: 6 * MM };
/** Less room than this beside a pill's count, and it shows no label rather than a few letters. */
const PILL_LABEL_MIN = 30 * MM;

export function pillLayout(w: Widget): PillLayout {
  const cy = PILL_H / 2;
  const right = W - PILL_PAD;
  const base = { kind: w.kind, width: W, height: PILL_H, ring: null, digits: null, mark: null };
  switch (w.kind) {
    case 'timer': {
      const digitsW = tabularWidth(formatClock(w.durationMs), 'pillValue');
      const done = measure(DONE_TEXT, 'status');
      const x = 36 * MM;
      const labelX = x + Math.max(digitsW, done) + 10 * MM;
      const h = lineHeight('pillValue');
      return {
        ...base,
        ring: { cx: 17 * MM, cy, ...PILL_RING },
        digits: { x, y: cy - h / 2, w: digitsW, h },
        primary: lineAt('label', w.label, labelX, cy, right - labelX),
        secondary: wholeLine('status', DONE_TEXT, x, cy, 'left'),
      };
    }
    case 'progress': {
      // The count comes first: after the mini bar, or alone when a long amount needs the room
      // (cut only past that, a backstop); the label takes what is left, if that is enough. As on
      // the card, the form follows the widest the count gets (any count up to the total, or
      // "Done"), so the bar and the label never come and go as it counts.
      const full = w.status === 'done' ? DONE_TEXT : formatCount(w.value, w.total, w.unit);
      const widest = Math.max(
        measure(full, 'status'),
        measure(widestDigits(formatCount(w.total, w.total, w.unit), 'status'), 'status'),
        measure(DONE_TEXT, 'status'),
      );
      const afterBar = PILL_PAD + PILL_BAR.w + 8 * MM;
      const withBar = widest <= (right - afterBar) * FIT;
      const x = withBar ? afterBar : PILL_PAD;
      const count = fitLine(full, 'status', right - x);
      const labelX = x + measure(count, 'status') + 10 * MM;
      const room = right - x - Math.min(widest, right - x) - 10 * MM;
      return {
        ...base,
        mark: withBar
          ? { x: PILL_PAD, y: cy - PILL_BAR.h / 2, w: PILL_BAR.w, h: PILL_BAR.h }
          : null,
        primary: lineAt(
          'label',
          room >= PILL_LABEL_MIN ? w.label : '',
          labelX,
          cy,
          Math.max(0, room),
        ),
        secondary: wholeLine('status', count, x, cy, 'left'),
      };
    }
    case 'checklist': {
      const count = w.status === 'done' ? DONE_TEXT : checklistCount(w);
      const countW = measure(count, 'status');
      return {
        ...base,
        primary: lineAt('label', w.title, PILL_PAD, cy, right - PILL_PAD - countW - 10 * MM),
        secondary: wholeLine('status', count, right, cy, 'right'),
      };
    }
    case 'choices': {
      const answer = w.chosen === null ? null : (w.options[w.chosen] ?? null);
      const shown = answer ? fitLine(answer, 'status', 60 * MM) : null;
      const answerW = shown ? measure(shown, 'status') : 0;
      return {
        ...base,
        primary: lineAt(
          'label',
          w.question,
          PILL_PAD,
          cy,
          right - PILL_PAD - (answer ? answerW + 10 * MM : 0),
        ),
        secondary: shown ? wholeLine('status', shown, right, cy, 'right') : null,
      };
    }
    case 'value': {
      const valueW = measure(w.value, 'pillValue');
      return {
        ...base,
        primary: lineAt(
          'label',
          w.label,
          PILL_PAD,
          cy,
          Math.max(0, right - PILL_PAD - valueW - 10 * MM),
        ),
        secondary: block(
          'pillValue',
          [w.value],
          right - valueW,
          cy - lineHeight('pillValue') / 2,
          valueW,
          'right',
        ),
      };
    }
    case 'caution': {
      // The dock never collapses a caution (layoutDock): this is the backstop, not a state.
      const disc = 16 * MM;
      const x = 9 * MM + disc + 8 * MM;
      return {
        ...base,
        mark: { x: 9 * MM, y: cy - disc / 2, w: disc, h: disc },
        primary: lineAt('strong', w.text, x, cy, right - x),
        secondary: null,
      };
    }
  }
}

// ---- the timer's chip beside its object (30 tall, as wide as its label) ----------------------

export interface ChipLayout {
  width: number;
  height: number;
  ring: RingSpec;
  digits: Rect;
  /** Digit size (m): pillValue at 14 mm. */
  digitSize: number;
  label: TextBlock;
  done: TextBlock;
}

const CHIP_RING = { outer: 18 * MM, stroke: 2.5 * MM, dot: 4.5 * MM };
const CHIP_DIGIT_SIZE = 14 * MM;
/**
 * The label's most room: a whole 16-character label (the tool's limit) of realistic words, the
 * widest "Woodscrews dried" at 117 mm, so a chip is at most about 207 mm wide.
 */
const CHIP_LABEL_W = 122 * MM;
/** Gap after the digits, and padding before the chip's round right end. */
const CHIP_GAP = 6 * MM;
const CHIP_END = 10 * MM;

export function chipLayout(w: Pick<TimerWidget, 'label' | 'durationMs'>): ChipLayout {
  const cy = CHIP_H / 2;
  const x = 30 * MM;
  const size = CHIP_DIGIT_SIZE;
  const digitsW = tabularWidth(formatClock(w.durationMs), 'pillValue', size);
  const doneW = measure(DONE_TEXT, 'status');
  const labelX = x + Math.max(digitsW, doneW) + CHIP_GAP;
  // The chip grows with its label, so the label draws whole as it does on the dock's card.
  const label = lineAt('label', w.label, labelX, cy, CHIP_LABEL_W);
  const labelW = Math.min(CHIP_LABEL_W, measure(label.text, 'label'));
  const h = lineHeight('pillValue', size);
  return {
    width: labelX + labelW + CHIP_END,
    height: CHIP_H,
    ring: { cx: cy, cy, ...CHIP_RING },
    digits: { x, y: cy - h / 2, w: digitsW, h },
    digitSize: size,
    label: { ...label, w: labelW },
    done: wholeLine('status', DONE_TEXT, x, cy, 'left'),
  };
}

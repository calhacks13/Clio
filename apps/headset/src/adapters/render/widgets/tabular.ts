import { FONT_METRICS } from './font-metrics';
import { onTopGroup } from './layering';
import { roleSize } from './text-layout';
import type { TextFactory, TextHandle, TypeRole } from './text-port';
import { WIDGET_THEME } from './theme';

// Tabular digits for clocks. troika applies no `tnum`, and Inter's digits are proportional (a 1 is
// 0.385 em, a 0 0.630 em in Inter Tight 600), so a running clock would jitter. Each character gets
// its own one-character text centred in a fixed cell: every digit cell is the face's widest digit,
// any other character its own advance. A tick re-sets only the cells whose character changed.

export interface TabularSlot {
  char: string;
  /** The cell's left edge (m) from the start of the text. */
  x: number;
  width: number;
}

const DIGITS = '0123456789';

/** The widest digit's advance (m) in the role's face at `size`. */
export function digitCell(role: TypeRole, size: number = roleSize(role)): number {
  const advances = FONT_METRICS[WIDGET_THEME.type[role].face].advances;
  let widest = 0;
  for (const d of DIGITS) widest = Math.max(widest, advances[d] ?? 0);
  return widest * size;
}

/** A character's cell (m): the digit cell for a digit, else its own advance. */
export function cellWidth(char: string, role: TypeRole, size: number = roleSize(role)): number {
  if (char >= '0' && char <= '9' && char.length === 1) return digitCell(role, size);
  return (FONT_METRICS[WIDGET_THEME.type[role].face].advances[char] ?? 0.6) * size;
}

/** Where each character of `text` sits: positions depend only on which characters are digits. */
export function tabularSlots(
  text: string,
  role: TypeRole,
  size: number = roleSize(role),
): TabularSlot[] {
  const slots: TabularSlot[] = [];
  let x = 0;
  for (const char of text) {
    const width = cellWidth(char, role, size);
    slots.push({ char, x, width });
    x += width;
  }
  return slots;
}

/** The whole text's width (m) in tabular cells. */
export function tabularWidth(text: string, role: TypeRole, size: number = roleSize(role)): number {
  let x = 0;
  for (const char of text) x += cellWidth(char, role, size);
  return x;
}

/** A clock drawn in tabular cells, left-aligned at its object's origin, top at y 0. */
export class TabularText {
  readonly object = onTopGroup();
  private readonly cells: TextHandle[] = [];
  private readonly chars: string[] = [];
  private current = '';
  private widthNow = 0;

  /**
   * @param cells the most characters it shows ("60:00" is five).
   * @param size font size (m), the role's own by default.
   */
  constructor(
    text: TextFactory,
    private readonly role: TypeRole,
    cells = 5,
    private readonly size: number = roleSize(role),
  ) {
    for (let i = 0; i < cells; i++) {
      const cell = text(role, { x: 'center', y: 'top' });
      if (size !== roleSize(role)) cell.setSize(size);
      this.cells.push(cell);
      this.chars.push('');
      this.object.add(cell.object);
    }
  }

  /** The current text's width (m). */
  get width(): number {
    return this.widthNow;
  }

  get ready(): boolean {
    for (const cell of this.cells) if (!cell.ready) return false;
    return true;
  }

  /** Shows `text`, touching only the cells whose character changed. */
  set(text: string): void {
    if (text === this.current) return;
    this.current = text;
    let x = 0;
    for (let i = 0; i < this.cells.length; i++) {
      const cell = this.cells[i] as TextHandle;
      const char = i < text.length ? text.charAt(i) : '';
      const width = char ? cellWidth(char, this.role, this.size) : 0;
      cell.object.position.x = x + width / 2;
      if (char !== this.chars[i]) {
        this.chars[i] = char;
        cell.set(char);
      }
      x += width;
    }
    this.widthNow = x;
  }

  setColor(hex: number): void {
    for (const cell of this.cells) cell.setColor(hex);
  }

  setOpacity(opacity: number): void {
    for (const cell of this.cells) cell.setOpacity(opacity);
  }

  /** Every cell's render order. */
  setRenderOrder(order: number): void {
    for (const cell of this.cells) cell.object.renderOrder = order;
  }

  dispose(): void {
    for (const cell of this.cells) cell.dispose();
  }
}

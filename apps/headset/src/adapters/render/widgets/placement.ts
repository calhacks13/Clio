import type { WidgetKind } from '../../../domain/widgets/types';
import { PANEL_DISTANCE } from '../panel-placement';
import { PANEL_TOP } from '../presenters/instruction-panel';
import { WIDGET_THEME } from './theme';

// Where the dock sits: a column of widget cards beside the step card, on the eye-centred cylinder
// the card is placed on (PANEL_DISTANCE), tangent to it and facing the eye, its top level with the
// card's top edge. The card is sized to its content (0.20 to 0.38 m wide), centred on its group's
// x = 0 with its top edge PANEL_TOP above the origin, and anchored in the room (panel-motion.ts);
// the dock copies the card group's pose each frame (dock.ts), and these functions set the column's
// offset from the card's actual width. Above the card would sit in the forward view at eye level
// and below it would cover the work; a side column covers neither. It starts on the right, near
// the right hand, takes the clear side the head faces when it first shows or the card goes
// somewhere new, and moves to the mirrored place when an object is behind it (dock.ts).

/** 1: right of the card. -1: left. */
export type DockSide = 1 | -1;

export const DOCK = {
  /** The side the column starts on. */
  side: 1 as DockSide,
  /** Angular gap to the card's edge; clears the card's Done button. */
  gutterDeg: 2,
  /** Column height below the card's top edge before cards collapse to pills. */
  budget: 0.3,
  /** Between stacked widgets. */
  gap: WIDGET_THEME.size.gap,
} as const;

const deg = (rad: number): number => (rad * 180) / Math.PI;
const rad = (degrees: number): number => (degrees * Math.PI) / 180;

/** The column's half-angle at PANEL_DISTANCE: atan(0.09 / 0.65), 7.88 deg. */
const DOCK_HALF = Math.atan(WIDGET_THEME.size.dockWidth / 2 / PANEL_DISTANCE);

/** Half the angle a card `width` wide subtends at PANEL_DISTANCE (rad). */
export const cardHalfAngle = (width: number): number => Math.atan(width / 2 / PANEL_DISTANCE);

/**
 * How far the column's centre turns off the card's centre line (rad): the card's half-angle, the
 * gutter and the column's half-angle. 18.63 deg beside the narrowest card (0.20 m), 26.18 beside
 * the widest (0.38 m).
 */
export function dockYaw(cardWidth: number): number {
  return cardHalfAngle(cardWidth) + rad(DOCK.gutterDeg) + DOCK_HALF;
}

/** The least yaw that keeps the column off a card `cardWidth` wide: inner edge on the card's. */
export function dockYawFloor(cardWidth: number): number {
  return cardHalfAngle(cardWidth) + DOCK_HALF;
}

/** Top to bottom in the column; ties by createdT (timer before timer-2). */
export const DOCK_ORDER: readonly WidgetKind[] = [
  'caution',
  'timer',
  'value',
  'progress',
  'checklist',
  'choices',
];

export interface DockOffset {
  /** The column's origin (its top centre) in the card group's frame. */
  position: [number, number, number];
  /** Its turn about +y (rad). */
  yaw: number;
}

/**
 * The column's origin (its top centre) in the card group's frame (x right, y up, +z toward the
 * eye, the card's top edge at PANEL_TOP) and its yaw, turned `yaw` (dockYaw) off the card's
 * centre line about an eye PANEL_DISTANCE in front of the card: tangent to that eye's cylinder.
 * Writes into `out` (the dock passes its own, so a frame allocates nothing).
 */
export function dockOffset(
  side: DockSide,
  yaw: number,
  out: DockOffset = { position: [0, 0, 0], yaw: 0 },
): DockOffset {
  out.position[0] = side * PANEL_DISTANCE * Math.sin(yaw);
  out.position[1] = PANEL_TOP;
  out.position[2] = PANEL_DISTANCE * (1 - Math.cos(yaw));
  out.yaw = -side * yaw;
  return out;
}

export interface AngularSpan {
  /** Yaw of the left and right edges (deg, + to the learner's right), from that eye. */
  left: number;
  right: number;
}

/** Where a card `cardWidth` wide and the column beside it at `yaw` sit, seen from that eye. */
export function angularBounds(
  side: DockSide,
  cardWidth: number,
  yaw: number = dockYaw(cardWidth),
): { card: AngularSpan; dock: AngularSpan } {
  const half = deg(cardHalfAngle(cardWidth));
  const inner = side * deg(yaw - DOCK_HALF);
  const outer = side * deg(yaw + DOCK_HALF);
  return {
    card: { left: -half, right: half },
    dock: { left: Math.min(inner, outer), right: Math.max(inner, outer) },
  };
}

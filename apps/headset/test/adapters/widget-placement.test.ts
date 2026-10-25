import { describe, expect, it } from 'vitest';
import { PANEL_DISTANCE } from '../../src/adapters/render/panel-placement';
import { PANEL_TOP } from '../../src/adapters/render/presenters/instruction-panel';
import {
  angularBounds,
  DOCK,
  DOCK_ORDER,
  dockOffset,
  dockYaw,
  dockYawFloor,
} from '../../src/adapters/render/widgets/placement';
import { WIDGET_THEME } from '../../src/adapters/render/widgets/theme';

// Where the dock sits beside the content-sized step card. The dock copies the card group's pose
// each frame (widget-dock.test.ts); these check the offset and the clearance computed from the
// card's actual width, across every width the card can take (0.20 to 0.38 m with its Done button,
// down to 0.16 m for a phase message without it).

const WIDTHS = [0.16, 0.2, 0.25, 0.3, 0.35, 0.38];
const deg = (rad: number): number => (rad * 180) / Math.PI;

describe('dock placement', () => {
  it('turns the column out by the card half-angle, a 2 degree gutter and its half-angle', () => {
    expect(deg(dockYaw(0.16))).toBeCloseTo(16.9, 2);
    expect(deg(dockYaw(0.2))).toBeCloseTo(18.63, 2);
    expect(deg(dockYaw(0.3))).toBeCloseTo(22.88, 2);
    expect(deg(dockYaw(0.38))).toBeCloseTo(26.18, 2);
  });

  it('keeps the column 2 degrees clear of the card on either side, at every card width', () => {
    for (const side of [1, -1] as const) {
      for (const width of WIDTHS) {
        const { card, dock } = angularBounds(side, width);
        const gap = side === 1 ? dock.left - card.right : card.left - dock.right;
        expect(gap).toBeCloseTo(DOCK.gutterDeg, 9);
      }
    }
  });

  it('puts the inner edge on the card edge at the floor, and mirrors the left side', () => {
    for (const width of WIDTHS) {
      const floor = angularBounds(1, width, dockYawFloor(width));
      expect(floor.dock.left).toBeCloseTo(floor.card.right, 9);
      const right = angularBounds(1, width);
      const left = angularBounds(-1, width);
      expect(left.dock.left).toBeCloseTo(-right.dock.right, 9);
      expect(left.dock.right).toBeCloseTo(-right.dock.left, 9);
    }
    const widest = angularBounds(1, 0.38);
    expect(widest.card.right).toBeCloseTo(16.29, 2);
    expect(widest.dock.right).toBeCloseTo(34.06, 2);
  });

  it("starts level with the card's top, tangent to the eye's cylinder and facing the eye", () => {
    for (const side of [1, -1] as const) {
      for (const width of WIDTHS) {
        const { position, yaw } = dockOffset(side, dockYaw(width));
        expect(position[1]).toBe(PANEL_TOP);
        // The eye in the card group's frame: PANEL_DISTANCE in front of the card's centre line.
        const dx = position[0];
        const dz = position[2] - PANEL_DISTANCE;
        expect(Math.hypot(dx, dz)).toBeCloseTo(PANEL_DISTANCE, 9);
        // The column's +z (sin yaw, cos yaw) points back along the line to the eye.
        expect(Math.sin(yaw)).toBeCloseTo(-dx / PANEL_DISTANCE, 9);
        expect(Math.cos(yaw)).toBeCloseTo(-dz / PANEL_DISTANCE, 9);
        expect(Math.sign(position[0])).toBe(side);
      }
    }
  });

  it('writes into the offset it is given', () => {
    const out = { position: [0, 0, 0] as [number, number, number], yaw: 0 };
    expect(dockOffset(-1, dockYaw(0.3), out)).toBe(out);
    expect(out.position[0]).toBeLessThan(0);
  });

  it('uses the theme width and stacks by a fixed kind order', () => {
    expect(WIDGET_THEME.size.dockWidth).toBe(0.18);
    expect(DOCK_ORDER).toEqual(['caution', 'timer', 'value', 'progress', 'checklist', 'choices']);
  });
});

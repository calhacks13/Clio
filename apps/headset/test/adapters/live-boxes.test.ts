/// <reference path="../../src/adapters/render/troika.d.ts" />
import type { BufferGeometry, Mesh, MeshBasicMaterial, ShaderMaterial } from 'three';
import { Object3D } from 'three';
import { describe, expect, it, vi } from 'vitest';

// troika's SDF text needs a browser; a plain object stands in for each label.
vi.mock('../../src/adapters/render/text', () => ({
  makeText: () =>
    Object.assign(new Object3D(), {
      text: '',
      fillOpacity: 1,
      outlineOpacity: 1,
      textRenderInfo: null,
      sync() {},
      dispose() {},
    }),
  setText: (t: { text: string }, value: string) => {
    t.text = value;
  },
}));

import {
  BoxView,
  boxLines,
  boxStroke,
  cornerAccents,
  dashes,
  frontPoints,
} from '../../src/adapters/render/box-view';
import { XrDepthOcclusion } from '../../src/adapters/render/glow/depth-occlusion';
import type { PresentContext } from '../../src/adapters/render/presenter';
import { type LiveBox, LiveBoxesPresenter } from '../../src/adapters/render/presenters/live-boxes';
import { ACCENTS } from '../../src/domain/overlay/accents';
import type { Point2 } from '../../src/domain/world/outline';

// A 10 x 6 cm box on the plane (x right, y up), in the image's corner order: top left first.
const CORNERS: Point2[] = [
  [-0.05, 0.03],
  [0.05, 0.03],
  [0.05, -0.03],
  [-0.05, -0.03],
];

/** The x and y extents of a stroke's vertices. */
function extents(positions: Float32Array): [number, number, number, number] {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i] as number;
    const y = positions[i + 1] as number;
    [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
  }
  return [x0, y0, x1, y1];
}

describe('box lines', () => {
  it('keeps their widths as angles: twice as far, twice as wide', () => {
    const near = boxLines(0.5);
    const far = boxLines(1);
    expect(far.line).toBeCloseTo(2 * near.line, 9);
    expect(far.accent).toBeCloseTo(2 * near.accent, 9);
    // Thin at arm's length, the corners bolder.
    expect(boxLines(0.6).line).toBeLessThan(0.0015);
    expect(boxLines(0.6).accent).toBeGreaterThan(2 * boxLines(0.6).line);
  });

  it('draws the rectangle just outside the box, with an L over each corner flush with it', () => {
    const lines = boxLines(0.6);
    const stroke = boxStroke(CORNERS, lines, false);
    const [x0, y0, x1, y1] = extents(stroke.positions);
    // Nothing inside the box's edge is covered beyond the line itself...
    expect([x0, y0, x1, y1].map((v) => Number(v.toFixed(6)))).toEqual(
      [-0.05 - lines.accent, -0.03 - lines.accent, 0.05 + lines.accent, 0.03 + lines.accent].map(
        (v) => Number(v.toFixed(6)),
      ),
    );
    // ...and the corners stay corners: each L lies within its quarter of the box.
    const accents = cornerAccents(CORNERS, 0.25, lines.accentLength, lines.accent / 2);
    expect(accents).toHaveLength(4);
    const [first] = accents;
    expect(first?.[1]?.[0]).toBeCloseTo(-0.05 - lines.accent / 2, 9);
    expect(first?.[1]?.[1]).toBeCloseTo(0.03 + lines.accent / 2, 9);
    for (const [a, , b] of accents) {
      expect(Math.hypot((a?.[0] ?? 0) - (b?.[0] ?? 0), (a?.[1] ?? 0) - (b?.[1] ?? 0))).toBeLessThan(
        0.06,
      );
    }
    expect(stroke.indices.length % 3).toBe(0);
    expect(Math.max(...stroke.indices)).toBeLessThan(stroke.positions.length / 3);
  });

  it('caps the corners on a large box, and gives a dashed box dashes along every side', () => {
    const big: Point2[] = CORNERS.map(([x, y]): Point2 => [x * 10, y * 10]);
    const lines = boxLines(0.6);
    for (const [a, corner] of cornerAccents(big, 0.25, lines.accentLength, 0)) {
      const along = Math.hypot(
        (a?.[0] ?? 0) - (corner?.[0] ?? 0),
        (a?.[1] ?? 0) - (corner?.[1] ?? 0),
      );
      expect(along).toBeCloseTo(lines.accentLength, 9);
    }
    const cuts = dashes(CORNERS, 0.01, 0.005, 0);
    // 10 cm sides take 7 dashes, 6 cm sides 4: centered, inside each side.
    expect(cuts).toHaveLength(2 * 7 + 2 * 4);
    for (const [a, b] of cuts) {
      expect(Math.hypot((b?.[0] ?? 0) - (a?.[0] ?? 0), (b?.[1] ?? 0) - (a?.[1] ?? 0))).toBeCloseTo(
        0.01,
        9,
      );
      expect(Math.abs(a?.[0] ?? 1)).toBeLessThanOrEqual(0.05 + 1e-9);
    }
    const dashed = boxStroke(CORNERS, lines, true);
    expect(dashed.positions.length).toBeGreaterThan(0);
  });

  it('reads the object front at points over the middle of the box', () => {
    const out = new Float32Array(32);
    expect(frontPoints(CORNERS, out)).toBe(16);
    for (let k = 0; k < 16; k++) {
      expect(Math.abs(out[k * 2] as number)).toBeLessThan(0.05 * 0.7 + 1e-6);
      expect(Math.abs(out[k * 2 + 1] as number)).toBeLessThan(0.03 * 0.7 + 1e-6);
    }
    expect(frontPoints(CORNERS.slice(0, 3), out)).toBe(0);
  });
});

const box = (key: string, extra: Partial<LiveBox> = {}): LiveBox => ({
  key,
  center: [0, 1, -0.6],
  corners: CORNERS,
  shapeVersion: 1,
  label: key,
  detail: null,
  accent: { color: ACCENTS.act, opacity: 1 },
  dashed: false,
  ...extra,
});

const context = (t: number, dt = 16, head: [number, number, number] = [0, 1.2, 0]) =>
  ({ t, dt, head: { p: head, q: [0, 0, 0, 1] } }) as unknown as PresentContext;

function setup(occlusion: XrDepthOcclusion | null = null) {
  let boxes: LiveBox[] = [];
  const presenter = new LiveBoxesPresenter(() => boxes, { occlusion });
  const show = (next: LiveBox[]) => {
    boxes = next;
  };
  return { presenter, show };
}

/** The parts of a drawn box: its lines and its tag (fill, name, detail line). */
function parts(presenter: LiveBoxesPresenter, index = 0) {
  const group = presenter.object.children[index];
  const [lines, tag] = group?.children ?? [];
  const [fill, name, detail] = tag?.children ?? [];
  return {
    group,
    lines: lines as Mesh<BufferGeometry, ShaderMaterial>,
    tag,
    fill: fill as Mesh<BufferGeometry, MeshBasicMaterial>,
    name: name as Object3D & { text: string },
    detail: detail as Object3D & { text: string },
  };
}

describe('LiveBoxesPresenter', () => {
  it('draws a box per entry in its accent, named on a tag at the top left corner', () => {
    const { presenter, show } = setup();
    show([
      box('cap'),
      box('jug', { center: [0.3, 1, -0.6], accent: { color: ACCENTS.destination, opacity: 1 } }),
    ]);
    presenter.update(context(0, 1000));
    expect(presenter.object.children).toHaveLength(2);
    expect(presenter.object.children.map((c) => c.position.x)).toEqual([0, 0.3]);
    const cap = parts(presenter, 0);
    const jug = parts(presenter, 1);
    expect(cap.group?.visible).toBe(true);
    expect(cap.lines.material.uniforms.color?.value.getHex()).toBe(ACCENTS.act);
    expect(jug.fill.material.color.getHex()).toBe(ACCENTS.destination);
    expect(cap.name.text).toBe('cap');
    expect(cap.detail.visible).toBe(false);
    // Above and left of the top left corner, flush with its L.
    const { accent } = boxLines(Math.hypot(0.2, 0.6));
    expect(cap.tag?.position.x).toBeCloseTo(-0.05 - accent, 6);
    expect(cap.tag?.position.y).toBeCloseTo(0.03 + accent, 6);
    // The tag is drawn over everything; the lines keep the room's depth order.
    expect(cap.fill.material.depthTest).toBe(false);
    expect(cap.lines.material.depthTest).toBe(true);
  });

  it('adds a debug line under the name', () => {
    const { presenter, show } = setup();
    show([box('cap', { detail: 'tracking · er · 0.91' })]);
    presenter.update(context(0));
    const { detail, name, fill } = parts(presenter);
    expect(detail.visible).toBe(true);
    expect(detail.text).toBe('tracking · er · 0.91');
    // Two lines: the name sits above the debug line, the fill covers both.
    expect(name.position.y).toBeGreaterThan(detail.position.y);
    expect(fill.scale.y).toBeGreaterThan(0.018 + 0.012);
  });

  it('reshapes a box only for a new shape, or when the eye has moved much nearer or farther', () => {
    const show = vi.spyOn(BoxView.prototype, 'show');
    const { presenter, show: list } = setup();
    list([box('cap')]);
    presenter.update(context(0));
    list([box('cap', { center: [0.01, 1, -0.6] })]);
    presenter.update(context(16));
    expect(show).toHaveBeenCalledTimes(1);
    expect(presenter.object.children[0]?.position.x).toBe(0.01);
    list([box('cap', { shapeVersion: 2 })]);
    presenter.update(context(32));
    expect(show).toHaveBeenCalledTimes(2);
    // Leaning in from 63 cm to 30 cm: the lines are rebuilt thinner, the shape is the same.
    presenter.update(context(48, 16, [0, 1.1, -0.3]));
    expect(show).toHaveBeenCalledTimes(3);
    show.mockRestore();
  });

  it('draws a dashed box for another finder, and turns it solid again', () => {
    const { presenter, show } = setup();
    show([box('er:cap', { dashed: true })]);
    presenter.update(context(0));
    const dashed = parts(presenter).lines.geometry.getAttribute('position').count;
    show([box('er:cap')]);
    presenter.update(context(16));
    const solid = parts(presenter).lines.geometry.getAttribute('position').count;
    expect(dashed).not.toBe(solid);
  });

  it('fades out a box no longer listed, then lets it go', () => {
    const { presenter, show } = setup();
    show([box('cap')]);
    presenter.update(context(0, 1000));
    expect(presenter.object.children[0]?.visible).toBe(true);
    show([]);
    presenter.update(context(1000, 300));
    expect(presenter.object.children).toHaveLength(1);
    presenter.update(context(2000, 1000));
    expect(presenter.object.children).toHaveLength(0);
  });

  it("binds the glow's depth occlusion before its lines draw, and draws them without it on a throw", () => {
    const occlusion = new XrDepthOcclusion();
    const bind = vi.spyOn(occlusion, 'bind').mockImplementation(() => {
      throw new Error('no depth');
    });
    const { presenter, show } = setup(occlusion);
    show([box('cap')]);
    presenter.update(context(0, 1000));
    const { lines } = parts(presenter);
    const uniforms = lines.material.uniforms;
    uniforms.depthOn = { value: 1 };
    lines.onBeforeRender(
      ...([{}, {}, {}, lines.geometry, lines.material, null] as unknown as Parameters<
        typeof lines.onBeforeRender
      >),
    );
    expect(bind).toHaveBeenCalledTimes(1);
    expect(uniforms.depthOn?.value).toBe(0);
    // The front is read inside the box, up to the object's size.
    expect(uniforms.interiorCount?.value).toBe(16);
    expect(uniforms.maxFront?.value).toBeCloseTo(0.075, 9);
  });
});

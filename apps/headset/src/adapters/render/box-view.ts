import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  ShaderMaterial,
  type Vector3,
} from 'three';
import type { Text } from 'troika-three-text';
import type { Vec3 } from '../../core/math';
import type { Accent } from '../../domain/overlay/accents';
import type { Point2 } from '../../domain/world/outline';
import { frameGuard } from './frame-guard';
import {
  DepthVariant,
  depthChunk,
  depthUniforms,
  INTERIOR_POINTS,
  type XrDepthOcclusion,
} from './glow/depth-occlusion';
import { occlusionChunk } from './glow/shader';
import { drawOnTop } from './on-top';
import { mergeStrokes, type Stroke, strokePolyline } from './stroke';
import { makeText, setText } from './text';

// A tracked object's bounding box in the room (presenters/live-boxes.ts): the tracker's box on
// the plane through the object that faces the camera, where its outline is (domain/world,
// placement.ts), drawn as a thin rectangle just outside the box with an L over each corner, in
// the object's accent. A tag at the top left corner names the object (and, for ?debug=1, says
// what the tracker last said of it). Robotics-ER's boxes (?debug=1) are dashed, without corners.
//
// Like the glow (outline-view.ts), the group turns toward the eye every frame (lookAt: +z at the
// eye, x level, the plane's own basis), each new box reshapes it in place and only its center
// moves in between, it fades in fast and out slowly, and nothing is allocated per frame. Its
// lines keep the room's depth order as the glow does: they depth-test against the hands'
// occluders, and a real surface nearer than the object's front hides them through the same
// depth-map test (glow/shader.ts, occlusionChunk), the front read from the map at a grid of
// points inside the box. The tag is drawn over everything, like the glow's name (on-top.ts).
// Line widths are angles seen from the eye, so a box reads the same at arm's length and across
// the table.

/** The rectangle's line, as an angle from the eye (rad): about 1.2 mm at arm's length. */
const LINE_RAD = 0.002;
/** The corner accents' width (rad): about 3 mm at arm's length... */
const ACCENT_RAD = 0.005;
/** ...along this share of each side, at most this long (rad): about 2.4 cm at arm's length. */
const ACCENT_SHARE = 0.25;
const ACCENT_MAX_RAD = 0.04;
/** A dashed box's dashes and gaps (rad). */
const DASH_RAD = 0.016;
const GAP_RAD = 0.01;
/** The tag: its name's height and a debug line's (m), and the padding around them (m). */
const TAG_SIZE = 0.018;
const DETAIL_SIZE = 0.012;
const TAG_PAD = 0.004;
const TAG_GAP = 0.002;
/** Dark text on the accent, as the debug panels draw it. */
const TAG_TEXT = 0x04121a;
/** Text width per character, as a share of its height, until troika has laid it out. */
const CHAR_WIDTH = 0.56;
const FADE_IN_MS = 180;
const FADE_OUT_MS = 600;
/** The object's front is never taken as more than this share of its size, nor this far (m). */
const MAX_FRONT_SHARE = 0.75;
const MAX_FRONT_M = 0.4;
/** The front is read at a grid of points over this middle share of the box. */
const FRONT_SPAN = 0.7;
const FRONT_GRID = Math.floor(Math.sqrt(INTERIOR_POINTS));

/** troika fades the text's outline separately from its fill (missing from troika.d.ts). */
type FadingText = Text & { outlineOpacity: number };

/** The widths a box is drawn with (m), for its distance from the eye. */
export interface BoxLines {
  line: number;
  accent: number;
  accentLength: number;
  dash: number;
  gap: number;
}

/** Line widths for a box `distance` m from the eye. */
export function boxLines(distance: number): BoxLines {
  const d = Math.max(distance, 0.1);
  return {
    line: LINE_RAD * d,
    accent: ACCENT_RAD * d,
    accentLength: ACCENT_MAX_RAD * d,
    dash: DASH_RAD * d,
    gap: GAP_RAD * d,
  };
}

const sub2 = (a: Point2, b: Point2): Point2 => [a[0] - b[0], a[1] - b[1]];
const len2 = ([x, y]: Point2) => Math.hypot(x, y);

function centroid(points: readonly Point2[]): Point2 {
  let x = 0;
  let y = 0;
  for (const p of points) {
    x += p[0];
    y += p[1];
  }
  return [x / points.length, y / points.length];
}

/** The unit normal of a → b that points away from `middle`. */
function outward(a: Point2, b: Point2, middle: Point2): Point2 {
  const [dx, dy] = sub2(b, a);
  const l = Math.hypot(dx, dy) || 1;
  const n: Point2 = [-dy / l, dx / l];
  const toMiddle = sub2(middle, a);
  return n[0] * toMiddle[0] + n[1] * toMiddle[1] > 0 ? [-n[0], -n[1]] : n;
}

/**
 * An L over each corner, its inner edge on the box's sides: along `share` of each side from the
 * corner, at most `maxLength`, moved out by `offset` (half the accent's width).
 */
export function cornerAccents(
  corners: readonly Point2[],
  share: number,
  maxLength: number,
  offset: number,
): Point2[][] {
  const n = corners.length;
  const middle = centroid(corners);
  return corners.map((corner, i) => {
    const prev = corners[(i - 1 + n) % n] as Point2;
    const next = corners[(i + 1) % n] as Point2;
    const toPrev = sub2(prev, corner);
    const toNext = sub2(next, corner);
    const a = Math.min(share * len2(toPrev), maxLength) / (len2(toPrev) || 1);
    const b = Math.min(share * len2(toNext), maxLength) / (len2(toNext) || 1);
    const outPrev = outward(corner, prev, middle);
    const outNext = outward(corner, next, middle);
    const shift = (p: Point2, ...normals: Point2[]): Point2 =>
      normals.reduce<Point2>((q, m) => [q[0] + m[0] * offset, q[1] + m[1] * offset], p);
    return [
      shift([corner[0] + toPrev[0] * a, corner[1] + toPrev[1] * a], outPrev),
      shift(corner, outPrev, outNext),
      shift([corner[0] + toNext[0] * b, corner[1] + toNext[1] * b], outNext),
    ];
  });
}

/** Dashes along each side, moved out by `offset`: [from, to] pairs. */
export function dashes(
  corners: readonly Point2[],
  dash: number,
  gap: number,
  offset: number,
): Point2[][] {
  const n = corners.length;
  const middle = centroid(corners);
  const out: Point2[][] = [];
  for (let i = 0; i < n; i++) {
    const a = corners[i] as Point2;
    const b = corners[(i + 1) % n] as Point2;
    const side = sub2(b, a);
    const length = len2(side);
    if (!(length > 0) || !(dash > 0)) continue;
    const [nx, ny] = outward(a, b, middle);
    const at = (s: number): Point2 => [
      a[0] + (side[0] * s) / length + nx * offset,
      a[1] + (side[1] * s) / length + ny * offset,
    ];
    // Centered on the side, so both ends of a side look alike.
    const count = Math.max(1, Math.floor((length + gap) / (dash + gap)));
    const used = count * dash + (count - 1) * gap;
    let s = (length - Math.min(used, length)) / 2;
    for (let k = 0; k < count; k++) {
      out.push([at(s), at(Math.min(length, s + dash))]);
      s += dash + gap;
    }
  }
  return out;
}

/** A box's lines: a thin rectangle just outside its sides and an L over each corner, or dashes. */
export function boxStroke(corners: readonly Point2[], lines: BoxLines, dashed: boolean): Stroke {
  if (corners.length < 3) return mergeStrokes([]);
  if (dashed) {
    return mergeStrokes(
      dashes(corners, lines.dash, lines.gap, lines.line / 2).map((d) =>
        strokePolyline(d, { width: lines.line, closed: false }),
      ),
    );
  }
  const rect = strokePolyline(corners, { width: lines.line, closed: true, outside: true });
  const accents = cornerAccents(corners, ACCENT_SHARE, lines.accentLength, lines.accent / 2).map(
    (path) => strokePolyline(path, { width: lines.accent, closed: false, miterLimit: 2 }),
  );
  return mergeStrokes([rect, ...accents]);
}

/**
 * Points inside the box, for the object's front: a FRONT_GRID square grid over its middle
 * FRONT_SPAN, each placed between the four corners (top left, top right, bottom right, bottom
 * left), x and y interleaved. Returns how many were written.
 */
export function frontPoints(corners: readonly Point2[], out: Float32Array): number {
  if (corners.length !== 4) return 0;
  const [tl, tr, br, bl] = corners as [Point2, Point2, Point2, Point2];
  let k = 0;
  for (let j = 0; j < FRONT_GRID; j++) {
    const v = 0.5 + FRONT_SPAN * ((j + 0.5) / FRONT_GRID - 0.5);
    for (let i = 0; i < FRONT_GRID && k * 2 + 1 < out.length; i++) {
      const u = 0.5 + FRONT_SPAN * ((i + 0.5) / FRONT_GRID - 0.5);
      for (const axis of [0, 1] as const) {
        const top = tl[axis] + (tr[axis] - tl[axis]) * u;
        const bottom = bl[axis] + (br[axis] - bl[axis]) * u;
        out[k * 2 + axis] = top + (bottom - top) * v;
      }
      k++;
    }
  }
  return k;
}

const boxVertexShader = /* glsl */ `
  varying vec3 vWorld;
  #if GLOW_DEPTH > 0
    ${depthChunk}
    uniform vec2 interior[${INTERIOR_POINTS}];
    uniform int interiorCount;
    uniform float maxFront;
    // How far the object's own front is in front of the box's plane (m), for this eye and frame.
    flat varying float vFront;
  #endif
  void main() {
    vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
    #if GLOW_DEPTH > 0
      // As the glow finds it: the second-largest gap at the points inside the box (about the
      // 10th percentile of their real depth), never behind the plane, capped by its size.
      float first = 0.0;
      float second = 0.0;
      int valid = 0;
      for (int i = 0; i < ${INTERIOR_POINTS}; i++) {
        if (i >= interiorCount) break;
        float gap = depthGap((modelMatrix * vec4(interior[i], 0.0, 1.0)).xyz);
        if (gap <= NO_DEPTH) continue;
        valid++;
        float g = max(gap, 0.0);
        if (g > first) {
          second = first;
          first = g;
        } else if (g > second) {
          second = g;
        }
      }
      vFront = min(valid >= 2 ? second : first, maxFront);
    #endif
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const boxFragmentShader = /* glsl */ `
  uniform vec3 color;
  uniform float opacity;
  varying vec3 vWorld;
  #if GLOW_DEPTH > 0
    ${depthChunk}
    ${occlusionChunk}
    flat varying float vFront;
  #endif
  void main() {
    float hidden = 0.0;
    #if GLOW_DEPTH > 0
      hidden = occlusion(vWorld, vFront);
    #endif
    if (hidden >= 0.999) discard;
    gl_FragColor = vec4(color, opacity * (1.0 - hidden));
    #include <colorspace_fragment>
  }
`;

/** Where a box goes: the object's center and the corners about it on its plane. */
export interface BoxShape {
  /** World space. */
  center: Readonly<Vec3>;
  /**
   * About it on the plane (x right, y up as seen from the eye): the image's top left, top right,
   * bottom right and bottom left.
   */
  corners: readonly Point2[];
}

export class BoxView {
  readonly object = new Group();
  private readonly uniforms = {
    color: { value: new Color() },
    opacity: { value: 0 },
    ...depthUniforms(),
    interior: { value: new Float32Array(INTERIOR_POINTS * 2) },
    interiorCount: { value: 0 },
    maxFront: { value: 0 },
  };
  private readonly lines: Mesh<BufferGeometry, ShaderMaterial>;
  private readonly tag = new Group();
  private readonly tagFill: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private readonly name: FadingText;
  private readonly detail: FadingText;
  private hasDetail = false;
  /** The texts' layouts the tag was last sized for. */
  private sizedFor: [unknown, unknown] = [null, null];
  private placed = false;
  private opacity = 0;
  private target = 0;
  private accentOpacity = 1;

  constructor(private readonly occlusion: XrDepthOcclusion | null = null) {
    const material = new ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: boxVertexShader,
      fragmentShader: boxFragmentShader,
      defines: { GLOW_DEPTH: DepthVariant.None },
      transparent: true,
      depthTest: true,
      depthWrite: false,
      side: DoubleSide,
      forceSinglePass: true,
      toneMapped: false,
    });
    this.lines = new Mesh(new BufferGeometry(), material);
    // After the hands' occluders, with the glow's edge.
    this.lines.renderOrder = 10;
    this.lines.frustumCulled = false;
    // Once per eye per frame: this eye's depth map. Inside three's render a throw would end the
    // frame (frame-guard.ts), so it is caught here and the lines draw without the map.
    this.lines.onBeforeRender = (renderer, _scene, camera) => {
      const bound = frameGuard.run('box', () => {
        const variant = this.occlusion?.bind(renderer, camera, this.uniforms) ?? 0;
        if (variant !== DepthVariant.None && material.defines.GLOW_DEPTH !== variant) {
          material.defines.GLOW_DEPTH = variant;
          material.needsUpdate = true;
        }
      });
      if (!bound) {
        this.uniforms.depthOn.value = 0;
        this.uniforms.depthMap.value.sourceTexture = null;
      }
      material.uniformsNeedUpdate = true;
    };

    this.tagFill = new Mesh(
      new PlaneGeometry(1, 1),
      new MeshBasicMaterial({ color: 0xffffff, transparent: true, toneMapped: false }),
    );
    this.tagFill.renderOrder = 0;
    this.name = makeText({
      size: TAG_SIZE,
      color: TAG_TEXT,
      anchorY: 'bottom',
      bold: true,
    }) as FadingText;
    this.detail = makeText({ size: DETAIL_SIZE, color: TAG_TEXT, anchorY: 'bottom' }) as FadingText;
    for (const text of [this.name, this.detail]) {
      text.outlineWidth = 0;
      text.renderOrder = 1;
    }
    this.detail.visible = false;
    this.tag.add(this.tagFill, this.name, this.detail);
    drawOnTop(this.tag);
    this.object.add(this.lines, this.tag);
    this.object.visible = false;
  }

  /**
   * Draw the box at `shape`, `distance` m from the eye (its lines' widths follow it), dashed for
   * another finder's box.
   */
  show(shape: BoxShape, distance: number, dashed = false): void {
    const { corners } = shape;
    this.object.position.set(...shape.center);
    this.placed = true;
    const lines = boxLines(distance);
    this.lines.geometry = strokeGeometry(this.lines.geometry, boxStroke(corners, lines, dashed));
    const u = this.uniforms;
    u.interiorCount.value = frontPoints(corners, u.interior.value);
    let left = Number.POSITIVE_INFINITY;
    let right = Number.NEGATIVE_INFINITY;
    let bottom = Number.POSITIVE_INFINITY;
    let top = Number.NEGATIVE_INFINITY;
    for (const [x, y] of corners) {
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < bottom) bottom = y;
      if (y > top) top = y;
    }
    u.maxFront.value = Math.min(
      MAX_FRONT_M,
      MAX_FRONT_SHARE * Math.max(right - left, top - bottom),
    );
    // On the frame's outer edge at the top left corner, flush with the corner's L.
    const [x, y] = corners[0] ?? [left, top];
    const edge = dashed ? lines.line : lines.accent;
    this.tag.position.set(x - edge, y + edge, 0.001);
    this.target = 1;
  }

  /** Move the box without reshaping it (between the tracker's boxes). */
  moveTo(center: Readonly<Vec3>): void {
    this.object.position.set(...center);
  }

  /** The tag's text: the object's name, and a second, smaller line (null: none). */
  setLabel(name: string, detail: string | null): void {
    setText(this.name, name);
    this.hasDetail = detail !== null;
    this.detail.visible = this.hasDetail;
    if (detail !== null) setText(this.detail, detail);
  }

  setAccent({ color, opacity }: Accent): void {
    this.uniforms.color.value.setHex(color);
    this.tagFill.material.color.setHex(color);
    this.accentOpacity = opacity;
  }

  /** Nothing to box now: fade out. */
  fade(): void {
    this.target = 0;
  }

  /** Faded out completely (or never shown). */
  get dark(): boolean {
    return this.opacity === 0 && this.target === 0;
  }

  update(eye: Vector3, dt: number): void {
    const step = dt / (this.target > this.opacity ? FADE_IN_MS : FADE_OUT_MS);
    this.opacity =
      this.target > this.opacity
        ? Math.min(this.target, this.opacity + step)
        : Math.max(this.target, this.opacity - step);
    this.object.visible = this.placed && this.opacity > 0;
    if (!this.object.visible) return;
    this.object.lookAt(eye);
    const shown = this.opacity * (2 - this.opacity);
    this.uniforms.opacity.value = shown * this.accentOpacity;
    this.tagFill.material.opacity = shown * Math.max(0.75, this.accentOpacity);
    for (const text of [this.name, this.detail]) {
      text.fillOpacity = shown;
      text.outlineOpacity = shown;
    }
    this.layoutTag();
  }

  dispose(): void {
    this.lines.geometry.dispose();
    this.lines.material.dispose();
    this.tagFill.geometry.dispose();
    this.tagFill.material.dispose();
    this.name.dispose();
    this.detail.dispose();
  }

  /** Size the tag to its text, once troika has laid it out (estimated until then). */
  private layoutTag(): void {
    const nameInfo = this.name.textRenderInfo;
    const detailInfo = this.hasDetail ? this.detail.textRenderInfo : null;
    if (this.sizedFor[0] === nameInfo && this.sizedFor[1] === detailInfo && nameInfo) return;
    this.sizedFor = [nameInfo, detailInfo];
    const width = (text: Text, size: number, info: Text['textRenderInfo']) => {
      const bounds = info?.blockBounds;
      return bounds ? bounds[2] - bounds[0] : text.text.length * size * CHAR_WIDTH;
    };
    const nameW = width(this.name, TAG_SIZE, nameInfo);
    const detailW = this.hasDetail ? width(this.detail, DETAIL_SIZE, detailInfo) : 0;
    const detailH = this.hasDetail ? DETAIL_SIZE + TAG_GAP : 0;
    const w = Math.max(nameW, detailW) + 2 * TAG_PAD;
    const h = TAG_SIZE + detailH + 2 * TAG_PAD;
    this.tagFill.scale.set(w, h, 1);
    this.tagFill.position.set(w / 2, h / 2, 0);
    this.name.position.set(TAG_PAD, TAG_PAD + detailH, 0.0005);
    this.detail.position.set(TAG_PAD, TAG_PAD, 0.0005);
  }
}

/**
 * A stroke's geometry: `geometry` itself, refilled, when it has room for exactly as many vertices
 * and indices (a solid box always does), else a new one (the old one is disposed).
 */
function strokeGeometry(geometry: BufferGeometry, { positions, indices }: Stroke): BufferGeometry {
  const position = geometry.getAttribute('position') as BufferAttribute | undefined;
  const index = geometry.getIndex();
  if (position?.array.length === positions.length && index?.array.length === indices.length) {
    (position.array as Float32Array).set(positions);
    (index.array as Uint16Array).set(indices);
    position.needsUpdate = true;
    index.needsUpdate = true;
    return geometry;
  }
  geometry.dispose();
  const next = new BufferGeometry();
  next.setAttribute('position', new BufferAttribute(positions, 3));
  next.setIndex(new BufferAttribute(indices, 1));
  return next;
}

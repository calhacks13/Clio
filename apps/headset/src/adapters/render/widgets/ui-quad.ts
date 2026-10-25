import {
  Mesh,
  NormalBlending,
  PlaneGeometry,
  ShaderMaterial,
  Vector2,
  Vector3,
  Vector4,
} from 'three';
import { onTopMaterial } from '../on-top';
import { MM, mixHex, type ShadowLayer, WIDGET_THEME } from './theme';

// One widget shape per quad, drawn as a signed distance field: a rounded box with an inset stroke
// and up to two CSS-like shadow layers, a ring with an arc and its end-dot, a check that draws on,
// a segmented bar, or the caution's "!" disc. Every quad shares one PlaneGeometry and one compiled
// program; a frame only writes uniforms. Colours are sRGB token values, premultiplied, composited
// in sRGB as CSS does, with no colorspace conversion: the framebuffer holds sRGB-encoded values, so
// a token comes out as its exact hex. Edges are antialiased over one pixel at any distance, so a
// 1 mm hairline (about 2.2 px on Quest at 0.65 m) stays crisp. Like the step card, a quad draws
// on top (on-top.ts): no depth test, after everything else.

export type QuadMode = 'box' | 'ring' | 'check' | 'segments' | 'bang';

const MODE_INDEX: Readonly<Record<QuadMode, number>> = {
  box: 0,
  ring: 1,
  check: 2,
  segments: 3,
  bang: 4,
};

/** Room for the antialiased edge around every shape (m). */
const EDGE_MARGIN = 1.5 * MM;

/** Premultiplied sRGB, channels 0..1: each colour channel times alpha, then alpha. */
export function rgba(hex: number, alpha = 1): [number, number, number, number] {
  return [
    (((hex >> 16) & 0xff) / 255) * alpha,
    (((hex >> 8) & 0xff) / 255) * alpha,
    ((hex & 0xff) / 255) * alpha,
    alpha,
  ];
}

/** rgba() into an existing vector, allocating nothing. */
export function setRgba(out: Vector4, hex: number, alpha = 1): Vector4 {
  return out.set(
    (((hex >> 16) & 0xff) / 255) * alpha,
    (((hex >> 8) & 0xff) / 255) * alpha,
    ((hex & 0xff) / 255) * alpha,
    alpha,
  );
}

/** How far a shadow reaches past its shape (m): the most of |y| + blur + max(spread, 0). */
export function shadowMargin(layers: readonly ShadowLayer[]): number {
  let m = 0;
  for (const s of layers) m = Math.max(m, Math.abs(s.y) + s.blur + Math.max(s.spread, 0));
  return m * MM;
}

const VERTEX = /* glsl */ `
uniform vec2 uMeshHalf;
varying vec2 vP;
void main() {
  vP = position.xy * 2.0 * uMeshHalf;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAGMENT = /* glsl */ `
precision highp float;
uniform vec2 uHalf;
uniform float uRadius;
uniform vec4 uFill;
uniform vec4 uStroke;
uniform float uStrokeWidth;
uniform vec4 uShadow[2];
uniform vec3 uShadowColor;
uniform int uMode;
uniform vec4 uAccent;
uniform vec4 uParam;
uniform vec4 uParam2;
uniform float uOpacity;
varying vec2 vP;

const float TAU = 6.283185307179586;

float sdRoundBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

float sdSegment(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-12), 0.0, 1.0);
  return length(pa - ba * h);
}

// Coverage of the inside of d < 0, antialiased over one pixel of size px.
float cover(float d, float px) {
  return clamp(0.5 - d / px, 0.0, 1.0);
}

vec4 over(vec4 top, vec4 under) {
  return top + under * (1.0 - top.a);
}

// A rounded box's fill with an inset stroke on top.
vec4 strokedBox(float d, float px, vec4 fill, vec4 stroke, float width) {
  float c = cover(d, px);
  vec4 col = fill * c;
  if (stroke.a > 0.0 && width > 0.0) col = over(stroke * (c - cover(d + width, px)), col);
  return col;
}

// The check's distance: two strokes in Lucide's proportions, drawn on up to trim (0..1).
float sdCheck(vec2 p, float width, float trim) {
  vec2 a = vec2(-0.5, -0.03125) * width;
  vec2 b = vec2(-0.1875, -0.34375) * width;
  vec2 c = vec2(0.5, 0.34375) * width;
  float l1 = length(b - a);
  float l2 = length(c - b);
  float drawn = trim * (l1 + l2);
  float d = sdSegment(p, a, a + (b - a) * min(1.0, drawn / l1));
  if (drawn > l1) d = min(d, sdSegment(p, b, b + (c - b) * min(1.0, (drawn - l1) / l2)));
  return d;
}

void main() {
  vec2 p = vP;
  float px = 0.5 * (length(dFdx(vP)) + length(dFdy(vP)));
  vec4 col = vec4(0.0);

  if (uMode == 0) {
    float d = sdRoundBox(p, uHalf, uRadius);
    col = strokedBox(d, px, uFill, uStroke, uStrokeWidth);
    // Shadows sit under the box only, as CSS clips a box-shadow to outside its border box.
    float keep = 1.0;
    for (int i = 0; i < 2; i++) {
      vec4 s = uShadow[i];
      if (s.w <= 0.0) continue;
      vec2 hb = max(uHalf + s.z, vec2(0.0));
      float r = max(uRadius + s.z, 0.0);
      float ds = sdRoundBox(p - vec2(0.0, -s.x), hb, min(r, min(hb.x, hb.y)));
      float sigma = max(s.y, px);
      keep *= 1.0 - s.w * (1.0 - smoothstep(-2.0 * sigma, 2.0 * sigma, ds));
    }
    float a = (1.0 - keep) * (1.0 - cover(d, px));
    col = over(col, vec4(uShadowColor * a, a));
  } else if (uMode == 1) {
    // Ring: track in uFill; arc in uAccent clockwise from 12 o'clock over sweep, round caps;
    // the end-dot in uParam2 on a uStroke ring of width uStrokeWidth, at the arc's end.
    float R = uParam.x;
    float w = uParam.y;
    float sweep = uParam.z;
    float dotR = uParam.w;
    float dTrack = abs(length(p) - R) - 0.5 * w;
    col = uFill * cover(dTrack, px);
    float e = sweep * TAU;
    vec2 end = R * vec2(sin(e), cos(e));
    if (sweep > 0.0 && uAccent.a > 0.0) {
      float dArc = dTrack;
      if (sweep < 1.0) {
        float ang = fract(atan(p.x, p.y) / TAU);
        if (ang >= sweep) dArc = min(length(p - vec2(0.0, R)), length(p - end)) - 0.5 * w;
      }
      col = over(uAccent * cover(dArc, px), col);
    }
    if (dotR > 0.0 && (uParam2.a > 0.0 || uStroke.a > 0.0)) {
      float dd = length(p - end);
      col = over(uStroke * cover(dd - dotR - uStrokeWidth, px), col);
      col = over(uParam2 * cover(dd - dotR, px), col);
    }
  } else if (uMode == 2) {
    // Check circle: an inset ring (uStroke), a disc scaled by uParam.w (uFill) and a check in
    // uAccent, uParam = (trim, stroke width, check width, disc scale).
    float r = length(p);
    float dOuter = r - uRadius;
    if (uStroke.a > 0.0 && uStrokeWidth > 0.0) {
      col = uStroke * (cover(dOuter, px) - cover(dOuter + uStrokeWidth, px));
    }
    if (uFill.a > 0.0 && uParam.w > 0.0) col = over(uFill * cover(r - uRadius * uParam.w, px), col);
    if (uAccent.a > 0.0 && uParam.x > 0.0) {
      float dc = sdCheck(p, uParam.z, uParam.x) - 0.5 * uParam.y;
      col = over(uAccent * cover(dc, px), col);
    }
  } else if (uMode == 3) {
    // Bar: uParam = (segments, filled, gap, min fill). One segment is a continuous bar whose ink
    // fill is at least the min fill wide; more are pills with gaps, a fractional one growing from
    // its left. Empty parts: uFill with an inset uStroke.
    float n = max(1.0, floor(uParam.x + 0.5));
    float H = uHalf.y;
    if (n < 1.5) {
      float d = sdRoundBox(p, uHalf, H);
      col = strokedBox(d, px, uFill, uStroke, uStrokeWidth);
      float frac = clamp(uParam.y, 0.0, 1.0);
      if (frac > 0.0) {
        float fw = min(2.0 * uHalf.x, max(uParam.w, 2.0 * uHalf.x * frac));
        vec2 c = vec2(-uHalf.x + 0.5 * fw, 0.0);
        float df = sdRoundBox(p - c, vec2(0.5 * fw, H), min(H, 0.5 * fw));
        col = over(uAccent * cover(df, px), col);
      }
    } else {
      float gap = uParam.z;
      float sw = (2.0 * uHalf.x - gap * (n - 1.0)) / n;
      float x = p.x + uHalf.x;
      float i = clamp(floor((x + 0.5 * gap) / (sw + gap)), 0.0, n - 1.0);
      float left = -uHalf.x + i * (sw + gap);
      float d = sdRoundBox(p - vec2(left + 0.5 * sw, 0.0), vec2(0.5 * sw, H), H);
      col = strokedBox(d, px, uFill, uStroke, uStrokeWidth);
      float f = clamp(uParam.y - i, 0.0, 1.0);
      if (f > 0.0) {
        float fw = sw * f;
        float df = sdRoundBox(p - vec2(left + 0.5 * fw, 0.0), vec2(0.5 * fw, H), min(H, 0.5 * fw));
        col = over(uAccent * cover(df, px), col);
      }
    }
  } else {
    // Caution disc: uFill disc of radius uHalf.x with a "!" in uAccent: a 0.26R x 0.85R capsule
    // centred 0.16R above the centre, and a 0.26R dot 0.52R below it.
    float R = uHalf.x;
    col = uFill * cover(length(p) - R, px);
    float w = 0.26 * R;
    float top = 0.16 * R + 0.425 * R - 0.5 * w;
    float bottom = 0.16 * R - 0.425 * R + 0.5 * w;
    float bar = sdSegment(p, vec2(0.0, bottom), vec2(0.0, top)) - 0.5 * w;
    float pt = length(p - vec2(0.0, -0.52 * R)) - 0.5 * w;
    col = over(uAccent * cover(min(bar, pt), px), col);
  }

  gl_FragColor = col * uOpacity;
}
`;

/** The plane every quad scales: one geometry for every widget shape. */
const UNIT_PLANE = new PlaneGeometry(1, 1);

export interface UiQuadOptions {
  mode: QuadMode;
  /** The shape's size (m). */
  width: number;
  height: number;
  /** Corner radius (box), or the circle's radius (check). */
  radius?: number;
  /** CSS box-shadow layers (box only), at most two. */
  shadow?: readonly ShadowLayer[];
  renderOrder?: number;
}

/** The shader's uniforms (see FRAGMENT for what each mode reads). */
export interface QuadUniforms {
  uMeshHalf: { value: Vector2 };
  uHalf: { value: Vector2 };
  uRadius: { value: number };
  uFill: { value: Vector4 };
  uStroke: { value: Vector4 };
  uStrokeWidth: { value: number };
  uShadow: { value: [Vector4, Vector4] };
  uShadowColor: { value: Vector3 };
  uMode: { value: number };
  uAccent: { value: Vector4 };
  uParam: { value: Vector4 };
  uParam2: { value: Vector4 };
  uOpacity: { value: number };
}

/** One SDF shape on a shared plane. Setters write uniforms only. */
export class UiQuad {
  readonly mesh: Mesh<PlaneGeometry, ShaderMaterial>;
  readonly mode: QuadMode;
  readonly uniforms: QuadUniforms;
  private margin: number;
  private extent = 0;

  constructor(options: UiQuadOptions) {
    this.mode = options.mode;
    const shadowRgb = rgba(WIDGET_THEME.color.shadow);
    // Every colour starts transparent and every shadow off (a bare Vector4's w is 1).
    this.uniforms = {
      uMeshHalf: { value: new Vector2() },
      uHalf: { value: new Vector2() },
      uRadius: { value: options.radius ?? 0 },
      uFill: { value: new Vector4(0, 0, 0, 0) },
      uStroke: { value: new Vector4(0, 0, 0, 0) },
      uStrokeWidth: { value: 0 },
      uShadow: { value: [new Vector4(0, 0, 0, 0), new Vector4(0, 0, 0, 0)] },
      uShadowColor: { value: new Vector3(shadowRgb[0], shadowRgb[1], shadowRgb[2]) },
      uMode: { value: MODE_INDEX[options.mode] },
      uAccent: { value: new Vector4(0, 0, 0, 0) },
      uParam: { value: new Vector4(0, 0, 0, 0) },
      uParam2: { value: new Vector4(0, 0, 0, 0) },
      uOpacity: { value: 1 },
    };
    const shadow = options.shadow ?? [];
    for (let i = 0; i < 2; i++) {
      const s = shadow[i];
      if (s)
        this.uniforms.uShadow.value[i]?.set(s.y * MM, (s.blur / 2) * MM, s.spread * MM, s.alpha);
    }
    this.margin = shadowMargin(shadow) + EDGE_MARGIN;
    const material = onTopMaterial(
      new ShaderMaterial({
        uniforms: this.uniforms as unknown as ShaderMaterial['uniforms'],
        vertexShader: VERTEX,
        fragmentShader: FRAGMENT,
        premultipliedAlpha: true,
        blending: NormalBlending,
        toneMapped: false,
      }),
    );
    this.mesh = new Mesh(UNIT_PLANE, material);
    this.mesh.renderOrder = options.renderOrder ?? 0;
    this.resize(options.width, options.height, options.radius);
  }

  /**
   * The shape's size and radius, none below zero (a negative size never reaches the shader); the
   * mesh grows by the shadow and edge margins.
   */
  resize(width: number, height: number, radius: number = this.uniforms.uRadius.value): this {
    this.uniforms.uHalf.value.set(Math.max(0, width) / 2, Math.max(0, height) / 2);
    this.uniforms.uRadius.value = Math.max(0, radius);
    this.fitMesh();
    return this;
  }

  /** How far past the shape the mesh must reach for a ring's end-dot (ring mode). */
  setExtent(extent: number): this {
    this.extent = extent;
    this.fitMesh();
    return this;
  }

  fill(hex: number, alpha = 1): this {
    setRgba(this.uniforms.uFill.value, hex, alpha);
    return this;
  }

  /** a to b in sRGB (k 0..1), as a CSS colour transition mixes them. */
  fillMix(a: number, b: number, k: number, alpha = 1): this {
    return this.fill(mixHex(a, b, k), alpha);
  }

  stroke(hex: number, alpha: number, width: number): this {
    setRgba(this.uniforms.uStroke.value, hex, alpha);
    this.uniforms.uStrokeWidth.value = width;
    return this;
  }

  accent(hex: number, alpha = 1): this {
    setRgba(this.uniforms.uAccent.value, hex, alpha);
    return this;
  }

  param(x: number, y: number, z: number, w: number): this {
    this.uniforms.uParam.value.set(x, y, z, w);
    return this;
  }

  /** One parameter: 0 x, 1 y, 2 z, 3 w. */
  paramAt(i: 0 | 1 | 2 | 3, value: number): this {
    this.uniforms.uParam.value.setComponent(i, value);
    return this;
  }

  param2(hex: number, alpha = 1): this {
    setRgba(this.uniforms.uParam2.value, hex, alpha);
    return this;
  }

  opacity(opacity: number): this {
    this.uniforms.uOpacity.value = opacity;
    this.mesh.visible = opacity > 0.002;
    return this;
  }

  dispose(): void {
    this.mesh.material.dispose();
  }

  private fitMesh(): void {
    const half = this.uniforms.uHalf.value;
    const m = this.margin + this.extent;
    this.uniforms.uMeshHalf.value.set(half.x + m, half.y + m);
    this.mesh.scale.set(2 * (half.x + m), 2 * (half.y + m), 1);
  }
}

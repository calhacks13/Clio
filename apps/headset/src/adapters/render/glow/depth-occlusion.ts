import {
  BufferAttribute,
  BufferGeometry,
  type Camera,
  ExternalTexture,
  Matrix4,
  Mesh,
  ShaderMaterial,
  Vector4,
  type WebGLRenderer,
} from 'three';

// Real surfaces in front of the glow hide it, from the headset's own depth map (WebXR depth
// sensing, gpu-optimized: a texture per frame, one layer per eye on Quest). Each glow fragment is
// projected into the current eye's depth view and compared with the real surface the map sees
// there.
//
// The comparison is relative to the object, not to the glow's plane. The plane is at one measured
// distance (often where the object meets the table), and an object with depth (a laptop, a can)
// has its front well in front of it: compared with the plane, the object would hide its own
// glow. So the glow's vertex shader first reads the depth map at up to 16 points inside the
// silhouette (HighlightMask.interior) and takes the object's front: the second-nearest of them
// (about the 10th percentile, so one stray read does not count), as an offset in front of the
// plane, capped by the object's size. A fragment then fades only where the real surface is nearer
// than that front by more than the margin. A surface behind (a hand-held object's table) never
// cuts it. Hands are hidden by their own depth-only occluders as well (hand-occluders.ts).
//
// three.js's own occlusion (the depth map drawn into the depth buffer) stays off in the primary
// demo (disableXrDepthOcclusion): it hid the outline behind the object itself.
//
// Window depth decodes like depth-sensing.ts: with depthNear, d = near / (1 - v) when no finite
// far plane is reported (Quest Browser: depthNear 0.1, depthFar null) or when the policy is
// 'infinite' (IWER reports the render far plane but encodes 1 - near / d); otherwise the standard
// projection. Without depthNear the value is raw * rawValueToMeters. The buffer is addressed like
// depth-sensing.ts's GPU reads: GL's bottom-left origin, through normDepthBufferFromNormView;
// occlusionSettings.flipY addresses it top-first instead (a live switch for the headset).
//
// Debugging on the headset, from DevTools: window.__occlusion (installOcclusionDebug).

/** Fully visible until the real surface is this much nearer than the object's front (m)... */
export const OCCLUSION_MARGIN_M = 0.05;
/** ...and fully hidden this much further in (m). */
export const OCCLUSION_FALLOFF_M = 0.03;
/** Points inside the silhouette read for the object's front. */
export const INTERIOR_POINTS = 16;

export type WindowFar = 'reported' | 'infinite';
export type OcclusionViz = 'off' | 'depth' | 'diff';
/**
 * How the edge of what hides the glow is drawn from the coarse depth map: 'cubic' blends the
 * 4 x 4 nearest texels with cubic B-spline weights (fully smooth contours), 'smooth' the 3 x 3
 * with quadratic ones (round, faint texel ripples), 'bilinear' the 2 x 2 (texel corners show).
 */
export type OcclusionFilter = 'cubic' | 'smooth' | 'bilinear';
const FILTER_CODE: Record<OcclusionFilter, number> = { cubic: 0, smooth: 1, bilinear: 2 };

/** Live switches (window.__occlusion), read every frame. */
export const occlusionSettings = {
  depth: true,
  hands: true,
  flipY: false,
  margin: OCCLUSION_MARGIN_M,
  viz: 'off' as OcclusionViz,
  filter: 'cubic' as OcclusionFilter,
  /** Half the width of the cut through the blended tests (0..0.5): wider is softer. */
  softness: 0.15,
  /** The object's own surface as a tilted plane (true) or a single depth (false). */
  plane: true,
};

/** The shader variant: no depth map, a texture array (one layer per eye), or a plain texture. */
export const DepthVariant = { None: 0, Array: 1, Plain: 2 } as const;
export type DepthVariant = (typeof DepthVariant)[keyof typeof DepthVariant];

const VIZ_CODE: Record<OcclusionViz, number> = { off: 0, depth: 1, diff: 2 };

/**
 * How much of the glow a real surface hides (0 none, 1 all): `glowDepth` and `realDepth` are
 * planar depths (m) in the depth view, `front` how far the object's own front is in front of the
 * glow (m); the same smoothstep as the shader.
 */
export function glowOcclusion(
  glowDepth: number,
  realDepth: number | null,
  front = 0,
  margin = OCCLUSION_MARGIN_M,
  falloff = OCCLUSION_FALLOFF_M,
): number {
  if (realDepth === null || !(realDepth > 0)) return 0;
  const t = Math.min(1, Math.max(0, (glowDepth - realDepth - front - margin) / falloff));
  return t * t * (3 - 2 * t);
}

/**
 * The object's front, as the vertex shader finds it: from the gaps (glow depth minus real depth,
 * m; null where the map has nothing) at points inside the silhouette, the second-largest gap
 * (the largest when only one is known), never behind the plane, capped at `maxFront`.
 */
export function objectFront(gaps: readonly (number | null)[], maxFront: number): number {
  let first = 0;
  let second = 0;
  let valid = 0;
  for (const gap of gaps) {
    if (gap === null) continue;
    valid++;
    const g = Math.max(gap, 0);
    if (g > first) {
      second = first;
      first = g;
    } else if (g > second) second = g;
  }
  return Math.min(valid >= 2 ? second : first, maxFront);
}

/** NDC to the depth buffer's normalized coordinates, before normDepthBufferFromNormView. */
export function normView([x, y]: readonly [number, number], flipY: boolean): [number, number] {
  return [(x + 1) / 2, flipY ? (1 - y) / 2 : (y + 1) / 2];
}

/** Near, far (0: none) and raw scale for decoding a depth texture in the shader. */
export function depthPlanes(
  info: { depthNear?: number; depthFar?: number | null; rawValueToMeters: number },
  windowFar: WindowFar,
): { near: number; far: number; rawToMeters: number } {
  const near = typeof info.depthNear === 'number' && info.depthNear > 0 ? info.depthNear : 0;
  const reported = info.depthFar;
  const finite = typeof reported === 'number' && Number.isFinite(reported) && reported > near;
  return {
    near,
    far: near > 0 && finite && windowFar === 'reported' ? (reported as number) : 0,
    rawToMeters: info.rawValueToMeters || 1,
  };
}

/** Planar depth (m) from a raw texel, as the shaders decode it; null when unknown. */
export function decodeDepth(raw: number, near: number, far: number, rawToMeters: number) {
  if (near <= 0) return raw > 0 ? raw * rawToMeters : null;
  if (raw <= 0 || raw >= 1) return null;
  return far > 0
    ? (2 * near * far) / (far + near - (2 * raw - 1) * (far - near))
    : near / (1 - raw);
}

/**
 * GLSL shared by the glow's two stages and the debug overlay (needs GLOW_DEPTH > 0): the depth
 * map's uniforms, realDepthAt(texel), depthTexel(world) and depthGap(world) = the point's
 * planar depth in the depth view
 * minus the real surface's there (m), or NO_DEPTH where the map says nothing.
 */
export const depthChunk = /* glsl */ `
  #if GLOW_DEPTH == 1
    uniform highp sampler2DArray depthMap;
  #else
    uniform highp sampler2D depthMap;
  #endif
  uniform int depthLayer;
  uniform mat4 depthFromWorld;
  uniform mat4 depthUv;
  uniform float depthNear;
  uniform float depthFar;
  uniform float depthRawToMeters;
  uniform float depthOn;
  uniform float depthFlipY;
  const float NO_DEPTH = -1e9;

  ivec2 depthSize() {
    #if GLOW_DEPTH == 1
      return textureSize(depthMap, 0).xy;
    #else
      return textureSize(depthMap, 0);
    #endif
  }

  // The real surface's planar depth (m) at a texel of the depth map, or 0 when unknown.
  float realDepthAt(ivec2 p) {
    p = clamp(p, ivec2(0), depthSize() - 1);
    #if GLOW_DEPTH == 1
      float raw = texelFetch(depthMap, ivec3(p, depthLayer), 0).r;
    #else
      float raw = texelFetch(depthMap, p, 0).r;
    #endif
    if (depthNear <= 0.0) return raw * depthRawToMeters;
    if (raw <= 0.0 || raw >= 1.0) return 0.0;
    return depthFar > 0.0
      ? (2.0 * depthNear * depthFar) / (depthFar + depthNear - (2.0 * raw - 1.0) * (depthFar - depthNear))
      : depthNear / (1.0 - raw);
  }

  // Where a world point lands in the depth map, in texels (xy), and its planar depth there (z);
  // z <= 0 when it is outside the depth view.
  vec3 depthTexel(vec3 world) {
    if (depthOn < 0.5) return vec3(0.0);
    vec4 clip = depthFromWorld * vec4(world, 1.0);
    if (clip.w <= 0.0) return vec3(0.0);
    vec2 ndc = clip.xy / clip.w;
    if (any(greaterThan(abs(ndc), vec2(1.0)))) return vec3(0.0);
    vec2 view = vec2(ndc.x * 0.5 + 0.5, depthFlipY > 0.5 ? 0.5 - ndc.y * 0.5 : ndc.y * 0.5 + 0.5);
    vec4 buffer = depthUv * vec4(view, 0.0, 1.0);
    // clip.w is the point's planar depth in the depth view.
    return vec3(buffer.xy / buffer.w * vec2(depthSize()), clip.w);
  }

  float depthGap(vec3 world) {
    vec3 t = depthTexel(world);
    if (t.z <= 0.0) return NO_DEPTH;
    float real = realDepthAt(ivec2(t.xy));
    if (real <= 0.0) return NO_DEPTH;
    return t.z - real;
  }
`;

/** Depth-information fields this module reads (XRWebGLDepthInformation plus the Quest extras). */
interface GpuDepthInfo {
  texture: WebGLTexture | null;
  textureType?: 'texture' | 'texture-array';
  imageIndex?: number | null;
  isValid?: boolean;
  depthNear?: number;
  depthFar?: number | null;
  rawValueToMeters: number;
  width?: number;
  height?: number;
  transform?: XRRigidTransform | null;
  projectionMatrix?: Float32Array | null;
  normDepthBufferFromNormView?: XRRigidTransform | null;
}

export interface DepthUniforms {
  depthMap: { value: ExternalTexture };
  depthLayer: { value: number };
  depthFromWorld: { value: Matrix4 };
  depthUv: { value: Matrix4 };
  depthNear: { value: number };
  depthFar: { value: number };
  depthRawToMeters: { value: number };
  depthOn: { value: number };
  depthFlipY: { value: number };
  /** The test itself (window.__occlusion.setDepth); the map stays bound for the overlays. */
  occlusionOn: { value: number };
  occlusionMargin: { value: number };
  occlusionFalloff: { value: number };
  vizMode: { value: number };
  occlusionFilter: { value: number };
  occlusionSoftness: { value: number };
  occlusionPlane: { value: number };
}

export function depthUniforms(): DepthUniforms {
  return {
    depthMap: { value: new ExternalTexture() },
    depthLayer: { value: 0 },
    depthFromWorld: { value: new Matrix4() },
    depthUv: { value: new Matrix4() },
    depthNear: { value: 0 },
    depthFar: { value: 0 },
    depthRawToMeters: { value: 1 },
    depthOn: { value: 0 },
    depthFlipY: { value: 0 },
    occlusionOn: { value: 1 },
    occlusionMargin: { value: OCCLUSION_MARGIN_M },
    occlusionFalloff: { value: OCCLUSION_FALLOFF_M },
    vizMode: { value: 0 },
    occlusionFilter: { value: 0 },
    occlusionSoftness: { value: 0.15 },
    occlusionPlane: { value: 1 },
  };
}

/** What a probe measured for one eye (window.__occlusion.stats.eyes). */
export interface EyeStats {
  eye: string;
  layer: number;
  textureType: string;
  size: [number, number];
  near: number;
  far: number;
  ownView: boolean;
  /** Planar depth (m) of the glow's centre in this eye's depth view. */
  glowCenterM: number | null;
  /** The real surface (m) the map sees there. */
  realCenterM: number | null;
  /** How far the object's front is in front of the glow's plane (m), from the interior points. */
  frontM: number | null;
  /** The real depth (m) the occlusion test compares against there: glow centre - front. */
  referenceM: number | null;
  interiorKnown: number;
  t: number;
}

/** A glow's points to probe: its quad's world matrix and interior uv points. */
export interface ProbeTarget {
  matrixWorld: Matrix4;
  interior: Float32Array;
  interiorCount: number;
  maxFront: number;
}

const viewFromWorld = new Matrix4();
const MAX_FAILURES = 3;

/**
 * Hands each eye's depth map to a glow just before it draws (from its onBeforeRender): the
 * frame's depth information for the camera's view, read once per frame and eye. Returns
 * DepthVariant.None (and the glow draws unoccluded) outside an XR session, without gpu-optimized
 * depth, with occlusionSettings.depth off, or after repeated errors.
 */
export class XrDepthOcclusion {
  /**
   * renderer.info.render.frame of the cached views: Quest Browser hands out the same XRFrame
   * object every frame, so the frame object can't tell one frame from the next.
   */
  private renderFrame = -1;
  private views: readonly XRView[] = [];
  private readonly infos: (GpuDepthInfo | null | undefined)[] = [undefined, undefined];
  private configured: WebGLTexture | null = null;
  private failures = 0;
  private readonly prober = new DepthProber();
  /** Set by window.__occlusion.probe(): eyes still to measure. */
  probeEyes = 0;
  probeTarget: ProbeTarget | null = null;
  readonly stats: { eyes: (EyeStats | null)[]; poses: unknown[] } = {
    eyes: [null, null],
    poses: [null, null],
  };

  constructor(private readonly windowFar: WindowFar = 'reported') {}

  bind(renderer: WebGLRenderer, camera: Camera, u: DepthUniforms): DepthVariant {
    u.depthOn.value = 0;
    u.depthFlipY.value = occlusionSettings.flipY ? 1 : 0;
    u.occlusionMargin.value = occlusionSettings.margin;
    u.occlusionOn.value = occlusionSettings.depth ? 1 : 0;
    u.vizMode.value = VIZ_CODE[occlusionSettings.viz];
    u.occlusionFilter.value = FILTER_CODE[occlusionSettings.filter];
    u.occlusionSoftness.value = occlusionSettings.softness;
    u.occlusionPlane.value = occlusionSettings.plane ? 1 : 0;
    const { xr } = renderer;
    if (!xr.isPresenting || this.failures >= MAX_FAILURES) return DepthVariant.None;
    const session = xr.getSession();
    const frame = xr.getFrame();
    const space = xr.getReferenceSpace();
    if (!session || !frame || !space || session.depthUsage !== 'gpu-optimized') {
      return DepthVariant.None;
    }
    const cameras = xr.getCamera().cameras;
    let eye = -1;
    for (let i = 0; i < cameras.length; i++) if (cameras[i] === camera) eye = i;
    if (eye < 0) return DepthVariant.None;
    try {
      if (renderer.info.render.frame !== this.renderFrame) {
        this.renderFrame = renderer.info.render.frame;
        this.views = frame.getViewerPose(space)?.views ?? [];
        this.infos.fill(undefined);
      }
      const view = this.views[eye];
      if (!view) return DepthVariant.None;
      let info = this.infos[eye];
      if (info === undefined) {
        info = xr.getBinding().getDepthInformation(view) as GpuDepthInfo | null;
        this.infos[eye] = info;
      }
      if (!info || info.isValid === false || !info.texture) return DepthVariant.None;
      const array = info.textureType !== 'texture';
      this.configure(renderer, info.texture, array);
      u.depthMap.value.sourceTexture = info.texture;
      u.depthLayer.value = array
        ? typeof info.imageIndex === 'number'
          ? info.imageIndex
          : view.eye === 'right'
            ? 1
            : 0
        : 0;
      const projection = info.projectionMatrix ?? view.projectionMatrix;
      const transform = info.transform ?? view.transform;
      viewFromWorld.fromArray(transform.inverse.matrix);
      u.depthFromWorld.value.fromArray(projection).multiply(viewFromWorld);
      const uv = info.normDepthBufferFromNormView?.matrix;
      if (uv) u.depthUv.value.fromArray(uv);
      else u.depthUv.value.identity();
      const planes = depthPlanes(info, this.windowFar);
      u.depthNear.value = planes.near;
      u.depthFar.value = planes.far;
      u.depthRawToMeters.value = planes.rawToMeters;
      u.depthOn.value = 1;
      if (this.probeEyes & (1 << eye)) {
        this.probeEyes &= ~(1 << eye);
        this.stats.eyes[eye] = this.prober.measure(renderer, u, array, view.eye, info, this);
        const at = (t: XRRigidTransform | null | undefined) =>
          t ? [t.position.x, t.position.y, t.position.z].map((v) => +v.toFixed(3)) : null;
        const c = camera.matrixWorld.elements;
        const g = this.probeTarget?.matrixWorld.elements;
        this.stats.poses[eye] = {
          view: at(view.transform),
          depth: at(info.transform),
          camera: [c[12], c[13], c[14]].map((v) => +(v ?? 0).toFixed(3)),
          glow: g ? [g[12], g[13], g[14]].map((v) => +(v ?? 0).toFixed(3)) : null,
          projection: Array.from(projection).map((v) => +v.toFixed(3)),
          viewMatrix: Array.from(view.transform.matrix).map((v) => +v.toFixed(3)),
          cameraWorld: camera.matrixWorld.elements.map((v) => +v.toFixed(3)),
          cameraLocal: camera.matrix.elements.map((v) => +v.toFixed(3)),
          cameraParent: camera.parent?.type ?? null,
          cameraType: camera.type,
          glowWorld: this.probeTarget
            ? this.probeTarget.matrixWorld.elements.map((v) => +v.toFixed(3))
            : null,
        };
      }
      return array ? DepthVariant.Array : DepthVariant.Plain;
    } catch (err) {
      this.failures++;
      if (this.failures === MAX_FAILURES) {
        console.warn(`glow occlusion off: ${err instanceof Error ? err.message : String(err)}`);
      }
      return DepthVariant.None;
    }
  }

  /**
   * Read as plain values: no comparison, nearest texels (a depth-format texture with either is
   * incomplete for texelFetch). Once per texture, through three's state cache.
   */
  private configure(renderer: WebGLRenderer, texture: WebGLTexture, array: boolean): void {
    if (texture === this.configured) return;
    const gl = renderer.getContext() as WebGL2RenderingContext;
    const target = array ? gl.TEXTURE_2D_ARRAY : gl.TEXTURE_2D;
    renderer.state.bindTexture(target, texture);
    gl.texParameteri(target, gl.TEXTURE_COMPARE_MODE, gl.NONE);
    gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    this.configured = texture;
  }
}

// ---- debugging --------------------------------------------------------------------------------

const PROBE_POINTS = INTERIOR_POINTS + 1;
const point = new Vector4();

/**
 * On demand only (window.__occlusion.probe()): reads the depth map at the glow's centre and its
 * interior points with a tiny shader into a 17x1 target and reads it back synchronously, then
 * finds the object's front exactly as the vertex shader does. Raw GL, restoring every binding it
 * touches, since it runs inside three's render.
 */
class DepthProber {
  private programs = new Map<boolean, WebGLProgram>();
  private target: { fb: WebGLFramebuffer; tex: WebGLTexture } | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private readonly pixels = new Uint8Array(PROBE_POINTS * 4);
  private readonly uvs = new Float32Array(PROBE_POINTS * 2);

  measure(
    renderer: WebGLRenderer,
    u: DepthUniforms,
    array: boolean,
    eyeName: string,
    info: GpuDepthInfo,
    owner: XrDepthOcclusion,
  ): EyeStats {
    const target = owner.probeTarget;
    const glowDepths: (number | null)[] = [];
    const known: boolean[] = [];
    for (let i = 0; i < PROBE_POINTS; i++) {
      // Point 0: the glow's centre; then the interior points (uv in the quad).
      const inside = i > 0 && target !== null && i - 1 < target.interiorCount;
      const ux = inside ? (target?.interior[(i - 1) * 2] ?? 0.5) : 0.5;
      const uy = inside ? (target?.interior[(i - 1) * 2 + 1] ?? 0.5) : 0.5;
      point.set(ux - 0.5, uy - 0.5, 0, 1);
      if (target) point.applyMatrix4(target.matrixWorld);
      point.applyMatrix4(u.depthFromWorld.value);
      const ok = (i === 0 || inside) && target !== null && point.w > 0;
      const nx = point.x / point.w;
      const ny = point.y / point.w;
      const inView = ok && Math.abs(nx) <= 1 && Math.abs(ny) <= 1;
      const [vx, vy] = normView([nx, ny], occlusionSettings.flipY);
      const b = new Vector4(vx, vy, 0, 1).applyMatrix4(u.depthUv.value);
      this.uvs[i * 2] = b.x / b.w;
      this.uvs[i * 2 + 1] = b.y / b.w;
      glowDepths.push(inView ? point.w : null);
      known.push(inView);
    }
    const raw = this.read(renderer, u, array);
    const near = u.depthNear.value;
    const far = u.depthFar.value;
    const real = (i: number) => {
      if (!known[i] || !raw) return null;
      const r = raw[i];
      return r === undefined || r < 0 ? null : decodeDepth(r, near, far, u.depthRawToMeters.value);
    };
    const gaps: (number | null)[] = [];
    for (let i = 1; i < PROBE_POINTS; i++) {
      const g = glowDepths[i];
      const r = real(i);
      gaps.push(g != null && r !== null ? g - r : null);
    }
    const interiorKnown = gaps.filter((g) => g !== null).length;
    const front = target && interiorKnown > 0 ? objectFront(gaps, target.maxFront) : null;
    const glowCenter = glowDepths[0] ?? null;
    return {
      eye: eyeName,
      layer: u.depthLayer.value,
      textureType: info.textureType ?? 'texture',
      size: [info.width ?? 0, info.height ?? 0],
      near,
      far,
      ownView: Boolean(info.transform && info.projectionMatrix),
      glowCenterM: glowCenter,
      realCenterM: real(0),
      frontM: front,
      referenceM: glowCenter !== null && front !== null ? glowCenter - front : null,
      interiorKnown,
      t: performance.now(),
    };
  }

  /** Raw texel values at this.uvs (-1 where unknown), or null when the read failed. */
  private read(renderer: WebGLRenderer, u: DepthUniforms, array: boolean): Float32Array | null {
    const gl = renderer.getContext() as WebGL2RenderingContext;
    const texture = u.depthMap.value.sourceTexture as WebGLTexture | null;
    if (!texture) return null;
    const kind = array ? gl.TEXTURE_2D_ARRAY : gl.TEXTURE_2D;
    const saved = {
      draw: gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING),
      read: gl.getParameter(gl.READ_FRAMEBUFFER_BINDING),
      program: gl.getParameter(gl.CURRENT_PROGRAM),
      vao: gl.getParameter(gl.VERTEX_ARRAY_BINDING),
      active: gl.getParameter(gl.ACTIVE_TEXTURE),
      viewport: gl.getParameter(gl.VIEWPORT),
      colorMask: gl.getParameter(gl.COLOR_WRITEMASK),
      pack: gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING),
      caps: [gl.BLEND, gl.DEPTH_TEST, gl.CULL_FACE, gl.SCISSOR_TEST, gl.STENCIL_TEST].map(
        (cap) => [cap, gl.isEnabled(cap)] as const,
      ),
    };
    gl.activeTexture(gl.TEXTURE0);
    const bound = gl.getParameter(array ? gl.TEXTURE_BINDING_2D_ARRAY : gl.TEXTURE_BINDING_2D);
    try {
      const program = this.program(gl, array);
      this.target ??= this.createTarget(gl);
      this.vao ??= gl.createVertexArray();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.target.fb);
      gl.viewport(0, 0, PROBE_POINTS, 1);
      for (const [cap] of saved.caps) gl.disable(cap);
      gl.colorMask(true, true, true, true);
      gl.useProgram(program);
      gl.bindVertexArray(this.vao);
      gl.bindTexture(kind, texture);
      gl.uniform1i(gl.getUniformLocation(program, 'depthMap'), 0);
      gl.uniform1i(gl.getUniformLocation(program, 'layer'), u.depthLayer.value);
      gl.uniform2fv(gl.getUniformLocation(program, 'uvs'), this.uvs);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      gl.readPixels(0, 0, PROBE_POINTS, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.pixels);
      const raw = new Float32Array(PROBE_POINTS);
      for (let i = 0; i < PROBE_POINTS; i++) {
        const o = i * 4;
        const a = this.pixels[o + 3] ?? 0;
        // The raw value in [0, 1) to 24 bits (window depth; Quest's maps are).
        const v =
          ((this.pixels[o] ?? 0) * 65536 +
            (this.pixels[o + 1] ?? 0) * 256 +
            (this.pixels[o + 2] ?? 0)) /
          16777216;
        raw[i] = a > 0 ? v : -1;
      }
      return raw;
    } catch (err) {
      console.warn(`occlusion probe failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    } finally {
      gl.bindTexture(kind, bound);
      gl.activeTexture(saved.active);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, saved.draw);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, saved.read);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, saved.pack);
      gl.useProgram(saved.program);
      gl.bindVertexArray(saved.vao);
      gl.viewport(saved.viewport[0], saved.viewport[1], saved.viewport[2], saved.viewport[3]);
      const m = saved.colorMask as boolean[];
      gl.colorMask(Boolean(m[0]), Boolean(m[1]), Boolean(m[2]), Boolean(m[3]));
      for (const [cap, on] of saved.caps) {
        if (on) gl.enable(cap);
        else gl.disable(cap);
      }
    }
  }

  private createTarget(gl: WebGL2RenderingContext) {
    const tex = gl.createTexture();
    const fb = gl.createFramebuffer();
    if (!tex || !fb) throw new Error('no probe target');
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, PROBE_POINTS, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { fb, tex };
  }

  private program(gl: WebGL2RenderingContext, array: boolean): WebGLProgram {
    const cached = this.programs.get(array);
    if (cached) return cached;
    const vertex = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;
    const fragment = `#version 300 es
precision highp float;
precision highp int;
uniform highp ${array ? 'sampler2DArray' : 'sampler2D'} depthMap;
uniform int layer;
uniform vec2 uvs[${PROBE_POINTS}];
out vec4 color;
void main() {
  vec2 uv = uvs[int(gl_FragCoord.x)];
  ivec2 size = textureSize(depthMap, 0).xy;
  ivec2 p = clamp(ivec2(uv * vec2(size)), ivec2(0), size - 1);
  float raw = texelFetch(depthMap, ${array ? 'ivec3(p, layer)' : 'p'}, 0).r;
  float n = floor(clamp(raw, 0.0, 0.99999994) * 16777216.0);
  color = vec4(floor(n / 65536.0) / 255.0, mod(floor(n / 256.0), 256.0) / 255.0, mod(n, 256.0) / 255.0, 1.0);
}`;
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type);
      if (!shader) throw new Error('no shader');
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error(gl.getShaderInfoLog(shader) ?? 'probe shader');
      }
      return shader;
    };
    const program = gl.createProgram();
    if (!program) throw new Error('no program');
    gl.attachShader(program, compile(gl.VERTEX_SHADER, vertex));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) ?? 'probe program');
    }
    this.programs.set(array, program);
    return program;
  }
}

const overlayVertex = /* glsl */ `
  varying vec3 vDir;
  void main() {
    // A full-view triangle; each fragment's ray from the eye, in the world.
    vec4 view = inverse(projectionMatrix) * vec4(position.xy, 1.0, 1.0);
    vDir = mat3(inverse(viewMatrix)) * (view.xyz / view.w);
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const overlayFragment = /* glsl */ `
  ${depthChunk}
  varying vec3 vDir;
  uniform float distance;
  void main() {
    // The real depth the map sees along this eye's ray (the point 1 m out stands in for it: the
    // depth camera sits a few cm from the eye), as a colour ramp with a band every 10 cm, so its
    // edges can be checked against the room's.
    vec3 world = cameraPosition + normalize(vDir) * distance;
    float gap = depthGap(world);
    if (gap <= NO_DEPTH) discard;
    float real = distance - gap;
    float t = clamp((real - 0.3) / 2.7, 0.0, 1.0);
    vec3 ramp = mix(vec3(1.0, 0.25, 0.1), vec3(0.1, 0.4, 1.0), t);
    float band = step(0.9, fract(real * 10.0));
    gl_FragColor = vec4(mix(ramp, vec3(1.0), band * 0.6) * 0.5, 0.5);
  }
`;

/**
 * window.__occlusion.setViz('depth'): the depth map over the whole view, at its own place in
 * each eye. Added to the scene once (main.ts), hidden unless asked for.
 */
export class DepthOverlay {
  readonly object: Mesh<BufferGeometry, ShaderMaterial>;
  private readonly uniforms = { ...depthUniforms(), distance: { value: 1 } };
  occlusion: XrDepthOcclusion | null = null;

  constructor() {
    const geometry = new BufferGeometry();
    geometry.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3),
    );
    const material = new ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: overlayVertex,
      fragmentShader: overlayFragment,
      defines: { GLOW_DEPTH: DepthVariant.Array },
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    this.object = new Mesh(geometry, material);
    this.object.frustumCulled = false;
    this.object.renderOrder = 100;
    this.object.visible = false;
    this.object.onBeforeRender = (renderer, _scene, camera) => {
      const variant = this.occlusion?.bind(renderer, camera, this.uniforms) ?? 0;
      if (variant !== DepthVariant.None && material.defines.GLOW_DEPTH !== variant) {
        material.defines.GLOW_DEPTH = variant;
        material.needsUpdate = true;
      }
      if (variant === DepthVariant.None) this.uniforms.depthOn.value = 0;
      material.uniformsNeedUpdate = true;
    };
  }
}

/** The page's overlay; main.ts adds its object to the scene. */
export const depthOverlay = new DepthOverlay();

/**
 * window.__occlusion for DevTools on the headset: live switches, a probe of what the depth test
 * sees, and the stats it collected. `occlusion` is the primary glow's reader.
 */
export function installOcclusionDebug(occlusion: XrDepthOcclusion): void {
  depthOverlay.occlusion = occlusion;
  if (typeof window === 'undefined') return;
  const api = {
    settings: occlusionSettings,
    /** Real surfaces in front hide the glow. */
    setDepth(on: boolean) {
      occlusionSettings.depth = on;
      return api.state();
    },
    /** The hands' depth-only occluders. */
    setHands(on: boolean) {
      occlusionSettings.hands = on;
      return api.state();
    },
    /** Address the depth buffer top-first (hypothesis: the map is upside down). */
    setFlipY(on: boolean) {
      occlusionSettings.flipY = on;
      return api.state();
    },
    /** How much nearer than the object's front a real surface must be to hide the glow (m). */
    setMargin(m: number) {
      occlusionSettings.margin = m;
      return api.state();
    },
    /** 'cubic' (4 x 4 texels), 'smooth' (3 x 3) or 'bilinear' (2 x 2) edges. */
    setFilter(filter: OcclusionFilter) {
      occlusionSettings.filter = filter;
      return api.state();
    },
    /** How soft the edge is: half the width of the cut, 0.02 (hard) to 0.45 (very soft). */
    setSoftness(half: number) {
      occlusionSettings.softness = Math.min(0.45, Math.max(0.01, half));
      return api.state();
    },
    /** The object's surface as a tilted plane fitted inside it (true), or one depth (false). */
    setPlane(on: boolean) {
      occlusionSettings.plane = on;
      return api.state();
    },
    /** 'off'; 'depth': the map over the whole view; 'diff': the glow tinted by the depth test. */
    setViz(mode: OcclusionViz) {
      occlusionSettings.viz = mode;
      depthOverlay.object.visible = mode === 'depth';
      return api.state();
    },
    /** Measure both eyes on the next frame; read api.stats a moment later. */
    probe() {
      occlusion.probeEyes = 3;
      return 'measuring on the next frame: read __occlusion.stats';
    },
    state() {
      return { ...occlusionSettings };
    },
    get stats() {
      return {
        settings: { ...occlusionSettings },
        eyes: occlusion.stats.eyes,
        poses: occlusion.stats.poses,
      };
    },
  };
  (window as unknown as { __occlusion: typeof api }).__occlusion = api;
}

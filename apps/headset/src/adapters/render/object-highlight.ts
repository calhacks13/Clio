import {
  AddEquation,
  BufferAttribute,
  BufferGeometry,
  Color,
  CustomBlending,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  OneFactor,
  OneMinusSrcAlphaFactor,
  PlaneGeometry,
  ShaderMaterial,
} from 'three';
import type { ObjectOutline } from '../../domain/world/outline';
import { frameGuard } from './frame-guard';
import {
  DepthVariant,
  depthUniforms,
  type ProbeTarget,
  type XrDepthOcclusion,
} from './glow/depth-occlusion';
import { type GlowMode, type GlowProfile, glowProfile } from './glow/profile';
import { glowFragmentShader, glowVertexShader } from './glow/shader';
import { HighlightMask } from './highlight-mask';
import { cornerBrackets, mergeStrokes, type Stroke, strokePolyline } from './stroke';

// The light around a tracked real object, shared by the tracked outlines (outline-view.ts: the
// primary-object demo and the lesson's live tracking) and the lesson's other outlines
// (presenters/outlines). A segmenter's contour becomes a glowing volume (glow/shader.ts): a soft
// rim of light just inside the silhouette, faint light within, and a bloom outside it, all shaped
// on the GPU from an exact distance to the smoothed silhouette (one half-float channel,
// highlight-mask.ts), so a mask that is a few pixels off disappears into the
// glow. A new mask only rebuilds that field; the quad, material and texture are reused. The light
// breathes slowly and flares briefly when an object is found. A box alone does not identify a
// surface: it gets honest corner brackets instead.
//
// The light keeps the room's depth order: it depth-tests (hand occluders hide it), and in an XR
// session with a gpu-optimized depth map each eye's map fades it where a real surface is nearer
// (glow/depth-occlusion.ts). Without one it draws as before.

export const OBJECT_HIGHLIGHT_COLOR = 0x24d4ed;
export type ObjectGlowMode = GlowMode;
const EDGE_M = 0.0016;
const BRACKET_SHARE = 0.3;
/** One slow breath (ms). */
const BREATH_MS = 3600;
/** The flare when an object is found decays with this time constant (ms). */
const IGNITE_MS = 380;
/** The object's front is never taken as more than this share of its size, nor this far (m). */
const MAX_FRONT_SHARE = 0.75;
const MAX_FRONT_M = 0.4;

export class ObjectHighlight extends Group {
  private readonly mask = new HighlightMask();
  private readonly profile: GlowProfile = glowProfile(0, 0, 'surface');
  private readonly glowUniforms = {
    field: { value: this.mask.texture },
    color: { value: new Color() },
    opacity: { value: 1 },
    size: { value: 1 },
    edge: { value: 0.004 },
    halo: { value: 0.012 },
    thickness: { value: 0.004 },
    spill: { value: 1 },
    breath: { value: 0 },
    ignite: { value: 0 },
    ...depthUniforms(),
    interior: { value: this.mask.interior },
    interiorCount: { value: 0 },
    maxFront: { value: 0 },
  };
  private readonly edge = new Mesh(
    new BufferGeometry(),
    new MeshBasicMaterial({
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      forceSinglePass: true,
      toneMapped: false,
    }),
  );
  private readonly glow = new Mesh(
    new PlaneGeometry(1, 1),
    new ShaderMaterial({
      uniforms: this.glowUniforms,
      vertexShader: glowVertexShader,
      fragmentShader: glowFragmentShader,
      defines: { GLOW_DEPTH: DepthVariant.None },
      // Premultiplied: the shader's colour is light added to the scene.
      blending: CustomBlending,
      blendEquation: AddEquation,
      blendSrc: OneFactor,
      blendDst: OneMinusSrcAlphaFactor,
      blendSrcAlpha: OneFactor,
      blendDstAlpha: OneMinusSrcAlphaFactor,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      side: DoubleSide,
      forceSinglePass: true,
      toneMapped: false,
    }),
  );
  /** Off until set (the primary demo sets it; the lesson's targets draw as before). */
  private occlusion: XrDepthOcclusion | null = null;
  private readonly paths: (readonly [number, number][])[] = [[]];
  /** performance.now() when the light was last lit; -Infinity until the first outline. */
  private ignitedAt = Number.NEGATIVE_INFINITY;
  private hasEdges = false;

  constructor(color = OBJECT_HIGHLIGHT_COLOR) {
    super();
    this.glow.renderOrder = 9;
    this.edge.renderOrder = 10;
    this.glow.visible = false;
    this.edge.visible = false;
    // Once per eye per frame, no allocation: the breath and flare, and this eye's depth map.
    // Inside three's render: a throw would end the frame (frame-guard.ts), so it is caught here
    // and the light draws without its depth map.
    this.glow.onBeforeRender = (renderer, _scene, camera) => {
      const { material } = this.glow;
      const bound = frameGuard.run('glow', () => {
        this.animate(performance.now());
        const variant = this.occlusion?.bind(renderer, camera, this.glowUniforms) ?? 0;
        // The shader changes only when a depth map of another kind appears, never per frame.
        if (variant !== DepthVariant.None && material.defines.GLOW_DEPTH !== variant) {
          material.defines.GLOW_DEPTH = variant;
          material.needsUpdate = true;
        }
      });
      if (!bound) {
        this.glowUniforms.depthOn.value = 0;
        this.glowUniforms.depthMap.value.sourceTexture = null;
      }
      // Both eyes draw with the same material: upload this eye's uniforms.
      material.uniformsNeedUpdate = true;
    };
    this.add(this.edge, this.glow);
    this.setColor(color);
  }

  /** How far the glow's bright edge reaches past the silhouette (m): room for a label. */
  get reach(): number {
    return this.profile.edge * 2;
  }

  setOutline(outline: ObjectOutline, mode: ObjectGlowMode = 'surface'): void {
    const { points } = outline;
    if (outline.shape !== 'contour') {
      this.glow.visible = false;
      this.setBrackets(points);
      return;
    }
    this.clearBrackets();
    let left = Number.POSITIVE_INFINITY;
    let right = Number.NEGATIVE_INFINITY;
    let bottom = Number.POSITIVE_INFINITY;
    let top = Number.NEGATIVE_INFINITY;
    for (const [x, y] of points) {
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < bottom) bottom = y;
      if (y > top) top = y;
    }
    const profile = glowProfile(right - left, top - bottom, mode, this.profile);
    this.paths[0] = points;
    const bounds = this.mask.update(this.paths, profile.padding, profile.rounding);
    this.glow.visible = bounds !== null;
    if (!bounds) return;
    if (this.ignitedAt === Number.NEGATIVE_INFINITY) this.ignite();
    const u = this.glowUniforms;
    u.size.value = bounds.size;
    u.edge.value = profile.edge;
    u.halo.value = profile.halo;
    u.thickness.value = profile.thickness;
    u.spill.value = profile.spill;
    u.interiorCount.value = this.mask.interiorCount;
    u.maxFront.value = Math.min(
      MAX_FRONT_M,
      MAX_FRONT_SHARE * Math.max(right - left, top - bottom),
    );
    this.glow.position.set(bounds.x, bounds.y, 0);
    this.glow.scale.set(bounds.size, bounds.size, 1);
  }

  /**
   * Which depth maps hide this light (null: none), and how far in front of it a real surface
   * must be (m) before it does.
   */
  setOcclusion(occlusion: XrDepthOcclusion | null, margin?: number): void {
    this.occlusion = occlusion;
    this.glowUniforms.depthOn.value = 0;
    if (margin !== undefined) this.glowUniforms.occlusionMargin.value = margin;
  }

  /** This glow's quad and interior points, for window.__occlusion.probe(). */
  probeTarget(): ProbeTarget {
    const { glow, mask, glowUniforms } = this;
    return {
      matrixWorld: glow.matrixWorld,
      interior: mask.interior,
      get interiorCount() {
        return glowUniforms.interiorCount.value;
      },
      get maxFront() {
        return glowUniforms.maxFront.value;
      },
    };
  }

  /** Flare briefly: a new object was found (the first outline does this by itself). */
  ignite(now = performance.now()): void {
    this.ignitedAt = now;
  }

  /** The breath and the flare at `now` (ms); called before each render. */
  animate(now: number): void {
    const u = this.glowUniforms;
    u.breath.value = 0.5 - 0.5 * Math.cos((2 * Math.PI * now) / BREATH_MS);
    const since = now - this.ignitedAt;
    u.ignite.value = since >= 0 ? Math.exp(-since / IGNITE_MS) : 0;
  }

  setColor(color: number): void {
    this.glowUniforms.color.value.setHex(color);
    this.edge.material.color.copy(this.glowUniforms.color.value);
  }

  setOpacity(opacity: number): void {
    const alpha = Math.min(1, Math.max(0, opacity));
    this.edge.material.opacity = alpha * 0.95;
    this.glowUniforms.opacity.value = alpha;
  }

  override dispose(): void {
    for (const mesh of [this.edge, this.glow]) {
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
    this.mask.texture.dispose();
    super.dispose();
  }

  private setBrackets(points: readonly [number, number][]): void {
    const strokes = cornerBrackets(points, BRACKET_SHARE).map((path) =>
      strokePolyline(path, { width: EDGE_M, closed: false }),
    );
    this.edge.geometry.dispose();
    this.edge.geometry = geometryFor(mergeStrokes(strokes));
    this.edge.visible = true;
    this.hasEdges = true;
  }

  private clearBrackets(): void {
    this.edge.visible = false;
    if (!this.hasEdges) return;
    this.edge.geometry.dispose();
    this.edge.geometry = new BufferGeometry();
    this.hasEdges = false;
  }
}

function geometryFor({ positions, indices }: Stroke): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setIndex(new BufferAttribute(indices, 1));
  return geometry;
}

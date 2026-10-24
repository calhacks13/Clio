import { HighlightMask } from '../highlight-mask';

// How wide each part of the glow is for a silhouette of a given size, in metres on its plane.
// Pure numbers, so the shader stays the same for a screw head and a whole caliper and only these
// scale.

export type GlowMode = 'surface' | 'object';

export interface GlowProfile {
  /** The soft boundary: wide enough to swallow a few camera pixels of mask error. */
  edge: number;
  /** The outer bloom's falloff length. */
  halo: number;
  /** Depth of the light volume behind (and a little in front of) the outline's plane. */
  thickness: number;
  /** 0 keeps light on the measured part; 1 lets it spill around a whole object. */
  spill: number;
  /** Margin around the silhouette that holds the whole glow, at its brightest moment too. */
  padding: number;
  /** The silhouette's corners round off over this length, so the rim never creases. */
  rounding: number;
}

const MM = 0.001;
/** Field texels across: the soft edge must stay wider than one texel. */
const FIELD_TEXELS = HighlightMask.SIZE;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The profile for a silhouette of `width` x `height` metres. */
export function glowProfile(
  width: number,
  height: number,
  mode: GlowMode,
  out: GlowProfile = { edge: 0, halo: 0, thickness: 0, spill: 0, padding: 0, rounding: 0 },
): GlowProfile {
  const narrow = Math.max(0, Math.min(width, height));
  const extent = Math.max(width, height, 1e-4);
  const object = mode === 'object';
  let edge = clamp(narrow * 0.08, 1.5 * MM, 6 * MM);
  const halo = object
    ? clamp(Math.max(extent * 0.09, edge * 3), 8 * MM, 40 * MM)
    : clamp(edge * 2, 3 * MM, 12 * MM);
  const thickness = object
    ? clamp(narrow * 0.3, 3 * MM, 24 * MM)
    : clamp(edge * 0.6, 1 * MM, 3 * MM);
  // The halo swells to ~1.6x while a new object lights up; 4.5 halos hold that tail.
  const padding = halo * 4.5 + thickness + edge * 3;
  // A field texel must not be coarser than the soft edge, or the rim shows the grid.
  edge = Math.max(edge, (1.5 * (extent + padding * 2)) / FIELD_TEXELS);
  out.edge = edge;
  out.halo = halo;
  out.thickness = thickness;
  out.spill = object ? 1 : 0.45;
  out.padding = padding;
  // Never more than a fifth of the part, so a small part keeps its shape.
  out.rounding = Math.min(edge * 2.5, narrow * 0.2);
  return out;
}

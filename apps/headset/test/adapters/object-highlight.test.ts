import {
  type BufferGeometry,
  CustomBlending,
  type Mesh,
  type MeshBasicMaterial,
  OneFactor,
  OneMinusSrcAlphaFactor,
  type ShaderMaterial,
} from 'three';
import { describe, expect, it, vi } from 'vitest';
import { ObjectHighlight } from '../../src/adapters/render/object-highlight';
import type { ObjectOutline } from '../../src/domain/world/outline';

const CONTOUR: ObjectOutline = {
  shape: 'contour',
  // A concave tool shape, including a repeated closing vertex from a segmenter.
  points: [
    [0, 0],
    [0.1, 0],
    [0.1, 0.1],
    [0.05, 0.03],
    [0, 0.1],
    [0, 0],
  ],
};

const BOX: ObjectOutline = {
  shape: 'box',
  points: [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ],
};

function layers(highlight: ObjectHighlight) {
  return highlight.children as [
    Mesh<BufferGeometry, MeshBasicMaterial>,
    Mesh<BufferGeometry, ShaderMaterial>,
  ];
}

function uniform(highlight: ObjectHighlight, name: string): number {
  const value = layers(highlight)[1].material.uniforms[name]?.value;
  if (typeof value !== 'number') throw new Error(`Missing uniform ${name}`);
  return value;
}

describe('ObjectHighlight', () => {
  it('handles both contour windings and duplicate vertices without changing the detection', () => {
    const original = structuredClone(CONTOUR);
    const highlight = new ObjectHighlight();
    const field = layers(highlight)[1].material.uniforms.field?.value.image.data as Uint8Array;
    highlight.setOutline(CONTOUR);
    const first = field.slice();
    highlight.setOutline({ shape: 'contour', points: [...CONTOUR.points].reverse() });
    expect(field).toEqual(first);
    const [edge, glow] = layers(highlight);
    expect(edge.visible).toBe(false);
    expect(glow.visible).toBe(true);
    expect(glow.material.depthWrite).toBe(false);
    expect(CONTOUR).toEqual(original);
    highlight.dispose();
  });

  it('sizes the light quad to hold the silhouette and its whole bloom', () => {
    const highlight = new ObjectHighlight();
    highlight.setOutline(CONTOUR, 'object');
    const glow = layers(highlight)[1];
    const size = uniform(highlight, 'size');
    expect(glow.scale.x).toBe(size);
    expect(glow.position.x).toBeCloseTo(0.05);
    expect(glow.position.y).toBeCloseTo(0.05);
    // The silhouette plus more than four bloom lengths on each side.
    expect(size).toBeGreaterThan(0.1 + 2 * 4 * uniform(highlight, 'halo'));
    highlight.dispose();
  });

  it('adds light over the scene: premultiplied, with no depth writes', () => {
    const highlight = new ObjectHighlight();
    highlight.setOutline(CONTOUR);
    const { material } = layers(highlight)[1];
    expect(material.blending).toBe(CustomBlending);
    expect(material.blendSrc).toBe(OneFactor);
    expect(material.blendDst).toBe(OneMinusSrcAlphaFactor);
    expect(material.depthWrite).toBe(false);
    expect(material.toneMapped).toBe(false);
    highlight.dispose();
  });

  it('fades all emitted light when the target is lost', () => {
    const highlight = new ObjectHighlight();
    highlight.setOutline(CONTOUR);
    const [edge] = layers(highlight);
    highlight.setOpacity(0.5);
    expect(edge.material.opacity).toBeCloseTo(0.475);
    expect(uniform(highlight, 'opacity')).toBe(0.5);
    highlight.setOpacity(0);
    expect(edge.material.opacity).toBe(0);
    expect(uniform(highlight, 'opacity')).toBe(0);
    highlight.dispose();
  });

  it('uses a light volume for a contour and brackets for a box-only answer', () => {
    const highlight = new ObjectHighlight();
    highlight.setOutline(CONTOUR);
    const [edge, glow] = layers(highlight);
    expect(edge.visible).toBe(false);
    expect(glow.visible).toBe(true);
    highlight.setOutline(BOX);
    expect(edge.visible).toBe(true);
    expect(edge.geometry.getAttribute('position').count).toBeGreaterThan(0);
    expect(glow.visible).toBe(false);
    highlight.setOutline(CONTOUR);
    expect(edge.visible).toBe(false);
    expect(glow.visible).toBe(true);
    highlight.dispose();
  });

  it('reuses its quad, material and field for every new mask, and releases them once', () => {
    const highlight = new ObjectHighlight();
    highlight.setOutline(CONTOUR);
    const [edge, glow] = layers(highlight);
    const quad = glow.geometry;
    const texture = glow.material.uniforms.field?.value;
    const geometryDisposed = vi.spyOn(quad, 'dispose');
    const materialDisposed = vi.spyOn(glow.material, 'dispose');
    for (let i = 0; i < 5; i++) {
      highlight.setOutline({
        ...CONTOUR,
        points: CONTOUR.points.map(([x, y]) => [x + i * 1e-3, y]),
      });
    }
    expect(glow.geometry).toBe(quad);
    expect(glow.geometry.getAttribute('position').count).toBe(4);
    expect(glow.material.uniforms.field?.value).toBe(texture);
    expect(geometryDisposed).not.toHaveBeenCalled();
    expect(materialDisposed).not.toHaveBeenCalled();
    expect(highlight.children).toHaveLength(2);
    const textureDisposed = vi.spyOn(texture, 'dispose');
    const edgeDisposed = vi.spyOn(edge.geometry, 'dispose');
    highlight.dispose();
    expect(geometryDisposed).toHaveBeenCalledOnce();
    expect(materialDisposed).toHaveBeenCalledOnce();
    expect(textureDisposed).toHaveBeenCalledOnce();
    expect(edgeDisposed).toHaveBeenCalledOnce();
  });

  it('keeps a part on its surface and lets a whole object glow around itself', () => {
    const highlight = new ObjectHighlight();
    highlight.setOutline(CONTOUR);
    const material = layers(highlight)[1].material;
    const surface = {
      spill: uniform(highlight, 'spill'),
      halo: uniform(highlight, 'halo'),
      thickness: uniform(highlight, 'thickness'),
    };
    highlight.setOutline(CONTOUR, 'object');
    expect(layers(highlight)[1].material).toBe(material);
    expect(uniform(highlight, 'spill')).toBe(1);
    expect(surface.spill).toBeLessThan(1);
    expect(uniform(highlight, 'halo')).toBeGreaterThan(surface.halo);
    expect(uniform(highlight, 'thickness')).toBeGreaterThan(surface.thickness);
    highlight.setOutline(CONTOUR, 'surface');
    expect(uniform(highlight, 'spill')).toBe(surface.spill);
    highlight.dispose();
  });

  it('breathes slowly and flares when an object is found', () => {
    const highlight = new ObjectHighlight();
    highlight.ignite(1000);
    highlight.animate(1000);
    expect(uniform(highlight, 'ignite')).toBe(1);
    highlight.animate(1400);
    const flare = uniform(highlight, 'ignite');
    expect(flare).toBeGreaterThan(0.2);
    expect(flare).toBeLessThan(0.5);
    highlight.animate(4000);
    expect(uniform(highlight, 'ignite')).toBeLessThan(0.001);
    // One breath is a few seconds: barely changed over a frame, fully changed over half a breath.
    const breaths = [0, 14, 1800].map((t) => {
      highlight.animate(t);
      return uniform(highlight, 'breath');
    });
    expect(Math.abs((breaths[1] ?? 0) - (breaths[0] ?? 0))).toBeLessThan(0.01);
    expect(Math.abs((breaths[2] ?? 0) - (breaths[0] ?? 0))).toBeGreaterThan(0.9);
    highlight.dispose();
  });

  it('flares by itself for its first silhouette only', () => {
    const highlight = new ObjectHighlight();
    const now = vi.spyOn(performance, 'now').mockReturnValue(5000);
    highlight.setOutline(CONTOUR);
    now.mockReturnValue(9000);
    highlight.setOutline(CONTOUR);
    highlight.animate(5000);
    expect(uniform(highlight, 'ignite')).toBe(1);
    now.mockRestore();
    highlight.dispose();
  });
});

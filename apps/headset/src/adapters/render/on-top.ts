import type { Group, Material, Mesh, Object3D } from 'three';

// Panels that follow the head and the names over objects draw over everything else: over the
// glow, and over the hands' depth-only occluders (hand-occluders.ts), which would otherwise hide a
// panel or a name wherever a hand comes between it and the eye, as it often does when a learner
// leans over the table with the hands up near the face. Only the glow keeps the hands' depth order.
//
// drawOnTop makes every mesh under `root` skip the depth test and write no depth, and puts it in
// three's transparent pass, which comes after the opaque occluders and skeletons. Every group
// under `root` takes `order` as its renderOrder, which three uses as the group order of what is
// inside (WebGLRenderer.projectObject), so the whole panel draws after anything outside it.
// Inside, nothing is depth-tested any more, so each mesh's own renderOrder sets the layering: a
// background 0, what lies on it higher; two meshes of one order are drawn back to front by their
// centres, which a panel seen at an angle gets wrong. Their bounds are not culled with: a panel
// that follows the head is in view by construction, and troika's text bounds lag a sync behind.

/** The group order of panels drawn on top: after everything else in the scene. */
export const ON_TOP_ORDER = 50;

const isGroup = (o: Object3D): o is Group => (o as Group).isGroup === true;
const isMesh = (o: Object3D): o is Mesh => (o as Mesh).isMesh === true;

/** One material drawn on top: no depth test or write, in the transparent pass. */
export function onTopMaterial<M extends Material>(material: M): M {
  material.depthTest = false;
  material.depthWrite = false;
  material.transparent = true;
  return material;
}

/** Everything under `root` (itself included) draws on top, in groups of `order`. */
export function drawOnTop<T extends Object3D>(root: T, order = ON_TOP_ORDER): T {
  root.traverse((o) => {
    if (isGroup(o)) o.renderOrder = order;
    if (!isMesh(o)) return;
    o.frustumCulled = false;
    // troika's Text hands out its derived materials here (the outline's first), made once.
    const { material } = o;
    for (const m of Array.isArray(material) ? material : [material]) onTopMaterial(m);
  });
  return root;
}

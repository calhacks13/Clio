import { Group, Mesh, MeshBasicMaterial, SphereGeometry, TorusGeometry, Vector3 } from 'three';
import type { Text } from 'troika-three-text';
import type { HighlightStyle } from '../../../domain/events';
import { drawOnTop } from '../on-top';
import type { PresentContext, Presenter } from '../presenter';
import { makeText, setText } from '../text';

// Where Clio thinks each object is (a faint dot, so learners can see what it sees) and highlight
// rings for the objects the step or the coach points at. An object with an outline around it
// (OutlinesPresenter) keeps its label but loses the ring; one whose live light is on
// (LiveHighlightsPresenter, which names it) loses both.

const STYLE_COLOR: Record<HighlightStyle, number> = {
  target: 0x4fe3ff,
  attention: 0xffd23f,
  warning: 0xff4d5e,
};

interface Marker {
  group: Group;
  dot: Mesh;
  ring: Mesh;
  label: Text;
  ringMaterial: MeshBasicMaterial;
  /** The object size the ring and label were built for. */
  radius: number;
}

const dotGeometry = new SphereGeometry(0.006, 12, 8);
const ringGeometry = (radius: number) =>
  new TorusGeometry(Math.max(0.02, radius * 1.3), 0.0035, 8, 48);
const labelHeight = (radius: number) => Math.max(0.03, radius) + 0.02;
const head = new Vector3();
const here = new Vector3();

export class ObjectMarkersPresenter implements Presenter {
  readonly object = new Group();
  private readonly markers = new Map<string, Marker>();

  /** `lit`: whether an object's live light is on. */
  constructor(private readonly lit: (objectId: string) => boolean = () => false) {}

  update(ctx: PresentContext): void {
    const seen = new Set<string>();
    const styles = new Map(ctx.snapshot.highlights.map((h) => [h.objectId, h.style]));
    const outlined = new Set(ctx.snapshot.outlines.map((o) => o.objectId));
    head.set(...ctx.head.p);

    for (const est of ctx.objects) {
      if (est.spec.hidden && !ctx.debug) continue;
      seen.add(est.id);
      const marker = this.markers.get(est.id) ?? this.create(est.id, est.spec.radius);
      // A plan's later stage can write the object's size again.
      if (marker.radius !== est.spec.radius) this.resize(marker, est.spec.radius);
      marker.group.position.set(...est.position);
      setText(marker.label, est.spec.label);

      const style = styles.get(est.id);
      const lit = this.lit(est.id);
      // Outlines hide while the object is in hand, so the ring comes back then.
      marker.ring.visible =
        style !== undefined && !lit && (!outlined.has(est.id) || est.heldBy !== null);
      marker.label.visible = (style !== undefined && !lit) || ctx.debug;
      if (style) {
        marker.ringMaterial.color.setHex(STYLE_COLOR[style]);
        const speed = style === 'attention' ? 8 : 3;
        const pulse = 1 + 0.08 * Math.sin((ctx.t / 1000) * speed);
        marker.ring.scale.setScalar(pulse);
      }
      (marker.dot.material as MeshBasicMaterial).opacity = est.confidence < 0.5 ? 0.3 : 0.7;
      // Keep the label facing the learner.
      marker.label.getWorldPosition(here);
      marker.label.lookAt(head);
    }

    for (const [id, marker] of this.markers) {
      if (!seen.has(id)) {
        this.object.remove(marker.group);
        marker.label.dispose();
        this.markers.delete(id);
      }
    }
  }

  private create(id: string, radius: number): Marker {
    const group = new Group();
    const dot = new Mesh(
      dotGeometry,
      new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7 }),
    );
    const ringMaterial = new MeshBasicMaterial({
      color: STYLE_COLOR.target,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    });
    const ring = new Mesh(ringGeometry(radius), ringMaterial);
    ring.rotation.x = -Math.PI / 2;
    const label = makeText({ size: 0.022, anchorX: 'center', anchorY: 'bottom' });
    label.position.set(0, labelHeight(radius), 0);
    // After the glows, and over the hands (on-top.ts): a name stays readable as a hand works.
    label.renderOrder = 11;
    drawOnTop(label);
    group.add(dot, ring, label);
    this.object.add(group);
    const marker = { group, dot, ring, label, ringMaterial, radius };
    this.markers.set(id, marker);
    return marker;
  }

  private resize(marker: Marker, radius: number): void {
    marker.ring.geometry.dispose();
    marker.ring.geometry = ringGeometry(radius);
    marker.label.position.y = labelHeight(radius);
    marker.radius = radius;
  }
}

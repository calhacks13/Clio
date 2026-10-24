import { Group, Mesh, MeshBasicMaterial, SphereGeometry, TorusGeometry, Vector3 } from 'three';
import type { Text } from 'troika-three-text';
import type { HighlightStyle } from '../../../domain/events';
import type { PresentContext, Presenter } from '../presenter';
import { makeText, setText } from '../text';

// Where Clio thinks each object is (a faint dot, so learners can see what it sees) and highlight
// rings for the objects the step or the coach points at.

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
}

const dotGeometry = new SphereGeometry(0.006, 12, 8);
const head = new Vector3();
const here = new Vector3();

export class ObjectMarkersPresenter implements Presenter {
  readonly object = new Group();
  private readonly markers = new Map<string, Marker>();

  update(ctx: PresentContext): void {
    const seen = new Set<string>();
    const styles = new Map(ctx.snapshot.highlights.map((h) => [h.objectId, h.style]));
    head.set(...ctx.head.p);

    for (const est of ctx.objects) {
      if (est.spec.hidden && !ctx.debug) continue;
      seen.add(est.id);
      const marker = this.markers.get(est.id) ?? this.create(est.id, est.spec.radius);
      marker.group.position.set(...est.position);
      setText(marker.label, est.spec.label);

      const style = styles.get(est.id);
      marker.ring.visible = style !== undefined;
      marker.label.visible = style !== undefined || ctx.debug;
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
    const ring = new Mesh(
      new TorusGeometry(Math.max(0.02, radius * 1.3), 0.0035, 8, 48),
      ringMaterial,
    );
    ring.rotation.x = -Math.PI / 2;
    const label = makeText({ size: 0.022, anchorX: 'center', anchorY: 'bottom' });
    label.position.set(0, Math.max(0.03, radius) + 0.02, 0);
    group.add(dot, ring, label);
    this.object.add(group);
    const marker = { group, dot, ring, label, ringMaterial };
    this.markers.set(id, marker);
    return marker;
  }
}

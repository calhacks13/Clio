import type { ObjectSpec } from '@clio/protocol';
import { Group, Matrix4, Vector3 } from 'three';
import { add, invertPose, transformPoint } from '../../../core/math';
import type { OverlayOutline } from '../../../domain/overlay/overlay-model';
import { billboard, type ObjectOutline } from '../../../domain/world/outline';
import { OBJECT_HIGHLIGHT_COLOR, type ObjectGlowMode, ObjectHighlight } from '../object-highlight';
import type { PresentContext, Presenter } from '../presenter';

// Glows over the real objects the current step shows: the finder's silhouette, or corner
// brackets around its box. Each one hangs on a plane through the object's current estimate, so it
// rides along when the object is carried and put down, and the plane turns toward the learner
// every frame, so the outline stays around the object as they move. An object the tracker follows
// live is drawn by LiveHighlightsPresenter instead while its live light is on; this stays the
// fallback (the Gemini finder, a tracker that is down or has not found it yet).

/** What to act on, then where it goes. */
export const RANK_COLORS = [OBJECT_HIGHLIGHT_COLOR, 0xffd23f] as const;

/** A whole tool or container glows around itself; anything else lights the surface it marks. */
export const glowModeFor = (spec: Pick<ObjectSpec, 'kind'>): ObjectGlowMode =>
  spec.kind === 'tool' || spec.kind === 'container' ? 'object' : 'surface';

interface Drawn {
  group: ObjectHighlight;
  /** The outline the mesh was built from (outlines are replaced, never mutated). */
  outline: ObjectOutline;
  mode: ObjectGlowMode;
}

const basis = new Matrix4();
const right = new Vector3();
const up = new Vector3();
const toEye = new Vector3();

export class OutlinesPresenter implements Presenter {
  readonly object = new Group();
  private readonly drawn = new Map<string, Drawn>();

  /** `lit`: whether an object's live light is on (it is drawn there instead). */
  constructor(private readonly lit: (objectId: string) => boolean = () => false) {}

  update(ctx: PresentContext): void {
    const eye = transformPoint(invertPose(ctx.worldFromWorkspace), ctx.head.p);
    const estimates = new Map(ctx.objects.map((o) => [o.id, o]));
    const visible = new Set<string>();
    for (const item of ctx.snapshot.outlines) {
      const estimate = estimates.get(item.objectId);
      // In hand, the outline would cover the fingers, and the shape it traced is out of date.
      if (!estimate || estimate.heldBy || this.lit(item.objectId)) continue;
      const center = add(estimate.position, item.offset);
      const plane = billboard(center, eye);
      if (!plane) continue;
      visible.add(item.objectId);
      const { group } = this.draw(item, glowModeFor(estimate.spec));
      group.position.set(...center);
      basis.makeBasis(right.set(...plane.right), up.set(...plane.up), toEye.set(...plane.normal));
      group.quaternion.setFromRotationMatrix(basis);
      group.setColor(RANK_COLORS[Math.min(item.rank, RANK_COLORS.length - 1)] ?? 0);
    }
    const listed = new Set(ctx.snapshot.outlines.map((o) => o.objectId));
    for (const [id, drawn] of this.drawn) {
      if (!listed.has(id)) this.remove(id, drawn);
      else drawn.group.visible = visible.has(id);
    }
  }

  dispose(): void {
    for (const [id, drawn] of this.drawn) this.remove(id, drawn);
  }

  private draw(item: OverlayOutline, mode: ObjectGlowMode): Drawn {
    const existing = this.drawn.get(item.objectId);
    if (existing?.outline === item.outline && existing.mode === mode) return existing;
    if (existing) {
      existing.group.setOutline(item.outline, mode);
      existing.outline = item.outline;
      existing.mode = mode;
      return existing;
    }
    const group = new ObjectHighlight();
    group.setOutline(item.outline, mode);
    this.object.add(group);
    const drawn = { group, outline: item.outline, mode };
    this.drawn.set(item.objectId, drawn);
    return drawn;
  }

  private remove(id: string, drawn: Drawn): void {
    this.object.remove(drawn.group);
    drawn.group.dispose();
    this.drawn.delete(id);
  }
}

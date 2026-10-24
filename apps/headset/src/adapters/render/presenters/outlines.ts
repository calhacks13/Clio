import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Vector3,
} from 'three';
import { add, invertPose, transformPoint } from '../../../core/math';
import type { OverlayOutline } from '../../../domain/overlay/overlay-model';
import { billboard, type ObjectOutline } from '../../../domain/world/outline';
import type { PresentContext, Presenter } from '../presenter';
import { cornerBrackets, mergeStrokes, type Stroke, strokePolyline } from '../stroke';

// Outlines around the real objects the current step shows: the finder's contour, or corner
// brackets around its box. Each one hangs on a plane through the object's current estimate, so it
// rides along when the object is carried and put down, and the plane turns toward the learner
// every frame, so the outline stays around the object as they move.

/** What to act on, then where it goes. */
const RANK_COLORS = [0x4fe3ff, 0xffd23f] as const;
const STROKE_M = 0.004;
const BRACKET_SHARE = 0.3;

interface Drawn {
  group: Group;
  mesh: Mesh<BufferGeometry, MeshBasicMaterial>;
  /** The outline the mesh was built from (outlines are replaced, never mutated). */
  outline: ObjectOutline;
}

const basis = new Matrix4();
const right = new Vector3();
const up = new Vector3();
const toEye = new Vector3();

export class OutlinesPresenter implements Presenter {
  readonly object = new Group();
  private readonly drawn = new Map<string, Drawn>();

  update(ctx: PresentContext): void {
    const eye = transformPoint(invertPose(ctx.worldFromWorkspace), ctx.head.p);
    const estimates = new Map(ctx.objects.map((o) => [o.id, o]));
    const visible = new Set<string>();
    for (const item of ctx.snapshot.outlines) {
      const estimate = estimates.get(item.objectId);
      // In hand, the outline would cover the fingers, and the shape it traced is out of date.
      if (!estimate || estimate.heldBy) continue;
      const center = add(estimate.position, item.offset);
      const plane = billboard(center, eye);
      if (!plane) continue;
      visible.add(item.objectId);
      const { group, mesh } = this.draw(item);
      group.position.set(...center);
      basis.makeBasis(right.set(...plane.right), up.set(...plane.up), toEye.set(...plane.normal));
      group.quaternion.setFromRotationMatrix(basis);
      mesh.material.color.setHex(RANK_COLORS[Math.min(item.rank, RANK_COLORS.length - 1)] ?? 0);
      mesh.material.opacity = 0.8 + 0.15 * Math.sin(ctx.t / 250);
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

  private draw(item: OverlayOutline): Drawn {
    const existing = this.drawn.get(item.objectId);
    if (existing?.outline === item.outline) return existing;
    const geometry = toGeometry(strokeFor(item.outline));
    if (existing) {
      existing.mesh.geometry.dispose();
      existing.mesh.geometry = geometry;
      existing.outline = item.outline;
      return existing;
    }
    const material = new MeshBasicMaterial({
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
    });
    const mesh = new Mesh(geometry, material);
    mesh.renderOrder = 10;
    const group = new Group();
    group.add(mesh);
    this.object.add(group);
    const drawn = { group, mesh, outline: item.outline };
    this.drawn.set(item.objectId, drawn);
    return drawn;
  }

  private remove(id: string, drawn: Drawn): void {
    this.object.remove(drawn.group);
    drawn.mesh.geometry.dispose();
    drawn.mesh.material.dispose();
    this.drawn.delete(id);
  }
}

function strokeFor(outline: ObjectOutline): Stroke {
  if (outline.shape === 'contour') {
    return strokePolyline(outline.points, { width: STROKE_M, closed: true, outside: true });
  }
  return mergeStrokes(
    cornerBrackets(outline.points, BRACKET_SHARE).map((corner) =>
      strokePolyline(corner, { width: STROKE_M, closed: false }),
    ),
  );
}

function toGeometry({ positions, indices }: Stroke): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setIndex(new BufferAttribute(indices, 1));
  return geometry;
}

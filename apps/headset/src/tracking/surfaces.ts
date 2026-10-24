import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  Quaternion,
  Vector3,
} from 'three';
import type { Text } from 'troika-three-text';
import { mergeStrokes, type Stroke, strokePolyline } from '../adapters/render/stroke';
import { makeText, setText } from '../adapters/render/text';
import { SURFACE_COLORS, type SurfaceKind, surfaceKind, surfaceTitle } from './palette';
import { type Point2, polygonCentroid, polygonGrid } from './polygon';

// Every detected plane (frame.detectedPlanes) as a solid outline, a sparse grid and a floating
// label, colored by semantic label. Planes come, change and go with the frame's set; geometry is
// rebuilt only when a plane's lastChangedTime moves, and its pose is refreshed every frame.

const OUTLINE_WIDTH = 0.012;
const GRID_WIDTH = 0.004;
const GRID_SPACING = 0.25;
const LABEL_LIFT = 0.1;
/** Label text height at 1 m; labels scale with distance so a far wall reads like a near table. */
const LABEL_SIZE = 0.03;
const LABEL_MIN_SCALE = 0.5;
const LABEL_MAX_SCALE = 5;

interface PlaneVisual {
  /** Plane space: x and z span the polygon, +y is the normal. */
  readonly group: Group;
  readonly outline: Mesh;
  readonly grid: Mesh;
  /** World space, so it can face the viewer whatever the plane's orientation. */
  readonly label: Text;
  readonly anchor: Vector3;
  changed: number;
  seen: number;
}

interface KindMaterials {
  outline: MeshBasicMaterial;
  grid: MeshBasicMaterial;
}

function kindMaterials(color: number): KindMaterials {
  return {
    outline: new MeshBasicMaterial({ color, side: DoubleSide }),
    grid: new MeshBasicMaterial({ color: new Color(color).multiplyScalar(0.55), side: DoubleSide }),
  };
}

function strokeGeometry(stroke: Stroke): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(stroke.positions, 3));
  geometry.setIndex(new BufferAttribute(stroke.indices, 1));
  return geometry;
}

export class SurfacesView {
  readonly object = new Group();
  /** False when the session has no plane detection (e.g. no Space Setup on the Quest). */
  enabled = true;
  private readonly visuals = new Map<XRPlane, PlaneVisual>();
  private readonly materials = Object.fromEntries(
    (Object.keys(SURFACE_COLORS) as SurfaceKind[]).map((kind) => [
      kind,
      kindMaterials(SURFACE_COLORS[kind]),
    ]),
  ) as Record<SurfaceKind, KindMaterials>;
  private stamp = 0;
  private frame: XRFrame | null = null;
  private space: XRReferenceSpace | null = null;
  private readonly head = new Vector3();
  private readonly orientation = new Quaternion();

  get count(): number {
    return this.visuals.size;
  }

  update(frame: XRFrame, space: XRReferenceSpace, head: Vector3, orientation: Quaternion): void {
    let planes: XRPlaneSet | undefined;
    try {
      planes = this.enabled ? frame.detectedPlanes : undefined;
    } catch {
      this.enabled = false;
    }
    this.stamp++;
    this.frame = frame;
    this.space = space;
    this.head.copy(head);
    this.orientation.copy(orientation);
    planes?.forEach(this.track);
    this.visuals.forEach(this.sweep);
    this.frame = null;
  }

  clear(): void {
    this.stamp++;
    this.visuals.forEach(this.sweep);
  }

  private readonly track = (plane: XRPlane): void => {
    let visual = this.visuals.get(plane);
    if (!visual) {
      visual = this.create();
      this.visuals.set(plane, visual);
    }
    visual.seen = this.stamp;
    if (visual.changed !== plane.lastChangedTime) this.rebuild(visual, plane);
    const pose = this.frame && this.space && this.frame.getPose(plane.planeSpace, this.space);
    visual.group.visible = Boolean(pose);
    visual.label.visible = Boolean(pose);
    if (!pose) return;
    visual.group.matrix.fromArray(pose.transform.matrix);
    visual.group.matrixWorldNeedsUpdate = true;
    const label = visual.label;
    label.position.copy(visual.anchor).applyMatrix4(visual.group.matrix);
    label.quaternion.copy(this.orientation);
    const distance = label.position.distanceTo(this.head);
    label.scale.setScalar(Math.min(Math.max(distance, LABEL_MIN_SCALE), LABEL_MAX_SCALE));
  };

  private readonly sweep = (visual: PlaneVisual, plane: XRPlane): void => {
    if (visual.seen === this.stamp) return;
    visual.outline.geometry.dispose();
    visual.grid.geometry.dispose();
    visual.label.dispose();
    this.object.remove(visual.group, visual.label);
    this.visuals.delete(plane);
  };

  private create(): PlaneVisual {
    const group = new Group();
    group.matrixAutoUpdate = false;
    // Strokes are drawn in x/y; turning them a quarter about x lays them in the plane's x/z.
    const flat = new Group();
    flat.rotation.x = Math.PI / 2;
    const grid = new Mesh(new BufferGeometry(), this.materials.other.grid);
    const outline = new Mesh(new BufferGeometry(), this.materials.other.outline);
    grid.position.z = -0.001;
    outline.position.z = -0.002;
    flat.add(grid, outline);
    group.add(flat);
    const label = makeText({ size: LABEL_SIZE, anchorX: 'center', anchorY: 'bottom', bold: true });
    // Heavier than the default outline: these sit on busy passthrough, often on a same-hue surface.
    label.outlineWidth = '12%';
    this.object.add(group, label);
    return { group, outline, grid, label, anchor: new Vector3(), changed: Number.NaN, seen: 0 };
  }

  private rebuild(visual: PlaneVisual, plane: XRPlane): void {
    visual.changed = plane.lastChangedTime;
    const polygon: Point2[] = plane.polygon.map((point) => [point.x, point.z] as const);
    const kind = surfaceKind(plane.semanticLabel);
    visual.outline.material = this.materials[kind].outline;
    visual.grid.material = this.materials[kind].grid;
    visual.outline.geometry.dispose();
    visual.outline.geometry = strokeGeometry(
      strokePolyline(polygon, { width: OUTLINE_WIDTH, closed: true }),
    );
    visual.grid.geometry.dispose();
    visual.grid.geometry = strokeGeometry(
      mergeStrokes(
        polygonGrid(polygon, GRID_SPACING).map((segment) =>
          strokePolyline(segment, { width: GRID_WIDTH, closed: false }),
        ),
      ),
    );
    const [cx, cz] = polygonCentroid(polygon);
    visual.anchor.set(cx, LABEL_LIFT, cz);
    visual.label.color = SURFACE_COLORS[kind];
    setText(visual.label, surfaceTitle(plane.semanticLabel));
  }
}

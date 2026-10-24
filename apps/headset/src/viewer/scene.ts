import type { FrameRecord, Vec3 } from '@clio/protocol';
import {
  AxesHelper,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  GridHelper,
  Group,
  HemisphereLight,
  Line,
  LineBasicMaterial,
  LineLoop,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  OctahedronGeometry,
  PerspectiveCamera,
  RingGeometry,
  Scene,
  SphereGeometry,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { HandMesh } from '../adapters/render/presenters/hand-mesh';
import type { Detection, ObjectView } from './episode-data';

// The viewer's 3D view of one episode, in its workspace frame (y-up, meters): the table surface as
// a grid with the calibrated outline, the head as a small frustum with a trail, both hands as
// joint skeletons, objects at their estimates with labels, and the object finder's answers.

export const COLORS = {
  background: 0x070b14,
  grid: 0x1c2840,
  gridCenter: 0x2a3a5c,
  workspace: 0x4fe3ff,
  head: 0xe8eefc,
  trail: 0x8ea0c2,
  left: 0x4fe3ff,
  right: 0xff6fae,
  object: 0xe8eefc,
  detection: 0xffd23f,
} as const;

/** Everything the scene shows at one moment. */
export interface SceneView {
  frame: FrameRecord | null;
  trail: Vec3[];
  objects: ObjectView[];
  detections: { detection: Detection; outline: Vec3[] | null }[];
}

const TRAIL_POINTS = 240;
const GRID_SIZE = 2;
const RING = new RingGeometry(0.85, 1, 48);
const DOT = new SphereGeometry(0.006, 12, 8);
const OBJECT_MATERIAL = new MeshBasicMaterial({ color: COLORS.object });

/** A pyramid looking down -z, the WebXR viewer's forward, with a tick on top to show roll. */
function frustumGeometry(): BufferGeometry {
  const [w, h, d] = [0.05, 0.035, 0.09];
  const corners = [
    [-w, h, -d],
    [w, h, -d],
    [w, -h, -d],
    [-w, -h, -d],
  ] as const;
  const points: number[] = [];
  const segment = (a: readonly number[], b: readonly number[]) => points.push(...a, ...b);
  corners.forEach((c, i) => {
    segment([0, 0, 0], c);
    segment(c, corners[(i + 1) % 4] ?? c);
  });
  segment([-w / 3, h, -d], [0, h * 1.6, -d]);
  segment([0, h * 1.6, -d], [w / 3, h, -d]);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(points), 3));
  return geometry;
}

function label(text: string, className: string): CSS2DObject {
  const element = document.createElement('div');
  element.className = className;
  element.textContent = text;
  const object = new CSS2DObject(element);
  object.center.set(0.5, 1);
  return object;
}

/** An object's reference point, a ring of its radius on the surface, and its label. */
class ObjectMarker {
  readonly object = new Group();
  private readonly ring = new Mesh(RING, OBJECT_MATERIAL);
  private readonly tag: CSS2DObject;

  constructor(view: ObjectView) {
    this.ring.rotation.x = -Math.PI / 2;
    this.tag = label(view.label, 'label');
    this.tag.position.set(0, 0.03, 0);
    this.object.add(this.ring, new Mesh(DOT, OBJECT_MATERIAL), this.tag);
  }

  update(view: ObjectView): void {
    this.object.position.set(...view.position);
    this.ring.scale.setScalar(view.radius);
    if (this.tag.element.textContent !== view.label) this.tag.element.textContent = view.label;
  }

  /** Removing a parent leaves a CSS2D label's element behind; take it out here. */
  dispose(): void {
    this.tag.element.remove();
  }
}

/** Where the object finder placed an object, and its outline as the camera saw it. */
export class DetectionMarker {
  readonly object = new Group();
  private readonly outline: LineLoop;
  private readonly pin: Mesh;
  /** The outline the geometry was built from (outlines are cached per detection, so by identity). */
  private shown: Vec3[] | null = null;

  constructor() {
    this.pin = new Mesh(
      new OctahedronGeometry(0.01),
      new MeshBasicMaterial({ color: COLORS.detection }),
    );
    this.outline = new LineLoop(
      new BufferGeometry(),
      new LineBasicMaterial({ color: COLORS.detection }),
    );
    this.object.add(this.pin, this.outline);
  }

  update(detection: Detection, outline: Vec3[] | null): void {
    const position = detection.found ? detection.position : null;
    this.object.visible = position !== null;
    if (!position) return;
    this.pin.position.set(...position);
    this.outline.visible = outline !== null;
    if (outline && outline !== this.shown) {
      // A new geometry per outline: setFromPoints on a used one only refills the first buffer
      // (clamped to its size) and keeps its old bounding sphere.
      this.outline.geometry.dispose();
      this.outline.geometry = new BufferGeometry().setFromPoints(
        outline.map((p) => new Vector3(...p)),
      );
      this.shown = outline;
    }
  }

  dispose(): void {
    this.outline.geometry.dispose();
    this.pin.geometry.dispose();
  }
}

export class EpisodeScene {
  readonly renderer = new WebGLRenderer({ antialias: true });
  private readonly labels = new CSS2DRenderer();
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(50, 1, 0.01, 50);
  private readonly controls: OrbitControls;
  private readonly workspace = new Group();
  private readonly outline = new Line(
    new BufferGeometry(),
    new LineBasicMaterial({ color: COLORS.workspace }),
  );
  private grid: GridHelper | null = null;
  private readonly head = new LineSegments(
    frustumGeometry(),
    new LineBasicMaterial({ color: COLORS.head }),
  );
  private readonly trail: Line;
  private readonly hands = {
    left: new HandMesh(COLORS.left, 1),
    right: new HandMesh(COLORS.right, 1),
  };
  private readonly objects = new Map<string, ObjectMarker>();
  private readonly detections = new Map<string, DetectionMarker>();

  constructor(private readonly container: HTMLElement) {
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.scene.background = new Color(COLORS.background);
    this.labels.domElement.className = 'labels';
    container.append(this.renderer.domElement, this.labels.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.maxDistance = 8;

    this.scene.add(new HemisphereLight(0xffffff, 0x334455, 2));
    const sun = new DirectionalLight(0xffffff, 1.5);
    sun.position.set(1, 3, 2);
    this.scene.add(sun);

    this.workspace.add(this.outline, new AxesHelper(0.08));
    const trailGeometry = new BufferGeometry();
    trailGeometry.setAttribute(
      'position',
      new BufferAttribute(new Float32Array(TRAIL_POINTS * 3), 3),
    );
    this.trail = new Line(trailGeometry, new LineBasicMaterial({ color: COLORS.trail }));
    this.trail.frustumCulled = false;
    this.scene.add(this.workspace, this.head, this.trail, this.hands.left.object);
    this.scene.add(this.hands.right.object);

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
  }

  /** The table outline (width along +x, depth toward -z) and a camera that frames it. */
  setWorkspace([width, depth]: readonly [number, number]): void {
    this.outline.geometry.setFromPoints([
      new Vector3(0, 0, 0),
      new Vector3(width, 0, 0),
      new Vector3(width, 0, -depth),
      new Vector3(0, 0, -depth),
      new Vector3(0, 0, 0),
    ]);
    // Always five points, so refilling in place is fine; the bounds still have to follow.
    this.outline.geometry.computeBoundingSphere();
    if (this.grid) {
      this.workspace.remove(this.grid);
      this.grid.dispose();
    }
    // 5 cm cells, centered on the table, the surface sitting just under the outline.
    this.grid = new GridHelper(GRID_SIZE, GRID_SIZE * 20, COLORS.gridCenter, COLORS.grid);
    this.grid.position.set(width / 2, -0.001, -depth / 2);
    this.workspace.add(this.grid);

    const span = Math.max(width, depth, 0.4);
    this.controls.target.set(width / 2, 0, -depth / 2);
    this.camera.position.set(width / 2, span * 1.1, span * 1.2);
    this.controls.update();
  }

  /** Forget the previous episode's objects and detections. */
  reset(): void {
    for (const marker of [...this.objects.values(), ...this.detections.values()]) {
      marker.object.removeFromParent();
      marker.dispose();
    }
    this.objects.clear();
    this.detections.clear();
    this.update({ frame: null, trail: [], objects: [], detections: [] });
  }

  update(view: SceneView): void {
    const head = view.frame?.head;
    this.head.visible = head !== undefined;
    if (head) {
      this.head.position.set(head[0], head[1], head[2]);
      this.head.quaternion.set(head[3], head[4], head[5], head[6]);
    }
    this.updateTrail(view.trail);
    this.hands.left.update(view.frame?.left ?? null);
    this.hands.right.update(view.frame?.right ?? null);
    this.sync(
      this.objects,
      view.objects,
      (o) => o.id,
      (o) => new ObjectMarker(o),
      (m, o) => m.update(o),
    );
    this.sync(
      this.detections,
      view.detections,
      (d) => d.detection.objectId,
      () => new DetectionMarker(),
      (m, d) => m.update(d.detection, d.outline),
    );
  }

  render(): void {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
  }

  private updateTrail(points: readonly Vec3[]): void {
    const attribute = this.trail.geometry.getAttribute('position') as BufferAttribute;
    const shown = points.slice(-TRAIL_POINTS);
    for (const [i, p] of shown.entries()) attribute.setXYZ(i, p[0], p[1], p[2]);
    attribute.needsUpdate = true;
    this.trail.geometry.setDrawRange(0, shown.length);
  }

  /** Keeps one marker per key: adds new ones, updates the rest, removes the ones that left. */
  private sync<T, M extends { object: Group; dispose(): void }>(
    markers: Map<string, M>,
    items: readonly T[],
    key: (item: T) => string,
    create: (item: T) => M,
    update: (marker: M, item: T) => void,
  ): void {
    const seen = new Set<string>();
    for (const item of items) {
      const k = key(item);
      seen.add(k);
      let marker = markers.get(k);
      if (!marker) {
        marker = create(item);
        markers.set(k, marker);
        this.scene.add(marker.object);
      }
      update(marker, item);
    }
    for (const [k, marker] of markers) {
      if (seen.has(k)) continue;
      marker.object.removeFromParent();
      marker.dispose();
      markers.delete(k);
    }
  }

  private resize(): void {
    const { clientWidth: width, clientHeight: height } = this.container;
    if (width === 0 || height === 0) return;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
    this.labels.setSize(width, height);
  }
}

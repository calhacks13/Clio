import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  EdgesGeometry,
  Group,
  LineBasicMaterial,
  LineLoop,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  TorusGeometry,
} from 'three';
import {
  type Capture,
  type Entity,
  entityAt,
  graspMarks,
  heldAt,
  type Lane,
  trail,
  validSpans,
} from './model';

// Draws a Capture's objects as time series: each object at its pose at the viewed time, with a trail
// of its recent path, faded while its position is not valid (drawn where it was last seen), and
// ringed while a hand holds it (from grasp and release events). `object` is in the capture's world
// frame (ROS REP-103: z up, meters), so put it in a z-up scene. Objects that appear while a live
// recording streams in are added on the next update.

const PALETTE = [
  '#ffb347',
  '#7dffa4',
  '#ff6fae',
  '#b49cff',
  '#ffd23f',
  '#5ad1c5',
  '#ff8a5c',
  '#9fd3ff',
];
const HELD_COLOR = '#4fe3ff';
const TRAIL_US = 3_000_000;
const TRAIL_POINTS = 240;
const LOST_OPACITY = 0.25;
const DOT_RADIUS = 0.012;
const DEFAULT_RADIUS = 0.03;
const LABEL_HEIGHT = 0.022;

export interface ObjectTracksOptions {
  /** Also draw static environment boxes (a Capture package's table). Clio's workspace is not. */
  environment?: boolean;
}

interface Track {
  entity: Entity;
  color: string;
  group: Group;
  bodyMaterials: (MeshBasicMaterial | LineBasicMaterial)[];
  trail: LineSegments;
  held: Mesh;
  label: Sprite | null;
}

export class ObjectTracksView {
  readonly object = new Group();
  readonly #tracks = new Map<string, Track>();
  readonly #environment: boolean;
  readonly #disposables: { dispose(): void }[] = [];

  constructor(
    readonly model: Capture,
    options: ObjectTracksOptions = {},
  ) {
    this.object.name = 'capture-objects';
    this.#environment = options.environment ?? false;
    this.#sync();
  }

  update(tUs: number): void {
    this.#sync();
    const held = heldAt(this.model, tUs);
    for (const track of this.#tracks.values()) this.#place(track, tUs, held.has(track.entity.id));
  }

  /** One lane per object, in the order objects appeared. */
  lanes(): Lane[] {
    this.#sync();
    const end = this.model.endUs;
    return [...this.#tracks.values()]
      .filter((t) => t.entity.role === 'object')
      .map(({ entity, color }) => ({
        entityId: entity.id,
        label: entity.name,
        validSpans:
          entity.motion === 'static'
            ? [[0, end]]
            : validSpans(this.model.poses.get(entity.id), end),
        marks: graspMarks(this.model, entity.id),
        color,
      }));
  }

  dispose(): void {
    for (const d of this.#disposables) d.dispose();
    this.#disposables.length = 0;
    this.#tracks.clear();
    this.object.clear();
  }

  #sync(): void {
    for (const entity of this.model.entities.values()) {
      if (this.#tracks.has(entity.id)) continue;
      const drawn =
        entity.role === 'object' || (this.#environment && entity.role === 'environment');
      if (drawn) this.#tracks.set(entity.id, this.#build(entity));
    }
  }

  #own<T extends { dispose(): void }>(thing: T): T {
    this.#disposables.push(thing);
    return thing;
  }

  #build(entity: Entity): Track {
    const objects = [...this.#tracks.values()].filter((t) => t.entity.role === 'object').length;
    const color =
      entity.geometry.type === 'box'
        ? entity.geometry.color
        : (PALETTE[objects % PALETTE.length] ?? PALETTE[0] ?? '#ffffff');
    const group = new Group();
    group.name = entity.id;
    const radius = entity.extensions?.radius_m ?? DEFAULT_RADIUS;
    const bodyMaterials: Track['bodyMaterials'] = [];
    const material = () => {
      const m = this.#own(new MeshBasicMaterial({ color, transparent: true }));
      bodyMaterials.push(m);
      return m;
    };
    const lineMaterial = (c: string) => {
      const m = this.#own(new LineBasicMaterial({ color: c, transparent: true }));
      bodyMaterials.push(m);
      return m;
    };

    if (entity.geometry.type === 'box') {
      const box = this.#own(new BoxGeometry(...entity.geometry.size));
      group.add(new Mesh(box, material()));
      const edge = new Color(color).offsetHSL(0, 0, 0.2).getStyle();
      group.add(new LineSegments(this.#own(new EdgesGeometry(box)), lineMaterial(edge)));
    } else {
      group.add(new Mesh(this.#own(new SphereGeometry(DOT_RADIUS, 16, 12)), material()));
      // The object's extent, flat on the table (the xy plane is horizontal in a z-up world).
      const ring = new LineLoop(this.#own(circle(radius)), lineMaterial(color));
      group.add(ring);
    }

    const held = new Mesh(
      this.#own(new TorusGeometry(radius + 0.012, 0.004, 8, 48)),
      this.#own(new MeshBasicMaterial({ color: HELD_COLOR })),
    );
    held.visible = false;
    group.add(held);

    const label = labelSprite(entity.name, color);
    if (label) {
      this.#own(label.material.map as CanvasTexture);
      this.#own(label.material);
      const top = entity.geometry.type === 'box' ? entity.geometry.size[2] / 2 : DOT_RADIUS;
      label.position.set(0, 0, top + 0.02);
      group.add(label);
    }

    const trailGeometry = this.#own(new BufferGeometry());
    trailGeometry.setAttribute(
      'position',
      new BufferAttribute(new Float32Array(TRAIL_POINTS * 2 * 3), 3),
    );
    const trailLine = new LineSegments(trailGeometry, this.#own(new LineBasicMaterial({ color })));
    trailLine.frustumCulled = false;

    if (entity.motion === 'static' && entity.pose) {
      group.position.set(...entity.pose.translation);
      group.quaternion.set(...entity.pose.rotation);
    }
    group.visible = entity.motion === 'static' && entity.pose !== null;
    this.object.add(group, trailLine);
    return { entity, color, group, bodyMaterials, trail: trailLine, held, label };
  }

  #place(track: Track, tUs: number, held: boolean): void {
    const { entity, group } = track;
    track.held.visible = held;
    if (entity.motion === 'static') return;
    const series = this.model.poses.get(entity.id);
    const at = series ? entityAt(series, tUs) : null;
    group.visible = !!at?.position;
    track.trail.visible = group.visible;
    if (!series || !at?.position) return;
    group.position.set(...at.position);
    if (at.rotation) group.quaternion.set(...at.rotation);
    const opacity = at.lost ? LOST_OPACITY : 1;
    for (const m of track.bodyMaterials) m.opacity = opacity;
    if (track.label) track.label.material.opacity = opacity;

    const lines = trail(series, tUs, TRAIL_US, TRAIL_POINTS);
    const attribute = track.trail.geometry.getAttribute('position') as BufferAttribute;
    const out = attribute.array as Float32Array;
    let n = 0;
    for (const line of lines) {
      for (let i = 1; i < line.length && n < TRAIL_POINTS * 2; i++, n += 2) {
        out.set(line[i - 1] as number[], n * 3);
        out.set(line[i] as number[], n * 3 + 3);
      }
    }
    attribute.needsUpdate = true;
    track.trail.geometry.setDrawRange(0, n);
  }

  /** The drawn object for an entity (for picking or tests). */
  objectFor(entityId: string): Object3D | null {
    return this.#tracks.get(entityId)?.group ?? null;
  }
}

function circle(radius: number, segments = 48): BufferGeometry {
  const points = new Float32Array(segments * 3);
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    points.set([Math.cos(a) * radius, Math.sin(a) * radius, 0], i * 3);
  }
  return new BufferGeometry().setAttribute('position', new BufferAttribute(points, 3));
}

/** A name tag that always faces the camera. Null without a DOM (unit tests). */
function labelSprite(text: string, color: string): Sprite | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const font = '600 28px system-ui, -apple-system, "Segoe UI", sans-serif';
  ctx.font = font;
  const width = Math.ceil(ctx.measureText(text).width) + 28;
  const height = 44;
  canvas.width = width;
  canvas.height = height;
  ctx.fillStyle = '#0f1728';
  ctx.beginPath();
  ctx.roundRect(0, 0, width, height, 10);
  ctx.fill();
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 14, height / 2 + 1);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  const sprite = new Sprite(
    new SpriteMaterial({ map: texture, depthTest: false, transparent: true }),
  );
  sprite.center.set(0.5, 0);
  sprite.scale.set((LABEL_HEIGHT * width) / height, LABEL_HEIGHT, 1);
  sprite.renderOrder = 10;
  return sprite;
}

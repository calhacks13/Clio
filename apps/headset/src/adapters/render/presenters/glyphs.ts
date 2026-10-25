import {
  type BufferGeometry,
  CatmullRomCurve3,
  ConeGeometry,
  type Curve,
  Group,
  LineCurve3,
  Mesh,
  MeshBasicMaterial,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
  TubeGeometry,
  Vector3,
} from 'three';
import type { Demonstration, Glyph } from '../../../domain/demo/types';
import type { PresentContext, Presenter } from '../presenter';

const CYAN = 0x24d4ed;
const YELLOW = 0xffd23f;
const WHITE = 0xf2f6fa;
const UP = new Vector3(0, 1, 0);
const MOTION_PREFERENCE =
  typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;

/** A persistent path, true endpoint, and two directional chevrons visible from either eye. */
class MotionPath extends Group {
  private readonly runners: Mesh[] = [];
  private readonly tangent = new Vector3();
  private readonly headFraction: number;

  constructor(
    private readonly path: Curve<Vector3>,
    destination = false,
  ) {
    super();
    const length = path.getLength();
    const radius = Math.min(0.006, length * 0.045);
    const headLength = Math.min(0.035, length * 0.28);
    this.headFraction = headLength / length;
    const material = new MeshBasicMaterial({ color: CYAN });
    // End the shaft under the cone's base instead of drawing a line through its point.
    const end = 1 - this.headFraction * 0.8;
    const points = Array.from({ length: 49 }, (_, i) => path.getPointAt((end * i) / 48));
    this.add(
      new Mesh(new TubeGeometry(new CatmullRomCurve3(points), 48, radius, 10, false), material),
    );
    const head = new Mesh(new ConeGeometry(radius * 2.7, headLength, 20), material);
    path.getTangentAt(1, this.tangent).normalize();
    head.quaternion.setFromUnitVectors(UP, this.tangent);
    head.position.copy(path.getPointAt(1)).addScaledVector(this.tangent, -headLength / 2);
    this.add(head);
    const start = new Mesh(new SphereGeometry(radius * 1.3, 12, 8), material);
    start.position.copy(path.getPointAt(0));
    this.add(start);
    if (destination) {
      const ring = new Mesh(
        new TorusGeometry(radius * 3.2, radius * 0.45, 10, 40),
        new MeshBasicMaterial({ color: YELLOW }),
      );
      ring.position.copy(path.getPointAt(1));
      ring.rotation.x = -Math.PI / 2;
      this.add(ring);
    }
    // Conical sleeves read as chevrons from every angle, rather than vanishing edge-on in AR.
    const runnerMaterial = new MeshBasicMaterial({ color: WHITE });
    const runnerGeometry = new ConeGeometry(radius * 1.9, radius * 2.8, 16, 1, true);
    for (let i = 0; i < 2; i++) {
      const runner = new Mesh(runnerGeometry, runnerMaterial);
      this.runners.push(runner);
      this.add(runner);
    }
    this.animate(0, true);
  }

  animate(elapsed: number, reduced: boolean): void {
    for (let i = 0; i < this.runners.length; i++) {
      const runner = this.runners[i];
      if (!runner) continue;
      const phase = reduced ? (i + 1) / 3 : (((elapsed / 1700 + i * 0.5) % 1) + 1) % 1;
      const u = 0.1 + phase * (0.8 - this.headFraction);
      this.path.getPointAt(u, runner.position);
      this.path.getTangentAt(u, this.tangent).normalize();
      runner.quaternion.setFromUnitVectors(UP, this.tangent);
    }
  }
}

function build(glyph: Glyph): MotionPath[] {
  const lifted = (p: readonly number[], height = 0.05) =>
    new Vector3(p[0], (p[1] ?? 0) + height, p[2]);
  const arrow = (from: Vector3, to: Vector3, destination = false) =>
    from.distanceToSquared(to) < 1e-8
      ? []
      : [new MotionPath(new LineCurve3(from, to), destination)];
  switch (glyph.kind) {
    case 'arrow':
      return arrow(lifted(glyph.from), lifted(glyph.to), true);
    case 'press':
      return arrow(lifted(glyph.at, 0.12), lifted(glyph.at, 0.015), true);
    case 'sweep': {
      const a = lifted(glyph.from, 0.035);
      const b = lifted(glyph.to, 0.035);
      const middle = a.clone().lerp(b, 0.5);
      return [...arrow(middle, a), ...arrow(middle, b)];
    }
    case 'arc': {
      if (glyph.radius < 0.001 || Math.abs(glyph.angle) < 0.001) return [];
      const axis = new Vector3(...glyph.axis);
      if (axis.lengthSq() < 1e-8) return [];
      axis.normalize();
      const orientation = new Quaternion().setFromUnitVectors(UP, axis);
      const center = new Vector3(...glyph.center).addScaledVector(axis, 0.04);
      const sweep = Math.max(-2 * Math.PI, Math.min(2 * Math.PI, glyph.angle)) * 0.85;
      const points = Array.from({ length: 65 }, (_, i) => {
        const angle = (sweep * i) / 64;
        return new Vector3(glyph.radius * Math.cos(angle), 0, -glyph.radius * Math.sin(angle))
          .applyQuaternion(orientation)
          .add(center);
      });
      return [new MotionPath(new CatmullRomCurve3(points))];
    }
  }
}

export class GlyphsPresenter implements Presenter {
  readonly object = new Group();
  private current: Demonstration | null = null;
  private paths: MotionPath[] = [];
  private started = 0;

  constructor(private readonly reducedMotion = () => MOTION_PREFERENCE?.matches ?? false) {}

  update(ctx: PresentContext): void {
    if (ctx.demo !== this.current) {
      this.disposePaths();
      this.current = ctx.demo;
      this.started = ctx.t;
      this.paths = (ctx.demo?.glyphs ?? []).flatMap(build);
      if (this.paths.length) this.object.add(...this.paths);
    }
    this.object.visible = ctx.demo !== null;
    for (const path of this.paths) path.animate(ctx.t - this.started, this.reducedMotion());
  }

  dispose(): void {
    this.disposePaths();
    this.current = null;
  }

  private disposePaths(): void {
    const geometries = new Set<BufferGeometry>();
    const materials = new Set<MeshBasicMaterial>();
    this.object.traverse((object) => {
      if (object instanceof Mesh) {
        geometries.add(object.geometry);
        materials.add(object.material as MeshBasicMaterial);
      }
    });
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    this.object.clear();
    this.paths = [];
  }
}

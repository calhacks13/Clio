import {
  ArrowHelper,
  BufferGeometry,
  ConeGeometry,
  Group,
  Line,
  LineBasicMaterial,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  Vector3,
} from 'three';
import type { Demonstration, Glyph } from '../../../domain/demo/types';
import type { PresentContext, Presenter } from '../presenter';

// Arrows, twist arcs, press and sweep cues that accompany a demonstration (workspace frame).
// Rebuilt only when the demonstration changes.

const COLOR = 0x66e3ff;

function arrow(from: Vector3, to: Vector3): Object3D {
  const d = new Vector3().subVectors(to, from);
  const len = d.length();
  return new ArrowHelper(
    d.normalize(),
    from,
    Math.max(0.01, len),
    COLOR,
    Math.min(0.04, len * 0.3),
    0.02,
  );
}

function build(glyph: Glyph): Object3D {
  switch (glyph.kind) {
    case 'arrow':
      return arrow(
        new Vector3(...glyph.from).setY(glyph.from[1] + 0.05),
        new Vector3(...glyph.to).setY(glyph.to[1] + 0.05),
      );
    case 'sweep': {
      const g = new Group();
      const a = new Vector3(...glyph.from);
      const b = new Vector3(...glyph.to);
      const mid = a.clone().lerp(b, 0.5);
      g.add(arrow(mid, a), arrow(mid, b));
      return g;
    }
    case 'press': {
      const cone = new Mesh(
        new ConeGeometry(0.012, 0.03, 16),
        new MeshBasicMaterial({ color: COLOR }),
      );
      cone.rotation.x = Math.PI;
      cone.position.set(glyph.at[0], glyph.at[1] + 0.06, glyph.at[2]);
      return cone;
    }
    case 'arc': {
      const points: Vector3[] = [];
      const steps = 48;
      const sweep = Math.max(-2 * Math.PI, Math.min(2 * Math.PI, glyph.angle)) * 0.85;
      for (let i = 0; i <= steps; i++) {
        const a = (sweep * i) / steps;
        // Positive angle = counterclockwise seen from above (+y).
        points.push(
          new Vector3(
            glyph.center[0] + glyph.radius * Math.cos(a),
            glyph.center[1] + 0.03,
            glyph.center[2] - glyph.radius * Math.sin(a),
          ),
        );
      }
      const g = new Group();
      g.add(
        new Line(
          new BufferGeometry().setFromPoints(points),
          new LineBasicMaterial({ color: COLOR }),
        ),
      );
      const end = points.at(-1);
      const before = points.at(-2);
      if (end && before)
        g.add(arrow(before, end.clone().add(end.clone().sub(before).multiplyScalar(4))));
      return g;
    }
  }
}

export class GlyphsPresenter implements Presenter {
  readonly object = new Group();
  private current: Demonstration | null = null;

  update(ctx: PresentContext): void {
    if (ctx.demo !== this.current) {
      this.object.clear();
      this.current = ctx.demo;
      for (const glyph of ctx.demo?.glyphs ?? []) this.object.add(build(glyph));
    }
    this.object.visible = ctx.demo !== null;
  }
}

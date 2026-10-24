import { Group } from 'three';
import type { PresentContext, Presenter } from '../presenter';
import { HandMesh } from './hand-mesh';

/** Translucent demonstration hands (workspace frame), plus optional debug hands for tracking. */
export class GhostHandsPresenter implements Presenter {
  readonly object = new Group();
  private readonly ghost = {
    left: new HandMesh(0x66e3ff, 0.5),
    right: new HandMesh(0x66e3ff, 0.5),
  };
  private readonly tracked = {
    left: new HandMesh(0xffffff, 0.18),
    right: new HandMesh(0xffffff, 0.18),
  };

  constructor() {
    for (const h of [this.ghost.left, this.ghost.right, this.tracked.left, this.tracked.right]) {
      this.object.add(h.object);
    }
  }

  update(ctx: PresentContext): void {
    this.ghost.left.update(ctx.demoHands?.left ?? null);
    this.ghost.right.update(ctx.demoHands?.right ?? null);
    this.tracked.left.update(ctx.debug ? (ctx.hands?.left ?? null) : null);
    this.tracked.right.update(ctx.debug ? (ctx.hands?.right ?? null) : null);
  }

  dispose(): void {
    for (const h of [this.ghost.left, this.ghost.right, this.tracked.left, this.tracked.right])
      h.dispose();
  }
}

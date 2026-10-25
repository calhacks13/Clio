import { Group } from 'three';
import type { PresentContext, Presenter } from '../presenter';
import { GloveHand } from './glove-hand';

/**
 * Solid demonstration gloves (workspace frame). The learner's own tracked hands are drawn by the
 * app's live skeleton (tracking/hands.ts), not here.
 */
export class GhostHandsPresenter implements Presenter {
  readonly object = new Group();
  private readonly ghost = {
    left: new GloveHand(),
    right: new GloveHand(),
  };

  constructor() {
    this.object.add(this.ghost.left.object, this.ghost.right.object);
  }

  update(ctx: PresentContext): void {
    this.ghost.left.update(ctx.demoHands?.left ?? null);
    this.ghost.right.update(ctx.demoHands?.right ?? null);
  }

  dispose(): void {
    this.ghost.left.dispose();
    this.ghost.right.dispose();
  }
}

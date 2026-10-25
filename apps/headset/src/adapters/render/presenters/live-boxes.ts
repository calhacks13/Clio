import { Group, Vector3 } from 'three';
import { distance, type Vec3 } from '../../../core/math';
import type { Accent } from '../../../domain/overlay/accents';
import type { Point2 } from '../../../domain/world/outline';
import { BoxView } from '../box-view';
import type { XrDepthOcclusion } from '../glow/depth-occlusion';
import type { PresentContext, Presenter } from '../presenter';

// The bounding boxes of the objects the tracker follows live (app/live-tracker.ts decides which:
// every lit object, every followed one with ?debug=1, and Robotics-ER's boxes for a moment), in
// the room's frame (worldRoot), next to their glow (live-highlights.ts), whose depth occlusion
// they share. One BoxView per box: reshaped only when its shape changes (a new box from the
// tracker), otherwise just moved with the object; its lines are rebuilt as well when the eye has
// come much nearer or gone much farther, so they keep their width as an angle. A box that leaves
// the list fades out.

/** Rebuild a box's lines when its distance from the eye has changed by this share. */
const RESIZE_SHARE = 0.2;

export interface LiveBox {
  /** What is boxed: an object id, or a key of its own for one of Robotics-ER's boxes. */
  key: string;
  /** World space: the object, where its box's plane passes. */
  center: Vec3;
  /**
   * The box about `center` on the plane facing the eye (x right, y up): the image's top left,
   * top right, bottom right and bottom left.
   */
  corners: readonly Point2[];
  /** Bumped whenever the box changes; between them only the center moves. */
  shapeVersion: number;
  /** The tag: the object's name, and a debug line under it (null: none). */
  label: string;
  detail: string | null;
  accent: Accent;
  /** Another finder's box (Robotics-ER's, ?debug=1): dashed, no corners. */
  dashed: boolean;
}

export interface LiveBoxesOptions {
  /** The glow's depth occlusion, so the boxes hide behind what hides the glow (none: unoccluded). */
  occlusion?: XrDepthOcclusion | null;
}

interface Drawn {
  view: BoxView;
  shape: number;
  dashed: boolean;
  /** The distance from the eye its lines were sized for (m). */
  sizedAt: number;
}

export class LiveBoxesPresenter implements Presenter {
  readonly object = new Group();
  private readonly drawn = new Map<string, Drawn>();
  private readonly eye = new Vector3();

  constructor(
    private readonly source: () => readonly LiveBox[],
    private readonly options: LiveBoxesOptions = {},
  ) {}

  update(ctx: PresentContext): void {
    this.eye.set(...ctx.head.p);
    const listed = new Set<string>();
    for (const box of this.source()) {
      listed.add(box.key);
      this.draw(box, distance(box.center, ctx.head.p));
    }
    for (const [key, drawn] of this.drawn) {
      const gone = !listed.has(key);
      if (gone) drawn.view.fade();
      drawn.view.update(this.eye, ctx.dt);
      if (gone && drawn.view.dark) this.remove(key, drawn);
    }
  }

  dispose(): void {
    for (const [key, drawn] of this.drawn) this.remove(key, drawn);
  }

  private draw(box: LiveBox, away: number): void {
    const drawn = this.drawn.get(box.key) ?? this.create(box.key);
    const { view } = drawn;
    const resized = Math.abs(away - drawn.sizedAt) > RESIZE_SHARE * drawn.sizedAt;
    if (box.shapeVersion !== drawn.shape || box.dashed !== drawn.dashed || resized) {
      view.show(box, away, box.dashed);
      drawn.shape = box.shapeVersion;
      drawn.dashed = box.dashed;
      drawn.sizedAt = away;
    } else {
      view.moveTo(box.center);
    }
    view.setLabel(box.label, box.detail);
    view.setAccent(box.accent);
  }

  private create(key: string): Drawn {
    const view = new BoxView(this.options.occlusion ?? null);
    this.object.add(view.object);
    const drawn: Drawn = { view, shape: -1, dashed: false, sizedAt: 0 };
    this.drawn.set(key, drawn);
    return drawn;
  }

  private remove(key: string, drawn: Drawn): void {
    this.object.remove(drawn.view.object);
    drawn.view.dispose();
    this.drawn.delete(key);
  }
}

import { Group, Vector3 } from 'three';
import type { HighlightStyle } from '../../../domain/events';
import { ACCENTS, type Accent } from '../../../domain/overlay/accents';
import type { Placement } from '../../../domain/world/placement';
import { installOcclusionDebug, type WindowFar, XrDepthOcclusion } from '../glow/depth-occlusion';
import type { ObjectGlowMode } from '../object-highlight';
import { PrimaryOutlineView } from '../outline-view';
import type { PresentContext, Presenter } from '../presenter';

// The glow around each object the tracker follows live (domain/world/live-objects.ts), in the
// room's frame (worldRoot): the primary page's light, one per object, at the object's measured
// distance and where it is now, with its name above it. Real surfaces in front of an object hide
// its light through the headset's depth map (one XrDepthOcclusion shared by every glow), and the
// hands through their occluders. Colours and energy follow the shared step-role accents, with
// coach styles applied by LiveTracking. An object that leaves the set fades out. An object whose
// bounding box is drawn too (live-boxes.ts, which shares this occlusion) has its name on the box's
// tag instead of over the glow.

export const WARNING_COLOR = ACCENTS.stop;

export interface LiveHighlight {
  id: string;
  /** World space, where the object is now. */
  placement: Placement;
  /** Bumped whenever the shape changes; between them only the center moves. */
  shapeVersion: number;
  label: string;
  /** Its place in the step's show list (0 is what to act on); null when only a highlight shows it. */
  rank: number | null;
  /** The coach's highlight on it, while that lasts. */
  style: HighlightStyle | null;
  /** The step role and coach style resolved by the presentation model. */
  accent: Accent;
  mode: ObjectGlowMode;
  /** In the learner's hand. */
  held: boolean;
  /** Its name is on its box's tag (live-boxes.ts), not over the glow. */
  tagged?: boolean;
}

export interface LiveHighlightsOptions {
  /** How this runtime's depth map encodes window depth ('infinite' for IWER). */
  windowFar?: WindowFar;
  /** Hide an object's light while it is in hand, as OutlinesPresenter does; off: follow it. */
  hideHeld?: boolean;
}

interface Drawn {
  view: PrimaryOutlineView;
  shape: number;
  label: string;
  mode: ObjectGlowMode;
  style: HighlightStyle | null;
}

export class LiveHighlightsPresenter implements Presenter {
  readonly object = new Group();
  /** One for every glow, and for the boxes drawn next to them (live-boxes.ts). */
  readonly occlusion: XrDepthOcclusion;
  private readonly drawn = new Map<string, Drawn>();
  /** The object whose glow window.__occlusion.probe() measures. */
  private probed: string | null = null;
  private readonly eye = new Vector3();

  constructor(
    private readonly source: () => readonly LiveHighlight[],
    private readonly options: LiveHighlightsOptions = {},
  ) {
    this.occlusion = new XrDepthOcclusion(options.windowFar);
    installOcclusionDebug(this.occlusion);
  }

  update(ctx: PresentContext): void {
    this.eye.set(...ctx.head.p);
    const listed = new Set<string>();
    for (const h of this.source()) {
      if (this.options.hideHeld && h.held) continue;
      listed.add(h.id);
      this.draw(h);
    }
    for (const [id, drawn] of this.drawn) {
      const gone = !listed.has(id);
      if (gone) drawn.view.fade();
      drawn.view.update(this.eye, ctx.dt, ctx.t);
      if (gone && drawn.view.dark) this.remove(id, drawn);
    }
  }

  dispose(): void {
    for (const [id, drawn] of this.drawn) this.remove(id, drawn);
  }

  private draw(h: LiveHighlight): void {
    const drawn = this.drawn.get(h.id) ?? this.create(h.id);
    const { view } = drawn;
    if (h.shapeVersion !== drawn.shape || h.label !== drawn.label || h.mode !== drawn.mode) {
      view.show(h.placement, h.label, h.mode);
      drawn.shape = h.shapeVersion;
      drawn.label = h.label;
      drawn.mode = h.mode;
    } else {
      view.object.position.set(...h.placement.center);
    }
    view.named = !h.tagged;
    view.setAccent(h.accent);
    if (h.style !== null && h.style !== drawn.style) view.ignite();
    view.pulse = h.style === 'warning';
    drawn.style = h.style;
  }

  private create(id: string): Drawn {
    const view = new PrimaryOutlineView({ occlusion: this.occlusion });
    this.object.add(view.object);
    if (this.probed === null) {
      this.probed = id;
      this.occlusion.probeTarget = view.probeTarget();
    }
    const drawn: Drawn = { view, shape: -1, label: '', mode: 'surface', style: null };
    this.drawn.set(id, drawn);
    return drawn;
  }

  private remove(id: string, drawn: Drawn): void {
    this.object.remove(drawn.view.object);
    drawn.view.dispose();
    this.drawn.delete(id);
    if (this.probed !== id) return;
    this.probed = null;
    this.occlusion.probeTarget = null;
  }
}

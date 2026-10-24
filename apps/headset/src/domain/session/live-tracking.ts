import type { Procedure, Step } from '@clio/protocol';
import type { AppBus, HighlightStyle } from '../events';
import { COACH_HIGHLIGHT_MS } from '../overlay/overlay-model';
import type { ObjectRegistry } from '../world/object-registry';

// Which objects the tracker follows live (tracker/TRACK.md, objects mode), and in which words. The
// lesson names them, never the tracker: the focused step's show items, in rank order, and for as
// long as a coach highlight lasts (5 s, like OverlayModel's), the object it points at, the closer
// look's included. Each object is followed in its show item's description (else its tracking
// query, else its label), with one phrase for the whole lesson: the tracker starts an object's
// track over whenever its phrase changes, so the first phrase the lesson gives an object is kept
// (its first show item's, else its label). The set empties when the lesson ends.
//
// The dependency runs one way (docs/coach-plan.md, the perception boundary): the plan and the
// coach say what to follow, and nothing the tracker sees comes back through here.

/** The tracker follows at most this many objects; the rest wait for room. */
export const MAX_LIVE_OBJECTS = 8;

export interface LiveObject {
  id: string;
  /** A short category noun phrase (the tracker's subject), the same for the whole lesson. */
  phrase: string;
  /** What tells it apart, in this moment's words. */
  query: string;
  /** Its place in the focused step's show list (0 is what to act on); null when not shown. */
  rank: number | null;
  /** The coach's highlight on it, while that lasts. */
  style: HighlightStyle | null;
}

export interface LiveTrackingDeps {
  bus: AppBus;
  /** The lesson's declared objects. */
  registry: Pick<ObjectRegistry, 'spec'>;
  /** The lesson's plan as it is now. */
  procedure: () => Procedure | null;
}

interface Highlight {
  style: HighlightStyle;
  until: number;
}

export class LiveTracking {
  /** The focused step's show items, in rank order. */
  private shown: Step['show'] = [];
  private readonly highlights = new Map<string, Highlight>();
  /** The phrase each object was first followed with, this lesson. */
  private readonly phrases = new Map<string, string>();
  private list: LiveObject[] = [];

  constructor(private readonly deps: LiveTrackingDeps) {}

  attach(): () => void {
    const { bus } = this.deps;
    const offs = [
      bus.on('procedure.started', () => {
        this.phrases.clear();
        this.clear();
      }),
      // Every focus change enters a step: the next one, a skip, a refocus, a revised plan.
      bus.on('step.entered', ({ stepId }) => {
        const step = this.deps.procedure()?.steps.find((s) => s.id === stepId);
        this.shown = step?.show ?? [];
        // Like the overlay's, a coach highlight belongs to the step it was made in.
        this.highlights.clear();
        this.rebuild();
      }),
      bus.on('overlay.highlight', ({ t, objectId, style, source }) => {
        if (source !== 'coach' || !this.deps.registry.spec(objectId)) return;
        this.highlights.delete(objectId);
        this.highlights.set(objectId, { style, until: t + COACH_HIGHLIGHT_MS });
        this.rebuild();
      }),
      // A revision that keeps the focus (stage rest) may write an object's words again: the query
      // follows them, the phrase stays.
      bus.on('plan.ready', ({ revision }) => {
        if (revision) this.rebuild();
      }),
      bus.on('procedure.completed', () => this.clear()),
      bus.on('procedure.aborted', () => this.clear()),
    ];
    return () => {
      for (const off of offs) off();
    };
  }

  /** Per frame: highlights that ran out leave the set. */
  update(t: number): void {
    let expired = false;
    for (const [id, h] of this.highlights) {
      if (h.until > t) continue;
      this.highlights.delete(id);
      expired = true;
    }
    if (expired) this.rebuild();
  }

  /** What to follow now: the step's show items in rank order, then highlighted objects. */
  get objects(): readonly LiveObject[] {
    return this.list;
  }

  get(id: string): LiveObject | undefined {
    return this.list.find((o) => o.id === id);
  }

  private clear(): void {
    this.shown = [];
    this.highlights.clear();
    this.rebuild();
  }

  private rebuild(): void {
    const list: LiveObject[] = [];
    const add = (object: LiveObject) => {
      if (list.length < MAX_LIVE_OBJECTS && !list.some((o) => o.id === object.id)) {
        list.push(object);
      }
    };
    for (const [rank, item] of this.shown.entries()) {
      add({
        id: item.object,
        phrase: this.phraseFor(item.object, item.phrase),
        query: item.description,
        rank,
        style: this.highlights.get(item.object)?.style ?? null,
      });
    }
    for (const [id, { style }] of this.highlights) {
      const spec = this.deps.registry.spec(id);
      if (!spec) continue;
      add({
        id,
        phrase: this.phraseFor(id, this.firstShowPhrase(id) ?? spec.label),
        query: spec.tracking?.query ?? spec.label,
        rank: null,
        style,
      });
    }
    this.list = list;
  }

  /** The phrase `id` was first followed with this lesson, else `candidate` (kept from now on). */
  private phraseFor(id: string, candidate: string): string {
    const kept = this.phrases.get(id);
    if (kept !== undefined) return kept;
    this.phrases.set(id, candidate);
    return candidate;
  }

  /** The phrase of the plan's first show item for `id`, if any step shows it. */
  private firstShowPhrase(id: string): string | undefined {
    for (const step of this.deps.procedure()?.steps ?? []) {
      const item = step.show.find((s) => s.object === id);
      if (item) return item.phrase;
    }
    return undefined;
  }
}

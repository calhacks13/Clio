import type { HighlightRole, ObjectSpec, Procedure, Step } from '@clio/protocol';
import type { AppBus, HighlightStyle } from '../events';
import { type Accent, inferRole, roleAccent, styledAccent } from '../overlay/accents';
import { coachHighlightUntil, stepLights } from '../overlay/lights';
import { findWords } from '../world/find-words';
import type { ObjectRegistry } from '../world/object-registry';

// Which objects the tracker follows live (tracker/TRACK.md, objects mode), and in which words. The
// lesson names them, never the tracker: every object the plan declares, from the moment the
// lesson starts until it ends, so the recording has each one wherever the learner takes it.
//
// While a step is focused something is lit whenever there is something to do (overlay/lights.ts):
// the step's show items in rank order, else its targets, then its action's objects; then the
// action focus's item (Robotics-ER 2's next thing to touch, for the rest of the step); then what
// the coach highlights, a `target` for the step (until another replaces it), an `attention` hint
// for 5 s, a `warning` as a pulse; then the plan's other objects in its order, unlit, as far as
// there is room. Hidden zones and points are left out: the camera cannot find them.
//
// Each object is followed in its show item's description (else its tracking query, else its
// label), or in the action focus's sharper words for it once it has some, until the plan's words
// for it change. One phrase serves the whole lesson: the tracker starts an object's track over
// whenever its phrase changes, so the first phrase the lesson gives an object is kept (its first
// show item's, else its label). The set empties when the lesson ends.
//
// The dependency runs one way (docs/coach-plan.md, the perception boundary): the plan, the coach
// and the action focus say what to follow, and nothing the tracker sees comes back through here.

/** The tracker follows at most this many objects; the rest wait for room. */
export const MAX_LIVE_OBJECTS = 8;

export interface LiveObject {
  id: string;
  /** A short category noun phrase (the tracker's subject), the same for the whole lesson. */
  phrase: string;
  /** What tells it apart, in this moment's words. */
  query: string;
  /**
   * Its place among what the focused step lights (0 is what to act on): its show items, else its
   * targets and its action's objects, then the action focus's item; null when the step does not
   * light it.
   */
  rank: number | null;
  /** The coach's highlight on it, while that lasts. */
  style: HighlightStyle | null;
  /** Resolved in show order, shared with the fallback outline renderer. */
  accent: Accent;
}

/** Whether a followed object's light is on: the step lights it or the coach highlights it. */
export const isShown = (object: Pick<LiveObject, 'rank' | 'style'>): boolean =>
  object.rank !== null || object.style !== null;

/** Whether the camera can be asked to find a declared object: not a hidden zone, not a point. */
const findable = (spec: ObjectSpec): boolean => !spec.hidden && spec.kind !== 'point';

export interface LiveTrackingDeps {
  bus: AppBus;
  /** The lesson's declared objects. */
  registry: Pick<ObjectRegistry, 'spec'>;
  /** The lesson's plan as it is now. */
  procedure: () => Procedure | null;
}

interface Highlight {
  style: HighlightStyle;
  /** Infinity for a `target`: it lasts the step. */
  until: number;
}

/** The action focus's words for an object, and the plan's words they stand in for. */
interface Refined {
  query: string;
  over: string;
}

export class LiveTracking {
  /** The focused step, while one is. */
  private stepId: string | null = null;
  /** The action focus's item for the focused step: what ER said to touch next. */
  private focusItem: string | null = null;
  private readonly highlights = new Map<string, Highlight>();
  /** The phrase each object was first followed with, this lesson. */
  private readonly phrases = new Map<string, string>();
  /** The action focus's words for objects, each until the plan's words for it change. */
  private readonly refined = new Map<string, Refined>();
  private list: LiveObject[] = [];
  /** A lesson is under way: its declared objects are followed. */
  private active = false;

  constructor(private readonly deps: LiveTrackingDeps) {}

  attach(): () => void {
    const { bus } = this.deps;
    const offs = [
      bus.on('procedure.started', () => {
        this.phrases.clear();
        this.refined.clear();
        this.active = true;
        this.clear();
      }),
      // Every focus change enters a step: the next one, a skip, a refocus, a revised plan.
      bus.on('step.entered', ({ stepId }) => {
        this.stepId = stepId;
        this.focusItem = null;
        // Like the overlay's, a coach highlight belongs to the step it was made in.
        this.highlights.clear();
        this.rebuild();
      }),
      bus.on('overlay.highlight', ({ t, objectId, style, source }) => {
        if (source !== 'coach' || !this.deps.registry.spec(objectId)) return;
        // One next thing to touch at a time: a new target replaces the last.
        if (style === 'target') {
          for (const [id, h] of this.highlights)
            if (h.style === 'target') this.highlights.delete(id);
        }
        this.highlights.delete(objectId);
        this.highlights.set(objectId, {
          style,
          until: coachHighlightUntil(style, t) ?? Number.POSITIVE_INFINITY,
        });
        this.rebuild();
      }),
      // The action focus named the next thing to touch: lit for the rest of the step, until it
      // names another.
      bus.on('focus.answered', ({ stepId, actionId }) => {
        if (stepId !== this.stepId || !actionId || actionId === this.focusItem) return;
        if (!this.deps.registry.spec(actionId)) return;
        this.focusItem = actionId;
        this.rebuild();
      }),
      // A revision that keeps the focus (stage rest) may write an object's words again: the query
      // follows them, the phrase stays.
      bus.on('plan.ready', ({ revision }) => {
        if (revision) this.rebuild();
      }),
      // An object the coach or the action focus added is followed at once; an edit may reword.
      bus.on('plan.changed', () => this.rebuild()),
      bus.on('procedure.completed', () => this.end()),
      bus.on('procedure.aborted', () => this.end()),
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

  /**
   * ER's words for an object as it looks now: its query from now on, until the plan rewrites it
   * (a new step's show item, a revision that words the object again). The phrase stays, so the
   * tracker keeps its track.
   */
  refine(id: string, query: string): void {
    const words = query.trim();
    if (!words || !this.active || !this.deps.registry.spec(id)) return;
    const over = this.planWords(id);
    const before = this.refined.get(id);
    if (before?.query === words && before.over === over) return;
    this.refined.set(id, { query: words, over });
    this.rebuild();
  }

  /**
   * What to follow now: what the step lights in rank order, the action focus's item, highlighted
   * objects, then the plan's other objects (unlit, for the recording), while there is room.
   */
  get objects(): readonly LiveObject[] {
    return this.list;
  }

  get(id: string): LiveObject | undefined {
    return this.list.find((o) => o.id === id);
  }

  /** No step is focused: only the lesson's objects are followed, none lit. */
  private clear(): void {
    this.stepId = null;
    this.focusItem = null;
    this.highlights.clear();
    this.rebuild();
  }

  /** The lesson ended: nothing is followed. */
  private end(): void {
    this.active = false;
    this.refined.clear();
    this.clear();
  }

  private focusedStep(): Step | null {
    if (this.stepId === null) return null;
    return this.deps.procedure()?.steps.find((s) => s.id === this.stepId) ?? null;
  }

  private rebuild(): void {
    const { registry } = this.deps;
    const list: LiveObject[] = [];
    const add = (object: LiveObject) => {
      if (list.length < MAX_LIVE_OBJECTS && !list.some((o) => o.id === object.id)) {
        list.push(object);
      }
    };
    const styleOf = (id: string) => this.highlights.get(id)?.style ?? null;
    const step = this.focusedStep();
    let previous: number | null = null;
    for (const [rank, item] of (step?.show ?? []).entries()) {
      const role = item.role ?? inferRole(rank, registry.spec(item.object)?.kind);
      const base = roleAccent(role, previous);
      previous = base;
      const style = styleOf(item.object);
      add({
        id: item.object,
        phrase: this.phraseFor(item.object, item.phrase),
        query: this.words(item.object, item.description),
        rank,
        style,
        accent: styledAccent(base, style),
      });
    }
    // A step that shows nothing still lights what it is done with: what its action moves is what
    // to act on, and where it goes is the destination.
    if (step && step.show.length === 0) {
      for (const id of stepLights(step)) {
        const spec = registry.spec(id);
        if (!spec || !findable(spec)) continue;
        const rank = list.length;
        const role: HighlightRole =
          id === step.action?.object
            ? 'act'
            : id === step.action?.target
              ? 'destination'
              : inferRole(rank, spec.kind);
        const base = roleAccent(role, previous);
        previous = base;
        this.addLit(add, spec, rank, base, styleOf(id));
      }
    }
    const focus = this.focusItem === null ? undefined : registry.spec(this.focusItem);
    if (focus && findable(focus) && !list.some((o) => o.id === focus.id)) {
      this.addLit(add, focus, list.length, roleAccent('act', null), styleOf(focus.id));
    }
    for (const [id, { style }] of this.highlights) {
      const spec = registry.spec(id);
      if (!spec) continue;
      const followed = this.followed(spec);
      add({ ...followed, style, accent: styledAccent(followed.accent.color, style) });
    }
    if (this.active) {
      for (const spec of this.deps.procedure()?.objects ?? []) {
        if (findable(spec)) add(this.followed(spec));
      }
    }
    this.list = list;
  }

  /** A declared object the step or the action focus lights, outside any show item. */
  private addLit(
    add: (object: LiveObject) => void,
    spec: ObjectSpec,
    rank: number,
    base: number,
    style: HighlightStyle | null,
  ): void {
    add({ ...this.followed(spec), rank, style, accent: styledAccent(base, style) });
  }

  /** A declared object followed outside any show item: unlit, in the finder's words. */
  private followed(spec: ObjectSpec): LiveObject {
    return {
      id: spec.id,
      phrase: this.phraseFor(spec.id, this.firstShowPhrase(spec.id) ?? spec.label),
      query: this.words(spec.id, findWords(spec)),
      rank: null,
      style: null,
      accent: styledAccent(roleAccent(inferRole(0, spec.kind), null), null),
    };
  }

  /**
   * The words to follow `id` in: the action focus's, while the plan's words for it now are still
   * the ones they stood in for; once the plan words it again, the plan's (`plan`). Decided by the
   * object's own plan words, not the caller's: an object the step shows is also offered again
   * later in the rebuild, in its finder's words, and that duplicate must not drop ER's words.
   */
  private words(id: string, plan: string): string {
    const refined = this.refined.get(id);
    if (!refined) return plan;
    if (refined.over === this.planWords(id)) return refined.query;
    this.refined.delete(id);
    return plan;
  }

  /** The plan's words for `id` now: the focused step's show item, else the finder's words. */
  private planWords(id: string): string {
    const item = this.focusedStep()?.show.find((s) => s.object === id);
    if (item) return item.description;
    const spec = this.deps.registry.spec(id);
    return spec ? findWords(spec) : id;
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

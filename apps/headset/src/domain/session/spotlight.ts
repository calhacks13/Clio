import type { Step } from '@clio/protocol';
import type { Clock } from '../../core/clock';
import { sub } from '../../core/math';
import type { AppBus } from '../events';
import type { FindRequest, Grounder, GroundingResult } from '../world/grounding';
import type { ObjectRegistry } from '../world/object-registry';

// Spotlight: the lesson's use of the camera. It finds objects in the words of the moment (the
// current step's show items, else the object's own description), records every answer as an
// object.detected label, outlines what the current step shows, and keeps looking while the step
// runs so the outlines follow the real objects.

export interface SpotlightOptions {
  /** How long after an answer to look again at what the step shows (ms); 0 never refreshes. */
  refreshMs?: number;
}

export interface SpotlightDeps {
  bus: AppBus;
  clock: Clock;
  registry: ObjectRegistry;
  /** Null without a camera: nothing is looked for and every unplaced object stays missing. */
  grounder: Grounder | null;
  options?: SpotlightOptions;
}

/** A finder answers in 1 to 2 s; looking again 3 s after each answer keeps it busy about half the time. */
export const DEFAULT_SHOW_REFRESH_MS = 3000;

type Seen = Extract<GroundingResult, { ok: true }>;

export class Spotlight {
  private step: Step | null = null;
  /** Bumped on every step change, so answers for an older step are not outlined. */
  private generation = 0;
  private looking = 0;
  private nextLookT = Number.NEGATIVE_INFINITY;

  constructor(private readonly deps: SpotlightDeps) {}

  /**
   * A step started: look for what it shows and for its targets that have no position yet.
   * Resolves with the ids among those that still have no position.
   */
  enterStep(step: Step): Promise<string[]> {
    this.step = step;
    this.generation++;
    const { registry } = this.deps;
    return this.find([
      ...step.show.map((item) => ({ id: item.object })),
      ...step.targets.filter((id) => !registry.get(id)).map((id) => ({ id })),
    ]);
  }

  /**
   * Look for objects, in the current step's words for the ones it shows. Every answer is
   * recorded; the ones the step shows are outlined. Resolves with the ids still unplaced.
   */
  async find(requests: readonly FindRequest[]): Promise<string[]> {
    const { grounder, registry } = this.deps;
    const worded = this.inCurrentWords(requests);
    const unplaced = () => worded.map((r) => r.id).filter((id) => !registry.get(id));
    if (!grounder || worded.length === 0) return unplaced();
    const step = this.step;
    const generation = this.generation;
    this.looking++;
    let result: GroundingResult | null = null;
    try {
      result = await grounder.ground(worded);
    } catch {
      // A camera or network failure is a missed look; the next refresh tries again.
    } finally {
      this.looking--;
      this.nextLookT = this.deps.clock.now() + this.refreshMs;
    }
    if (result?.ok) this.report(result, step, generation === this.generation);
    return unplaced();
  }

  /** Per frame: look again at what the step shows, refreshMs after the last answer. */
  tick(t: number): Promise<string[]> | null {
    const step = this.step;
    if (!step || !this.deps.grounder || this.refreshMs <= 0) return null;
    if (this.looking > 0 || t < this.nextLookT) return null;
    // A held object rides with the hand; the camera would only see the hand around it.
    const requests = step.show
      .filter((item) => !this.deps.registry.get(item.object)?.heldBy)
      .map((item) => ({ id: item.object }));
    return requests.length > 0 ? this.find(requests) : null;
  }

  /** The lesson ended: stop looking, and leave answers still in flight unoutlined. */
  stop(): void {
    this.step = null;
    this.generation++;
  }

  private get refreshMs(): number {
    return this.deps.options?.refreshMs ?? DEFAULT_SHOW_REFRESH_MS;
  }

  /** One request per object, worded the way the current step shows it when it does. */
  private inCurrentWords(requests: readonly FindRequest[]): FindRequest[] {
    const shown = new Map<string, Step['show'][number]>();
    for (const item of this.step?.show ?? [])
      if (!shown.has(item.object)) shown.set(item.object, item);
    const seen = new Set<string>();
    return requests.flatMap((r) => {
      if (seen.has(r.id)) return [];
      seen.add(r.id);
      const item = shown.get(r.id);
      return [
        item && r.description === undefined
          ? { id: r.id, description: item.description, phrase: item.phrase }
          : r,
      ];
    });
  }

  private report(result: Seen, step: Step | null, current: boolean): void {
    const { bus, clock } = this.deps;
    const t = clock.now();
    const latencyMs = Math.max(0, t - result.frameT);
    for (const s of result.sightings) {
      const { found, point, box, outline, confidence } = s.detection;
      bus.emit('object.detected', {
        t,
        objectId: s.id,
        stepId: step?.id ?? null,
        phrase: s.phrase,
        description: s.description,
        found,
        point,
        box,
        outline,
        confidence,
        position: s.position,
        source: result.source,
        latencyMs,
      });
    }
    if (!current || !step) return;
    const { registry } = this.deps;
    for (const [rank, item] of step.show.entries()) {
      const sighting = result.sightings.find((s) => s.id === item.object);
      const estimate = registry.get(item.object);
      // In hand, the finder traced the hand around it; the next look after release redraws it.
      if (!sighting?.outline || !sighting.position || !estimate || estimate.heldBy) continue;
      bus.emit('overlay.outline', {
        t,
        objectId: item.object,
        outline: sighting.outline,
        offset: sub(sighting.position, estimate.position),
        rank,
        phrase: item.phrase,
      });
    }
  }
}

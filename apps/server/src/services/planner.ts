import type { ImagePayload, PlanStage, Procedure } from '@clio/protocol';

// The planner port: one model call that turns a goal (plus camera views) into plan JSON. The
// server validates, retries and stores the result (plan-service.ts); implementations only talk to
// the model. A parallel stage rest (plan-rest.ts) makes several such calls, each for one part.
// Tests use a scripted fake; production uses gemini-planner.ts. The step watcher's checks have a
// port of their own (step-check.ts).

export interface PlannerRequest {
  goal: string;
  context?: string;
  images: ImagePayload[];
  /**
   * Re-plan the rest of `base` from `fromStepIndex`, because of `reason`. The kept steps are done,
   * except those in `skippedStepIds`.
   */
  revision?: {
    reason: string;
    base: Procedure;
    fromStepIndex: number;
    skippedStepIds: readonly string[];
  };
  /**
   * full (the default): the whole plan. first: the first step in full and the rest as an outline,
   * quickly. rest: write the outline steps of `revision.base` in full while the learner works.
   */
  stage?: PlanStage;
  /** Stage rest written in parallel (plan-rest.ts): the part of it this call writes. */
  part?: RestPart;
  /** The previous answer failed validation: show it and the errors, and ask for a fix. */
  retry?: { previousText: string; errors: string };
  /** How long this call may take: what is left of the request's budget. */
  timeoutMs?: number;
}

/** A line of the checked outline of a parallel stage rest: one step to write in full. */
export interface RestLine {
  id: string;
  instruction: string;
  doneWhen?: string;
  /** The objects the step touches, shows or guards against. */
  uses: string[];
}

/** An object as a step writer is shown it: declared already, or new in the checked outline. */
export interface RestObject {
  id: string;
  label: string;
  look: string;
}

/**
 * review: check the outline of `revision.base` and say which new objects it needs. objects:
 * write the base plan's objects in full. step: write `lines[index]` in full, declaring the
 * objects in `declare`.
 */
export type RestPart =
  | { kind: 'review' }
  | { kind: 'objects' }
  | {
      kind: 'step';
      index: number;
      lines: RestLine[];
      objects: RestObject[];
      declare: string[];
      /** How the review read the scene, so every step agrees with it. */
      reading?: { done: string[]; control: string };
    };

export interface Planner {
  /** Recorded as origin.model on every plan it writes. */
  readonly model: string;
  /** Returns the model's raw JSON text: a new plan, or (for revisions) the remaining steps. */
  draft(request: PlannerRequest): Promise<string>;
}

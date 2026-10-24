import type { ImagePayload, Procedure } from '@clio/protocol';

// The planner port: one model call that turns a goal (plus camera views) into plan JSON. The
// server validates, retries and stores the result (plan-service.ts); implementations only talk to
// the model. Tests use a scripted fake; production uses gemini-planner.ts.

export interface PlannerRequest {
  goal: string;
  context?: string;
  images: ImagePayload[];
  /** Re-plan the rest of `base` from `fromStepIndex`, because of `reason`. */
  revision?: { reason: string; base: Procedure; fromStepIndex: number };
  /** The previous answer failed validation: show it and the errors, and ask for a fix. */
  retry?: { previousText: string; errors: string };
}

export interface Planner {
  /** Recorded as origin.model on every plan it writes. */
  readonly model: string;
  /** Returns the model's raw JSON text: a new plan, or (for revisions) the remaining steps. */
  draft(request: PlannerRequest): Promise<string>;
}

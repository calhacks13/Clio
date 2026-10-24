import { prettifyError, z } from 'zod';
import { CheckSchema, checkObjectRefs, SlugSchema } from './checks';
import { Vec3Schema } from './geometry';

export const PROCEDURE_SCHEMA_ID = 'clio.procedure/1';

export const ObjectPlacementSchema = z.discriminatedUnion('method', [
  z
    .object({
      method: z.literal('layout'),
      position: Vec3Schema.describe('Fixed position in the workspace frame (meters)'),
    })
    .describe('Placed automatically from the layout, e.g. a dot on a taped outline.'),
  z
    .object({
      method: z.literal('register'),
      prompt: z.string().optional().describe('e.g. "Touch the vinegar bottle and pinch"'),
    })
    .describe('The user registers it by pinching at it during setup.'),
]);

export const ObjectSpecSchema = z.object({
  id: SlugSchema,
  label: z.string().min(1).describe('Spoken and displayed name, e.g. "cup A"'),
  kind: z.enum(['point', 'item', 'container', 'tool', 'region']).default('item'),
  description: z.string().optional(),
  radius: z.number().positive().max(0.5).default(0.03).describe('Approximate size in meters'),
  placement: ObjectPlacementSchema,
});

export const MistakeRuleSchema = z.object({
  kind: SlugSchema.describe('Machine label, e.g. "wrong_cup"'),
  message: z.string().min(1).describe('The correction, e.g. "That is cup B. Vinegar goes in A."'),
  when: CheckSchema,
  cooldownMs: z.number().int().nonnegative().default(4000),
});

export const StepSchema = z.object({
  id: SlugSchema,
  instruction: z
    .string()
    .min(1)
    .max(200)
    .describe('Imperative sentence, spoken and shown. This is the language label for the step.'),
  detail: z.string().optional(),
  targets: z.array(SlugSchema).default([]),
  hand: z.enum(['left', 'right', 'either', 'both']).default('either'),
  success: CheckSchema,
  mistakes: z.array(MistakeRuleSchema).default([]),
  demo: z
    .object({ clipId: z.string() })
    .optional()
    .describe('Override the default clip id "<procedureId>/<stepId>"'),
  coachNotes: z.string().optional(),
  stuckAfterMs: z.number().int().positive().optional().describe('Nudge the coach after this long'),
});

const ProcedureObjectSchema = z.object({
  schema: z.literal(PROCEDURE_SCHEMA_ID),
  id: SlugSchema,
  version: z.number().int().positive(),
  title: z.string().min(1),
  summary: z.string().min(1),
  domain: z.string().optional(),
  workspace: z.object({
    size: z
      .tuple([z.number().positive(), z.number().positive()])
      .describe('[width along +x, depth along -z] in meters'),
    notes: z.string().optional(),
  }),
  objects: z.array(ObjectSpecSchema),
  steps: z.array(StepSchema).min(1),
  coach: z
    .object({
      persona: z.string().optional(),
      notes: z.string().optional(),
    })
    .default({}),
});

export const ProcedureSchema = ProcedureObjectSchema.superRefine((p, ctx) => {
  const objectIds = new Set<string>();
  p.objects.forEach((o, i) => {
    if (objectIds.has(o.id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['objects', i, 'id'],
        message: `Duplicate object id "${o.id}"`,
      });
    }
    objectIds.add(o.id);
  });

  const stepIds = new Set<string>();
  p.steps.forEach((step, i) => {
    if (stepIds.has(step.id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['steps', i, 'id'],
        message: `Duplicate step id "${step.id}"`,
      });
    }
    stepIds.add(step.id);

    const requireObject = (id: string, path: (string | number)[]): void => {
      if (!objectIds.has(id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['steps', i, ...path],
          message: `Unknown object "${id}"`,
        });
      }
    };
    for (const [j, id] of step.targets.entries()) requireObject(id, ['targets', j]);
    for (const id of checkObjectRefs(step.success)) requireObject(id, ['success']);
    for (const [j, rule] of step.mistakes.entries()) {
      for (const id of checkObjectRefs(rule.when)) requireObject(id, ['mistakes', j, 'when']);
    }
  });
});

export type ObjectPlacement = z.output<typeof ObjectPlacementSchema>;
export type ObjectSpec = z.output<typeof ObjectSpecSchema>;
export type MistakeRule = z.output<typeof MistakeRuleSchema>;
export type Step = z.output<typeof StepSchema>;
export type Procedure = z.output<typeof ProcedureSchema>;
export type ProcedureInput = z.input<typeof ProcedureSchema>;

export class ProcedureError extends Error {
  override name = 'ProcedureError';
}

/** Parses and validates a procedure (including cross-references). Throws a readable error. */
export function parseProcedure(input: unknown): Procedure {
  const r = safeParseProcedure(input);
  if (!r.ok) throw new ProcedureError(r.error);
  return r.procedure;
}

export function safeParseProcedure(
  input: unknown,
): { ok: true; procedure: Procedure } | { ok: false; error: string } {
  const r = ProcedureSchema.safeParse(input);
  return r.success ? { ok: true, procedure: r.data } : { ok: false, error: prettifyError(r.error) };
}

/** Default demo clip id for a step. */
export function clipIdFor(procedureId: string, stepId: string): string {
  return `${procedureId}/${stepId}`;
}

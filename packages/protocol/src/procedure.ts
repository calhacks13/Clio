import { prettifyError, z } from 'zod';
import { ActionSchema, actionObjectRefs } from './actions';
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
  z
    .object({
      method: z.literal('detect'),
      hint: z.string().optional().describe('Where to look, e.g. "front left of the engine bay"'),
    })
    .describe('Found by the camera from tracking.query (or the label); falls back to a pinch.'),
]);

export const MarkerSpecSchema = z
  .object({
    family: z.enum(['aruco_4x4_50', 'apriltag_36h11']).default('aruco_4x4_50'),
    id: z.number().int().nonnegative(),
    sizeM: z.number().positive().max(0.5).describe('Printed black-square edge length in meters'),
    offset: Vec3Schema.default([0, 0, 0]).describe(
      "The object's reference point in the marker frame (meters)",
    ),
  })
  .describe('A printed fiducial stuck to the object (or taped at the workspace origin).');

export const TrackingSpecSchema = z
  .object({
    marker: MarkerSpecSchema.optional(),
    query: z
      .string()
      .min(1)
      .optional()
      .describe('Open-vocabulary detector prompt, e.g. "white paper cup with a big letter A"'),
    moves: z
      .boolean()
      .default(false)
      .describe('Expected to move during the task, so it is tracked continuously'),
  })
  .describe('How the camera can find this object. Without it the object stays where placed.');

export const ObjectSpecSchema = z.object({
  id: SlugSchema,
  label: z.string().min(1).describe('Spoken and displayed name, e.g. "cup A"'),
  kind: z.enum(['point', 'item', 'container', 'tool', 'region']).default('item'),
  description: z.string().optional(),
  radius: z.number().positive().max(0.5).default(0.03).describe('Approximate size in meters'),
  hidden: z
    .boolean()
    .default(false)
    .describe('Not drawn; used only by checks (e.g. mistake zones)'),
  placement: ObjectPlacementSchema,
  tracking: TrackingSpecSchema.optional(),
});

export const MistakeRuleSchema = z.object({
  kind: SlugSchema.describe('Machine label, e.g. "wrong_cup"'),
  message: z.string().min(1).describe('The correction, e.g. "That is cup B. Vinegar goes in A."'),
  when: CheckSchema,
  cooldownMs: z.number().int().nonnegative().default(4000),
});

export const ShowItemSchema = z
  .object({
    object: SlugSchema.describe('The declared object this item outlines'),
    phrase: z
      .string()
      .min(1)
      .max(60)
      .describe('2-5 word noun phrase naming it, for category-style detectors: "blue washer cap"'),
    description: z
      .string()
      .min(1)
      .max(300)
      .describe(
        'Standalone visual description a vision model can find and outline in one camera frame: ' +
          'what it is, color, shape, size, text or symbols on it, and where it is now',
      ),
  })
  .describe('Something Clio finds with the camera and outlines for the learner during this step.');

export const StepSchema = z.object({
  id: SlugSchema,
  instruction: z
    .string()
    .min(1)
    .max(200)
    .describe('Imperative sentence, spoken and shown. This is the language label for the step.'),
  doneWhen: z
    .string()
    .min(3)
    .max(200)
    .optional()
    .describe(
      'The finished state as a camera or the learner would see it, e.g. "cup A has turned pink". ' +
        'The coach and the step watcher judge completion against it.',
    ),
  detail: z.string().optional(),
  targets: z.array(SlugSchema).default([]),
  hand: z.enum(['left', 'right', 'either', 'both']).default('either'),
  action: ActionSchema.optional().describe('What the hands do; drives the synthesized demo'),
  show: z
    .array(ShowItemSchema)
    .max(4)
    .default([])
    .describe('What to outline in AR during this step, most important first'),
  success: CheckSchema,
  mistakes: z.array(MistakeRuleSchema).default([]),
  demo: z
    .object({ clipId: z.string() })
    .optional()
    .describe('Override the default clip id "<procedureId>/<stepId>"'),
  coachNotes: z.string().optional(),
  stuckAfterMs: z.number().int().positive().optional().describe('Nudge the coach after this long'),
});

export const ProcedureOriginSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('curated') }).describe('Hand-written, in procedures/'),
  z
    .object({
      kind: z.literal('generated'),
      goal: z.string().min(1).describe('The learner\'s request, e.g. "add wiper fluid"'),
      model: z.string(),
      createdAt: z.iso.datetime(),
      revisionOf: z.string().optional().describe('Id of the plan this one revises'),
    })
    .describe('Written by the planner LLM at runtime'),
]);

const ProcedureObjectSchema = z.object({
  schema: z.literal(PROCEDURE_SCHEMA_ID),
  id: SlugSchema,
  version: z.number().int().positive(),
  origin: ProcedureOriginSchema.default({ kind: 'curated' }),
  title: z.string().min(1),
  summary: z.string().min(1),
  domain: z.string().optional(),
  workspace: z.object({
    size: z
      .tuple([z.number().positive(), z.number().positive()])
      .describe('[width along +x, depth along -z] in meters'),
    marker: MarkerSpecSchema.optional().describe(
      'Taped at the origin corner, axes aligned with the workspace; enables marker calibration',
    ),
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

  const markerOwners = new Map<string, string>();
  const claimMarker = (
    marker: MarkerSpec | undefined,
    owner: string,
    path: (string | number)[],
  ) => {
    if (!marker) return;
    const key = `${marker.family}:${marker.id}`;
    const other = markerOwners.get(key);
    if (other) {
      ctx.addIssue({
        code: 'custom',
        path,
        message: `Fiducial marker ${marker.id} is used by both "${other}" and "${owner}"`,
      });
    }
    markerOwners.set(key, owner);
  };
  claimMarker(p.workspace.marker, 'workspace', ['workspace', 'marker']);
  for (const [i, o] of p.objects.entries()) {
    claimMarker(o.tracking?.marker, o.id, ['objects', i, 'tracking', 'marker']);
  }

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
    if (step.action) for (const id of actionObjectRefs(step.action)) requireObject(id, ['action']);
    for (const [j, item] of step.show.entries()) requireObject(item.object, ['show', j, 'object']);
    for (const [j, rule] of step.mistakes.entries()) {
      for (const id of checkObjectRefs(rule.when)) requireObject(id, ['mistakes', j, 'when']);
    }
  });
});

export type MarkerSpec = z.output<typeof MarkerSpecSchema>;
export type TrackingSpec = z.output<typeof TrackingSpecSchema>;
export type ProcedureOrigin = z.output<typeof ProcedureOriginSchema>;
export type ObjectPlacement = z.output<typeof ObjectPlacementSchema>;
export type ObjectSpec = z.output<typeof ObjectSpecSchema>;
export type MistakeRule = z.output<typeof MistakeRuleSchema>;
export type ShowItem = z.output<typeof ShowItemSchema>;
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

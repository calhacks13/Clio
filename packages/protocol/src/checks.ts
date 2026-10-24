import { z } from 'zod';

// The check language used by step success conditions and mistake rules. Every leaf check is a
// *state* check ("is this true right now, for at least dwellMs?"), which makes checks composable
// (`all`, `any`) and tolerant of single-frame tracking dropouts. `sequence` latches each child in
// order. See docs/procedures.md for authoring guidance.

export const SlugSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, 'use a lowercase id: a-z, 0-9, "_" or "-"');

export const HandSelectorSchema = z.enum(['left', 'right', 'either']);
export const HandPointSchema = z.enum(['pinch', 'index_tip', 'thumb_tip', 'palm', 'wrist']);

export type HandSelector = z.infer<typeof HandSelectorSchema>;
export type HandPoint = z.infer<typeof HandPointSchema>;

const dwell = (ms: number) => z.number().int().nonnegative().default(ms);
const radius = (m: number) => z.number().positive().max(0.5).default(m);

export const PinchNearCheckSchema = z
  .object({
    type: z.literal('pinch_near'),
    object: SlugSchema,
    hand: HandSelectorSchema.default('either'),
    radius: radius(0.04),
    dwellMs: dwell(0),
  })
  .describe('The hand is pinching and its pinch point is within `radius` of the object.');

export const HandNearCheckSchema = z
  .object({
    type: z.literal('hand_near'),
    object: SlugSchema,
    hand: HandSelectorSchema.default('either'),
    point: HandPointSchema.default('pinch'),
    radius: radius(0.06),
    dwellMs: dwell(250),
  })
  .describe('A point on the hand stays within `radius` of the object for `dwellMs`.');

export const LiftCheckSchema = z
  .object({
    type: z.literal('lift'),
    hand: HandSelectorSchema.default('either'),
    point: HandPointSchema.default('wrist'),
    height: z.number().positive().max(1.5).default(0.15),
    dwellMs: dwell(200),
  })
  .describe('A point on the hand is at least `height` meters above the workspace surface.');

export const ObjectNearCheckSchema = z
  .object({
    type: z.literal('object_near'),
    object: SlugSchema.describe('The (usually tracked, moving) object'),
    target: SlugSchema.describe('Where it should be, e.g. a cup or a bottle'),
    radius: radius(0.06),
    dwellMs: dwell(500),
  })
  .describe("One object's reference point stays within `radius` of another's (needs tracking).");

export const ConfirmCheckSchema = z
  .object({
    type: z.literal('confirm'),
    by: z.enum(['coach', 'user', 'either']).default('either'),
    prompt: z.string().optional().describe('What must be verified, e.g. "cup A turned pink"'),
  })
  .describe('Satisfied when the coach or user confirms (advance_step), e.g. visual judgments.');

export const ElapsedCheckSchema = z
  .object({
    type: z.literal('elapsed'),
    ms: z.number().int().positive(),
  })
  .describe('Satisfied once the step has been active for `ms`.');

export type PinchNearCheck = z.output<typeof PinchNearCheckSchema>;
export type HandNearCheck = z.output<typeof HandNearCheckSchema>;
export type LiftCheck = z.output<typeof LiftCheckSchema>;
export type ObjectNearCheck = z.output<typeof ObjectNearCheckSchema>;
export type ConfirmCheck = z.output<typeof ConfirmCheckSchema>;
export type ElapsedCheck = z.output<typeof ElapsedCheckSchema>;
export type LeafCheck =
  | PinchNearCheck
  | HandNearCheck
  | LiftCheck
  | ObjectNearCheck
  | ConfirmCheck
  | ElapsedCheck;

export type CompositeCheck =
  | { type: 'all'; of: Check[] }
  | { type: 'any'; of: Check[] }
  | { type: 'sequence'; of: Check[] };
export type Check = LeafCheck | CompositeCheck;

type CompositeCheckInput =
  | { type: 'all'; of: CheckInput[] }
  | { type: 'any'; of: CheckInput[] }
  | { type: 'sequence'; of: CheckInput[] };
export type CheckInput =
  | z.input<typeof PinchNearCheckSchema>
  | z.input<typeof HandNearCheckSchema>
  | z.input<typeof LiftCheckSchema>
  | z.input<typeof ObjectNearCheckSchema>
  | z.input<typeof ConfirmCheckSchema>
  | z.input<typeof ElapsedCheckSchema>
  | CompositeCheckInput;

export const CheckSchema: z.ZodType<Check, CheckInput> = z
  .lazy(() =>
    z.discriminatedUnion('type', [
      PinchNearCheckSchema,
      HandNearCheckSchema,
      LiftCheckSchema,
      ObjectNearCheckSchema,
      ConfirmCheckSchema,
      ElapsedCheckSchema,
      AllCheckSchema,
      AnyCheckSchema,
      SequenceCheckSchema,
    ]),
  )
  .meta({ id: 'Check', description: 'A success condition or mistake trigger' });

const children = () => z.array(CheckSchema).min(1);
const AllCheckSchema = z
  .object({ type: z.literal('all'), of: children() })
  .describe('Every child is satisfied in the same frame.');
const AnyCheckSchema = z
  .object({ type: z.literal('any'), of: children() })
  .describe('At least one child is satisfied.');
const SequenceCheckSchema = z
  .object({ type: z.literal('sequence'), of: children() })
  .describe('Children are satisfied in order; each one latches once it passes.');

export const CHECK_TYPES = [
  'pinch_near',
  'hand_near',
  'lift',
  'object_near',
  'confirm',
  'elapsed',
  'all',
  'any',
  'sequence',
] as const satisfies readonly Check['type'][];

/** Object ids referenced anywhere inside a check, in first-seen order, without duplicates. */
export function checkObjectRefs(check: Check): string[] {
  const seen = new Set<string>();
  const visit = (c: Check): void => {
    if ('object' in c) seen.add(c.object);
    if ('target' in c) seen.add(c.target);
    if ('of' in c) for (const child of c.of) visit(child);
  };
  visit(check);
  return [...seen];
}

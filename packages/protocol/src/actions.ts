import { z } from 'zod';
import { SlugSchema } from './checks';

// Action primitives: the structured "what the hands do" of a step. The planner (an LLM) picks one
// per step; the headset turns it into a demonstration (synthesized ghost hands, arrows, arcs), and
// the dataset stores it as a structured action label next to the instruction text.

type Arg = 'required' | 'optional' | 'none';

export const ACTION_VERBS = {
  point_at: {
    object: 'required',
    target: 'none',
    means: 'Indicate an object without touching it.',
  },
  touch: { object: 'required', target: 'none', means: 'Reach out and touch the object.' },
  pinch: { object: 'required', target: 'none', means: 'Pinch the object between thumb and index.' },
  grasp: { object: 'required', target: 'none', means: 'Close the whole hand around the object.' },
  pick_up: { object: 'required', target: 'none', means: 'Grasp the object and lift it.' },
  place: {
    object: 'required',
    target: 'required',
    means: 'Carry the held object to the target and set it down.',
  },
  pour: {
    object: 'required',
    target: 'required',
    means: 'Tilt the held container over the target until it pours.',
  },
  insert: {
    object: 'required',
    target: 'required',
    means: 'Push the held object into the target.',
  },
  twist: {
    object: 'required',
    target: 'none',
    means: 'Rotate the object (cap, knob) by `amount` turns in `direction` cw/ccw.',
  },
  press: { object: 'required', target: 'none', means: 'Push down on the object (button, latch).' },
  pull: {
    object: 'required',
    target: 'none',
    means: 'Pull the object out or toward you (dipstick, drawer).',
  },
  wipe: { object: 'required', target: 'none', means: 'Wipe back and forth across the surface.' },
  fold: {
    object: 'required',
    target: 'required',
    means: 'Carry a pinched point of cloth or paper over to the target point.',
  },
  lift: {
    object: 'optional',
    target: 'none',
    means: 'Raise the hands (and anything held) by `amount` meters.',
  },
  observe: {
    object: 'optional',
    target: 'none',
    means: 'Look at something and wait for a visible result.',
  },
  wait: { object: 'none', target: 'none', means: 'Wait `amount` seconds.' },
  other: { object: 'optional', target: 'optional', means: 'Anything else; describe it in `note`.' },
} as const satisfies Record<string, { object: Arg; target: Arg; means: string }>;

export type ActionVerb = keyof typeof ACTION_VERBS;
export const ACTION_VERB_NAMES = Object.keys(ACTION_VERBS) as [ActionVerb, ...ActionVerb[]];

export const ActionSchema = z
  .object({
    verb: z.enum(ACTION_VERB_NAMES),
    object: SlugSchema.optional().describe('The object acted on (held, touched, twisted, ...)'),
    target: SlugSchema.optional().describe('Destination or recipient (place, pour, insert, fold)'),
    hand: z.enum(['left', 'right', 'either', 'both']).default('either'),
    direction: z.enum(['cw', 'ccw', 'up', 'down', 'toward', 'away', 'left', 'right']).optional(),
    amount: z
      .number()
      .positive()
      .optional()
      .describe('Turns for twist, meters for lift or pull, seconds for wait'),
    note: z.string().optional(),
  })
  .superRefine((a, ctx) => {
    const spec = ACTION_VERBS[a.verb];
    for (const arg of ['object', 'target'] as const) {
      const rule = spec[arg];
      if (rule === 'required' && !a[arg]) {
        ctx.addIssue({
          code: 'custom',
          path: [arg],
          message: `"${a.verb}" needs a${arg === 'object' ? 'n' : ''} ${arg}`,
        });
      }
      if (rule === 'none' && a[arg]) {
        ctx.addIssue({ code: 'custom', path: [arg], message: `"${a.verb}" takes no ${arg}` });
      }
    }
  });

export type Action = z.output<typeof ActionSchema>;
export type ActionInput = z.input<typeof ActionSchema>;

/** Object ids an action references. */
export function actionObjectRefs(action: Action): string[] {
  return [action.object, action.target].filter((id): id is string => Boolean(id));
}

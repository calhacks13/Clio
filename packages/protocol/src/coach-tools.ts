import { prettifyError, z } from 'zod';

// The coach's tools, defined once. Each call is both a visible action and a timestamped label in
// the dataset. Descriptions are prompts: they tell the model when to use each tool. Arguments stay
// flat (no unions), and every tool answers at once: slow work reports back as an [app] message.
// The exception is marked `nonBlocking`: look_closer asks the smart model, which takes a second or
// two, and the voice keeps talking until its answer arrives as the call's result.

export const STEP_STATUS_CHANGES = ['current', 'skipped', 'todo'] as const;

export const COACH_TOOLS = {
  start_lesson: {
    description:
      'Start a hands-on lesson for what the user wants to do. Call it as soon as you know the ' +
      'goal; ask one short clarifying question first only if the goal is ambiguous. Pass ' +
      'template_id when one of the curated lessons in your instructions fits. It answers at once; ' +
      'the step plan arrives as an [app] message.',
    args: z.object({
      goal: z
        .string()
        .min(3)
        .max(300)
        .describe('What to do, in a short phrase, e.g. "refill windshield washer fluid"'),
      context: z.string().max(2000).optional().describe('Anything the user said about their setup'),
      template_id: z
        .string()
        .optional()
        .describe('A curated lesson id from your instructions, e.g. "ph-indicator"'),
    }),
  },
  revise_plan: {
    description:
      'Re-plan every step that is not done yet when reality differs a lot from the plan: missing ' +
      'tools, different objects, or another approach. For one or two steps, use add_step or ' +
      'update_step instead. It answers at once; the new plan arrives as an [app] message.',
    args: z.object({
      reason: z.string().min(1).describe('What is different, e.g. "no funnel available"'),
    }),
  },
  add_step: {
    description:
      'Add a step to the plan, at the end unless after_step_id says where. Write text as one ' +
      'short imperative sentence and done_when as the end state you will be able to see.',
    args: z.object({
      text: z.string().min(1).max(200).describe('e.g. "Unscrew the blue washer fluid cap."'),
      done_when: z
        .string()
        .min(3)
        .max(200)
        .describe('What it looks like once done, e.g. "the blue cap is off"'),
      after_step_id: z
        .string()
        .optional()
        .describe('Insert after this step; omit to add at the end'),
      objects: z
        .array(z.string())
        .max(4)
        .optional()
        .describe('Ids of the materials the step uses, from the plan'),
    }),
  },
  update_step: {
    description:
      'Change one step: reword it, keep a note about it, skip it (status "skipped": not needed or ' +
      'impossible), work on it now (status "current", which reopens a done step), or reopen it ' +
      '(status "todo"). Text and done_when can change only on steps that are not done, and a ' +
      'rewording must keep what the step does; to change that, skip it and add a new step.',
    args: z.object({
      step_id: z.string().min(1).describe('A step id from the plan'),
      text: z.string().min(1).max(200).optional().describe('The new instruction'),
      done_when: z.string().min(3).max(200).optional().describe('The new end state'),
      note: z
        .string()
        .max(200)
        .optional()
        .describe('A note to yourself about this step, e.g. "they are left-handed"'),
      status: z.enum(STEP_STATUS_CHANGES).optional(),
      reason: z.string().optional().describe('Why, e.g. "they have no funnel"'),
    }),
  },
  complete_step: {
    description:
      "Mark a step done: when you see the step's done-when state in the camera (evidence " +
      '"seen"), or when the user tells you they did it, including work off camera (evidence ' +
      '"heard"; use it whenever you know from their words rather than your eyes). Any step can ' +
      'be completed, in any order. Name the step by its id from the plan, and give the reason.',
    args: z.object({
      step_id: z.string().min(1).describe('The id of the step that is done, from the plan'),
      reason: z.string().min(1).describe('Why the step is done, e.g. "cup A turned pink"'),
      evidence: z.enum(['seen', 'heard']),
    }),
  },
  add_material: {
    description:
      'Add something the plan did not list, e.g. a funnel the user has. It returns the id to use ' +
      'in add_step objects.',
    args: z.object({
      label: z.string().min(1).max(40).describe('Short name, e.g. "funnel"'),
      look_for: z
        .string()
        .max(200)
        .optional()
        .describe(
          'What it looks like and exactly where, so a camera finds this one and nothing else, ' +
            'e.g. "small white plastic funnel on the fender, left of the blue cap"',
        ),
    }),
  },
  highlight: {
    description:
      'Visually emphasize one object for the user. Call it right before you mention an object. ' +
      'Use style "warning" for an object they should not touch.',
    args: z.object({
      object_id: z.string().min(1).describe('An object id from the procedure, e.g. "cup_a"'),
      style: z
        .enum(['target', 'attention', 'warning'])
        .default('target')
        .describe(
          'target: next thing to touch. attention: pulse to draw the eye. warning: wrong object.',
        ),
    }),
  },
  show_demo: {
    description:
      'Play a translucent "ghost hand" demonstration of a step, anchored to the real objects. ' +
      'Use it when the user hesitates, asks how, or repeats a mistake.',
    args: z.object({
      step_id: z.string().optional().describe('Defaults to the current step'),
    }),
  },
  flag_mistake: {
    description:
      'Record and display a correction when the user does something wrong. Keep the message short ' +
      'and actionable, then say it out loud.',
    args: z.object({
      kind: z.string().min(1).describe('Short machine label, e.g. "wrong_cup" or "pinch_too_low"'),
      message: z
        .string()
        .min(1)
        .describe('The correction, e.g. "Slide your left hand up to the dot"'),
    }),
  },
  look_closer: {
    description:
      'Ask the sharper vision model to look at the camera view now. Your own frames are small and ' +
      'blurry and miss small things, so always use it when they ask whether something is safe, ' +
      'which of several similar things is which, where something is, what went wrong, or how to ' +
      'hold or use something. It takes a second or two, so first say only "Let me take a closer ' +
      'look", then call it. Keep listening meanwhile: the answer arrives by itself ' +
      "as this call's result, and then you tell the learner in your own words. What it points out " +
      'is highlighted for the learner.',
    nonBlocking: true,
    args: z.object({
      question: z
        .string()
        .min(3)
        .max(300)
        .describe('One question about what the camera sees, e.g. "Which bottle is the vinegar?"'),
    }),
  },
} as const;

export type CoachToolName = keyof typeof COACH_TOOLS;
export type CoachToolArgs<N extends CoachToolName> = z.output<(typeof COACH_TOOLS)[N]['args']>;
export const COACH_TOOL_NAMES = Object.keys(COACH_TOOLS) as CoachToolName[];

/**
 * A tool the model keeps talking through (Gemini: NON_BLOCKING). It answers when its work is done,
 * not at once, and the model speaks the answer once it is idle.
 */
export function isNonBlockingTool(name: string): boolean {
  return isToolName(name) && 'nonBlocking' in COACH_TOOLS[name];
}

export type ParsedToolCall = {
  [N in CoachToolName]: { ok: true; name: N; args: CoachToolArgs<N> };
}[CoachToolName];

function isToolName(name: string): name is CoachToolName {
  return Object.hasOwn(COACH_TOOLS, name);
}

/** Validates model-supplied tool arguments. Never throws: errors go back to the model as text. */
export function parseToolArgs(
  name: string,
  args: unknown,
): ParsedToolCall | { ok: false; error: string } {
  if (!isToolName(name)) {
    return {
      ok: false,
      error: `Unknown tool "${name}". Available: ${COACH_TOOL_NAMES.join(', ')}`,
    };
  }
  const r = COACH_TOOLS[name].args.safeParse(args ?? {});
  if (!r.success)
    return { ok: false, error: `Invalid arguments for ${name}: ${prettifyError(r.error)}` };
  return { ok: true, name, args: r.data } as ParsedToolCall;
}

export interface ToolJsonSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

/** JSON Schema for a tool's parameters (input shape, so defaulted args are optional). */
export function toolParametersJsonSchema(name: CoachToolName): ToolJsonSchema {
  const { $schema: _ignored, ...schema } = z.toJSONSchema(COACH_TOOLS[name].args, {
    io: 'input',
    target: 'draft-2020-12',
  }) as ToolJsonSchema & { $schema?: string };
  return schema;
}

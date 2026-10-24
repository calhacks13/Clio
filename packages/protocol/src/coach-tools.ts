import { prettifyError, z } from 'zod';

// The coach's tools, defined once. Each call is both a visible action and a timestamped label in
// the dataset. Descriptions are prompts: they tell the model when to use each tool.

export const COACH_TOOLS = {
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
  advance_step: {
    description:
      'Move to the next step. The app advances by itself when it detects success; call this only ' +
      'for steps that need your judgment (for example a color change you can see) or when the user ' +
      'clearly finished. Always give the reason.',
    args: z.object({
      reason: z.string().min(1).describe('Why the step is done, e.g. "cup A turned pink"'),
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
} as const;

export type CoachToolName = keyof typeof COACH_TOOLS;
export type CoachToolArgs<N extends CoachToolName> = z.output<(typeof COACH_TOOLS)[N]['args']>;
export const COACH_TOOL_NAMES = Object.keys(COACH_TOOLS) as CoachToolName[];

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

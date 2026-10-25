import {
  type CoachToolArgs,
  type CoachToolName,
  parseToolArgs,
  type WidgetToolName,
} from '@clio/protocol';
import type { Clock } from '../../core/clock';
import type { AppBus } from '../events';
import type { ToolCall, ToolResult } from './agent';

export type ToolOutcome = { ok: true; result: unknown } | { ok: false; error: string };

/** Which call a handler is serving, so what it changes can be linked to the recorded call. */
export interface ToolCallInfo {
  callId: string;
}

type HandlersFor<Names extends CoachToolName> = {
  [N in Names]: (args: CoachToolArgs<N>, call: ToolCallInfo) => ToolOutcome | Promise<ToolOutcome>;
};

/** Tools the coach layer answers itself: look_closer asks the smart model, not the lesson. */
export type CoachOwnToolName = 'look_closer';
export type LessonToolName = Exclude<CoachToolName, CoachOwnToolName | WidgetToolName>;

/** The lesson's tools (LessonController.handlers()). */
export type ToolHandlers = HandlersFor<LessonToolName>;

/** The coach's own tools (CloserLook.handlers()). */
export type CoachOwnToolHandlers = HandlersFor<CoachOwnToolName>;

/** The widget tools (WidgetBoard.handlers(); docs/widgets.md). */
export type WidgetToolHandlers = HandlersFor<WidgetToolName>;

/** What a coach can do: every lesson tool, and its own and the widgets' where it has them. */
export type AvailableToolHandlers = ToolHandlers &
  Partial<CoachOwnToolHandlers> &
  Partial<WidgetToolHandlers>;

/**
 * Validates the model's tool calls and dispatches them. Never throws at the model: bad arguments
 * and handler failures come back as `{ ok: false }` results it can correct. Every call and result
 * is recorded, because coach actions are dataset labels.
 */
export class CoachToolbox {
  constructor(
    private readonly handlers: AvailableToolHandlers,
    private readonly bus: AppBus,
    private readonly clock: Clock,
  ) {}

  async handle(call: ToolCall): Promise<ToolResult> {
    this.bus.emit('coach.tool_call', {
      t: this.clock.now(),
      callId: call.id,
      name: call.name,
      args: call.args ?? {},
    });

    const parsed = parseToolArgs(call.name, call.args);
    let outcome: ToolOutcome;
    if (!parsed.ok) {
      outcome = { ok: false, error: parsed.error };
    } else {
      try {
        const handler = this.handlers[parsed.name] as
          | ((args: unknown, call: ToolCallInfo) => ToolOutcome | Promise<ToolOutcome>)
          | undefined;
        outcome = handler
          ? await handler(parsed.args, { callId: call.id })
          : { ok: false, error: `${parsed.name} is not available on this headset.` };
      } catch (err) {
        outcome = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }

    const result = outcome.ok ? outcome.result : { error: outcome.error };
    this.bus.emit('coach.tool_result', {
      t: this.clock.now(),
      callId: call.id,
      name: call.name,
      ok: outcome.ok,
      result,
    });
    return { id: call.id, name: call.name, ok: outcome.ok, result };
  }
}

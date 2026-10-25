import { COACH_TOOL_NAMES, isWidgetTool } from '@clio/protocol';
import type { CoachSessionDeps } from '../domain/coach/session';
import type {
  AvailableToolHandlers,
  CoachOwnToolHandlers,
  ToolHandlers,
} from '../domain/coach/toolbox';
import type { WidgetBoard } from '../domain/widgets/board';

// How a coach is given the widgets (docs/widgets.md): clio-app.ts passes its board, or none with
// ?widgets=0. The desk lab and the synthetic episodes have no board; they import this rather than
// clio-app.ts, which would bring in three and the XR adapters.

/** Every tool the coach can call: the lesson's, look_closer, and the widgets' unless ?widgets=0. */
export function coachHandlers(
  lesson: ToolHandlers,
  own: CoachOwnToolHandlers,
  widgets: WidgetBoard | null,
): AvailableToolHandlers {
  return { ...lesson, ...own, ...(widgets?.handlers() ?? {}) };
}

/**
 * What the coach session knows of the widgets: the board (for on_screen and the stuck nudge), or
 * with ?widgets=0 no widget tools at all, so the voice is not told about them either.
 */
export function coachWidgets(
  widgets: WidgetBoard | null,
): Pick<CoachSessionDeps, 'widgets' | 'tools'> {
  return widgets ? { widgets } : { tools: COACH_TOOL_NAMES.filter((n) => !isWidgetTool(n)) };
}

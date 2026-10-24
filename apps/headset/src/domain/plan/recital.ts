// The coach's view of the plan, and the short texts that keep the coach in sync with it: the
// recital (the whole plan, repeated after every change) and the briefing for one step. The app
// owns the plan; these are what the coach reads instead of remembering it.

export type StepStatus = 'todo' | 'done' | 'skipped';

/** What changed the plan, recorded with every change. */
export type PlanOp =
  | 'start'
  | 'add'
  | 'edit'
  | 'skip'
  | 'focus'
  | 'reopen'
  | 'complete'
  | 'revise'
  /** The outline of a two-stage plan, written in full while the learner did the first step. */
  | 'refine'
  | 'material';

export interface PlanStepView {
  id: string;
  instruction: string;
  doneWhen?: string;
  status: StepStatus;
  /** The coach's own note about this step. */
  note?: string;
  /** Labels of the materials the step uses. */
  uses: readonly string[];
  /** The step has a ghost-hand demonstration to show. */
  demo: boolean;
  /** Advice written with the plan (planner or curated lesson). */
  coachNotes?: string;
}

export interface PlanView {
  goal: string;
  title: string;
  /** Increases with every change. */
  rev: number;
  steps: readonly PlanStepView[];
  /** The step being worked on, or null when none is left. */
  focusId: string | null;
  materials: readonly { id: string; label: string }[];
}

const RECITAL_MAX = 1200;

const sentence = (text: string) => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

function stepLine(step: PlanStepView): string {
  const parts = [`${step.id}: ${sentence(step.instruction)}`];
  if (step.doneWhen) parts.push(`Done when: ${sentence(step.doneWhen)}`);
  if (step.note) parts.push(`Note: ${sentence(step.note)}`);
  return parts.join(' ');
}

/** Where the focus goes when the focused step is finished: the first other step still to do. */
function nextTodo(plan: PlanView): PlanStepView | null {
  return plan.steps.find((s) => s.status === 'todo' && s.id !== plan.focusId) ?? null;
}

/** The whole plan in a few lines, for tool results, briefings and the system instruction. */
export function recitePlan(plan: PlanView): string {
  const ids = (status: StepStatus) =>
    plan.steps.filter((s) => s.status === status && s.id !== plan.focusId).map((s) => s.id);
  const focus = plan.steps.find((s) => s.id === plan.focusId) ?? null;
  const next = nextTodo(plan);
  const later = ids('todo').filter((id) => id !== next?.id);
  const done = ids('done');
  const skipped = ids('skipped');
  const notes = plan.steps
    .filter((s) => s.note && s.id !== focus?.id && s.id !== next?.id)
    .map((s) => `${s.id}: ${s.note}`);
  const lines = [
    `Goal: ${plan.goal} (plan rev ${plan.rev})`,
    `Done: ${done.length ? done.join(', ') : 'none'}`,
    `Now: ${focus ? stepLine(focus) : 'nothing left to do'}`,
    ...(next ? [`Next: ${stepLine(next)}`] : []),
    ...(later.length ? [`Later: ${later.join(', ')}`] : []),
    ...(skipped.length ? [`Skipped: ${skipped.join(', ')}`] : []),
    ...(notes.length ? [`Notes: ${notes.join('; ')}`] : []),
    ...(plan.materials.length
      ? [`Materials: ${plan.materials.map((m) => `${m.id} (${m.label})`).join(', ')}`]
      : []),
  ];
  const text = lines.join('\n');
  return text.length <= RECITAL_MAX ? text : `${text.slice(0, RECITAL_MAX - 1)}…`;
}

/** Facts about one step for the coach to brief the learner from, e.g. after focus moves to it. */
export function briefStep(plan: PlanView, stepId: string): string {
  const step = plan.steps.find((s) => s.id === stepId);
  if (!step) return `Step "${stepId}" is not in the plan.`;
  const counted = plan.steps.filter((s) => s.status !== 'skipped');
  const done = counted.filter((s) => s.status === 'done').length;
  const next = nextTodo({ ...plan, focusId: step.id });
  return [
    `${done} of ${counted.length} done. Now ${step.id}: "${sentence(step.instruction)}"`,
    step.doneWhen ? `Done when: ${sentence(step.doneWhen)}` : '',
    step.uses.length ? `Uses: ${step.uses.join(', ')}.` : '',
    step.coachNotes ? `Notes: ${sentence(step.coachNotes)}` : '',
    step.note ? `Your note: ${sentence(step.note)}` : '',
    next ? `Next: ${sentence(next.instruction)}` : 'This is the last step.',
  ]
    .filter(Boolean)
    .join(' ');
}

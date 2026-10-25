import type {
  CautionWidget,
  ChecklistWidget,
  ChoicesWidget,
  ProgressWidget,
  TimerWidget,
  ValueWidget,
  Widget,
  WidgetKind,
} from '../../../domain/widgets/types';

// Every widget kind in every state as board records, for the desktop preview and the tests. Each
// fixture reads as named at its `t` (a running timer's digits, a done state's linger), so a
// preview frozen at that t draws the same pixels every time.

export type FixtureState = 'running' | 'done' | 'hover' | 'pressed' | 'chosen' | 'collapsed';

export const FIXTURE_STATES: readonly FixtureState[] = [
  'running',
  'done',
  'hover',
  'pressed',
  'chosen',
  'collapsed',
];

export interface WidgetFixture {
  /** A caption, e.g. "Timer, running". */
  name: string;
  kind: WidgetKind;
  state: FixtureState;
  widget: Widget;
  /** The frame time at which it reads as named. */
  t: number;
  /** A fingertip on item `index` (the hover and pressed fixtures). */
  touch?: { index: number; look: 'hover' | 'pressed' };
}

/** The preview's default frame time (?t=). */
export const FIXTURE_T = 1000;

const MIN = 60_000;

type Base = Pick<
  Widget,
  'rev' | 'createdT' | 'updatedT' | 'status' | 'doneT' | 'closeAt' | 'stepId' | 'scope' | 'leaving'
>;

function base(t: number, scope: Base['scope'] = 'step', age = 8000): Base {
  return {
    rev: 1,
    createdT: t - age,
    updatedT: t - age,
    status: 'active',
    doneT: null,
    closeAt: null,
    stepId: 'acid-to-a',
    scope,
    leaving: false,
  };
}

function done(t: number, at: number, linger: number): Pick<Base, 'status' | 'doneT' | 'closeAt'> {
  return { status: 'done', doneT: t - at, closeAt: t - at + linger };
}

export function timer(t: number, over: Partial<TimerWidget> & { left?: number } = {}): TimerWidget {
  const { left = 112_000, ...rest } = over;
  return {
    id: 'timer',
    seq: 1,
    kind: 'timer',
    ...base(t, 'lesson'),
    label: 'Glue sets',
    durationMs: 2 * MIN,
    endT: t + left,
    objectId: null,
    ...rest,
  };
}

export function progressWidget(t: number, over: Partial<ProgressWidget> = {}): ProgressWidget {
  return {
    id: 'progress',
    seq: 2,
    kind: 'progress',
    ...base(t),
    label: 'Screws out',
    value: 3,
    total: 4,
    unit: null,
    ...over,
  };
}

export function checklist(t: number, over: Partial<ChecklistWidget> = {}): ChecklistWidget {
  return {
    id: 'checklist',
    seq: 3,
    kind: 'checklist',
    ...base(t),
    title: 'Gather',
    items: [
      { text: 'Funnel', done: true },
      { text: 'Rag', done: false },
      { text: 'Washer fluid', done: false },
    ],
    ...over,
  };
}

export function choices(t: number, over: Partial<ChoicesWidget> = {}): ChoicesWidget {
  return {
    id: 'choices',
    seq: 4,
    kind: 'choices',
    ...base(t, 'step', 3000),
    question: 'Which screwdriver do you have?',
    options: ['Phillips', 'Flat'],
    chosen: null,
    chosenVia: null,
    expiresT: t + 87_000,
    ...over,
  };
}

export function value(t: number, over: Partial<ValueWidget> = {}): ValueWidget {
  return {
    id: 'value',
    seq: 5,
    kind: 'value',
    ...base(t),
    label: 'Torque',
    value: '25 N m',
    ...over,
  };
}

export function caution(t: number, over: Partial<CautionWidget> = {}): CautionWidget {
  return {
    id: 'caution',
    seq: 6,
    kind: 'caution',
    ...base(t, 'lesson'),
    text: 'The pan stays hot for 10 minutes',
    ...over,
  };
}

/** Every kind in every state it has, as of t. */
export function widgetFixtures(t: number = FIXTURE_T): WidgetFixture[] {
  const f = (
    name: string,
    state: FixtureState,
    widget: Widget,
    touch?: WidgetFixture['touch'],
  ): WidgetFixture => ({ name, kind: widget.kind, state, widget, t, ...(touch ? { touch } : {}) });
  const fiveItems = [
    { text: 'Gloves on', done: true },
    { text: 'Goggles on', done: true },
    { text: 'Power off at the wall', done: false },
    { text: 'Cap off', done: false },
    { text: 'Rag ready', done: false },
  ];
  const allDone = [
    { text: 'Funnel', done: true },
    { text: 'Rag', done: true },
    { text: 'Washer fluid', done: true },
  ];
  return [
    f('Timer, running', 'running', timer(t, { objectId: 'cup_a' })),
    f(
      'Timer, two-line label',
      'running',
      timer(t, {
        id: 'timer-2',
        seq: 7,
        label: 'Colour develops',
        durationMs: 5 * MIN,
        left: 254_000,
      }),
    ),
    f(
      'Timer, done',
      'done',
      timer(t, { label: 'Tea steeps', durationMs: 3 * MIN, left: -2000, ...done(t, 2000, 10_000) }),
    ),
    f('Timer, collapsed', 'collapsed', timer(t)),
    f(
      'Timer, collapsed and done',
      'collapsed',
      timer(t, { label: 'Tea steeps', left: -2000, ...done(t, 2000, 10_000) }),
    ),
    f('Progress, segmented', 'running', progressWidget(t)),
    f(
      'Progress, amount',
      'running',
      progressWidget(t, { label: 'Poured', value: 120, total: 250, unit: 'mL' }),
    ),
    f(
      'Progress, long amount',
      'running',
      progressWidget(t, { label: 'Flour weighed', value: 750, total: 1000, unit: 'grams' }),
    ),
    f(
      'Progress, widest amount',
      'running',
      progressWidget(t, { label: 'Gravel spread', value: 1250, total: 2500, unit: 'kilogram' }),
    ),
    f('Progress, done', 'done', progressWidget(t, { value: 4, ...done(t, 600, 4000) })),
    f('Progress, collapsed', 'collapsed', progressWidget(t)),
    f(
      'Progress, collapsed amount',
      'collapsed',
      progressWidget(t, { label: 'Flour weighed', value: 750, total: 1000, unit: 'grams' }),
    ),
    f('Checklist, running', 'running', checklist(t)),
    f('Checklist, hover', 'hover', checklist(t), { index: 1, look: 'hover' }),
    f('Checklist, pressed', 'pressed', checklist(t), { index: 1, look: 'pressed' }),
    f('Checklist, five items', 'running', checklist(t, { title: 'Get ready', items: fiveItems })),
    f('Checklist, all done', 'done', checklist(t, { items: allDone, ...done(t, 600, 4000) })),
    f('Checklist, collapsed', 'collapsed', checklist(t)),
    f('Choices, two answers', 'running', choices(t)),
    f(
      'Choices, two columns',
      'running',
      choices(t, { question: 'Is the cap off?', options: ['Yes', 'No'] }),
    ),
    f(
      'Choices, chosen pair',
      'chosen',
      choices(t, {
        question: 'Is the cap off?',
        options: ['Yes', 'No'],
        chosen: 0,
        chosenVia: 'voice',
        ...done(t, 600, 1500),
      }),
    ),
    f(
      'Choices, three answers',
      'running',
      choices(t, {
        question: 'Is the power off at the wall yet?',
        options: ["Yes, it's off", 'Not yet', "Can't find it"],
      }),
    ),
    f('Choices, hover', 'hover', choices(t), { index: 0, look: 'hover' }),
    f('Choices, pressed', 'pressed', choices(t), { index: 1, look: 'pressed' }),
    f(
      'Choices, chosen',
      'chosen',
      choices(t, { chosen: 0, chosenVia: 'touch', ...done(t, 600, 1500) }),
    ),
    f('Value', 'running', value(t)),
    f('Value, long', 'running', value(t, { label: 'Reading at cup B', value: '1,250.5 kPa' })),
    f('Value, collapsed', 'collapsed', value(t)),
    f('Caution', 'running', caution(t)),
    f(
      'Caution, long',
      'running',
      caution(t, {
        text: 'Never put your hand under the mower deck while it is running',
      }),
    ),
  ];
}

/** The fixtures in `state` ('all' for every one), of the given kinds (all when empty). */
export function selectFixtures(
  fixtures: readonly WidgetFixture[],
  state: FixtureState | 'all',
  kinds: readonly WidgetKind[] = [],
): WidgetFixture[] {
  return fixtures.filter(
    (f) => (state === 'all' || f.state === state) && (kinds.length === 0 || kinds.includes(f.kind)),
  );
}

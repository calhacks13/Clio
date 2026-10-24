import {
  type HealthResponse,
  type Procedure,
  type ProcedureSummary,
  parseProcedure,
} from '@clio/protocol';
import phIndicatorJson from '../../../../procedures/ph-indicator.json';
import shirtFoldJson from '../../../../procedures/shirt-fold.json';
import type { PresentContext } from '../adapters/render/presenter';
import { type BootModel, type BootProgress, setBootProgress } from '../app/boot-view';
import type { OverlaySnapshot } from '../domain/overlay/overlay-model';

// Every state the UI gallery (gallery.html) shows, as data: a new state is one entry. Lesson text
// comes from the curated lessons in procedures/, so the gallery shows what a learner reads.

export const PH_INDICATOR: Procedure = parseProcedure(phIndicatorJson);
export const SHIRT_FOLD: Procedure = parseProcedure(shirtFoldJson);

// ---- launch page ---------------------------------------------------------------------------------

export interface LaunchState {
  name: string;
  model: BootModel;
  /** Runs on the frame's #app element once the markup is in, e.g. to show the button's progress. */
  after?: (root: HTMLElement) => void;
  /** Also shown at phone width. */
  phone?: boolean;
}

const HEALTH: HealthResponse = {
  ok: true,
  version: '0.1.0',
  coach: { configured: true, liveModel: 'gemini-3.8-live', relayPath: '/gemini' },
};

const curated = (p: Procedure): ProcedureSummary => ({
  id: p.id,
  version: p.version,
  title: p.title,
  summary: p.summary,
  stepCount: p.steps.length,
  source: 'curated',
});

export const SAVED_LESSONS: ProcedureSummary[] = [
  curated(PH_INDICATOR),
  curated(SHIRT_FOLD),
  {
    id: 'refill-the-windshield-washer-fluid',
    version: 1,
    title: 'Refill the windshield washer fluid',
    summary: 'Find the washer reservoir under the hood and top it up to the line.',
    stepCount: 4,
    source: 'generated',
  },
];

const READY: BootModel = { health: HEALTH, procedures: SAVED_LESSONS, ar: true, goal: '' };

/** The button narrating its own progress, as boot() drives it. */
function progressState(name: string, progress: BootProgress, phone = false): LaunchState {
  return { name, model: READY, after: (root) => setBootProgress(root, progress), phone };
}

export const LAUNCH_STATES: LaunchState[] = [
  { name: 'Ready with saved lessons', model: READY, phone: true },
  { name: 'Goal prefilled', model: { ...READY, goal: 'refill the windshield washer fluid' } },
  { name: 'No saved lessons', model: { ...READY, procedures: [] } },
  { name: 'Server unreachable', model: { ...READY, health: null, procedures: [] }, phone: true },
  {
    name: 'No Gemini key',
    model: { ...READY, health: { ...HEALTH, coach: { ...HEALTH.coach, configured: false } } },
  },
  { name: 'No passthrough AR', model: { ...READY, ar: false } },
  { name: 'Saved lesson chosen', model: { ...READY, procedureId: PH_INDICATOR.id } },
  { name: 'Recording demonstrations', model: { ...READY, record: true } },
  progressState('Asking for microphone and camera', { kind: 'permissions' }),
  progressState('Entering AR', { kind: 'entering' }),
  progressState('In AR', { kind: 'inside' }),
  progressState('Could not start', { kind: 'error', message: 'Permission denied' }, true),
];

// ---- in-headset instruction panel ----------------------------------------------------------------

export interface PanelState {
  name: string;
  snapshot: OverlaySnapshot;
  calibration?: PresentContext['calibration'];
}

const QUIET: OverlaySnapshot = {
  phase: 'idle',
  title: null,
  instruction: null,
  highlights: [],
  outlines: [],
  toast: null,
  demoStepId: null,
  caption: null,
  coach: 'ready',
  voice: 'quiet',
  recording: null,
  missing: [],
};

function stepOf(procedure: Procedure, index: number) {
  const step = procedure.steps[index];
  if (!step) throw new Error(`${procedure.id} has no step ${index + 1}`);
  return step;
}

/** The panel during a lesson, on step `index` (0-based; it also counts the steps done). */
function lessonStep(
  procedure: Procedure,
  index: number,
  more: Partial<OverlaySnapshot> = {},
  extra: { progress?: number; detail?: string } = {},
): OverlaySnapshot {
  const step = stepOf(procedure, index);
  const detail = extra.detail ?? step.detail;
  return {
    ...QUIET,
    phase: 'lesson',
    title: procedure.title,
    instruction: {
      text: step.instruction,
      ...(detail ? { detail } : {}),
      index,
      total: procedure.steps.length,
      progress: extra.progress ?? 0,
    },
    highlights: step.targets.map((objectId) => ({
      objectId,
      style: 'target' as const,
      source: 'auto' as const,
      until: null,
    })),
    ...more,
  };
}

const ph = PH_INDICATOR;
const wrongCup = stepOf(ph, 2).mistakes[0]?.message ?? '';
const syringeTip = stepOf(ph, 0).coachNotes ?? '';

export const PANEL_STATES: PanelState[] = [
  { name: 'Idle, listening', snapshot: QUIET },
  {
    name: 'Learner talking',
    snapshot: {
      ...QUIET,
      voice: 'hearing',
      caption: { role: 'user', text: 'I want to test an acid and a base with cabbage juice.' },
    },
  },
  { name: 'Planning', snapshot: { ...QUIET, phase: 'planning' } },
  {
    name: 'Clio speaking',
    snapshot: lessonStep(ph, 0, {
      voice: 'speaking',
      caption: { role: 'coach', text: syringeTip },
    }),
  },
  { name: 'Connecting', snapshot: { ...QUIET, coach: 'connecting' } },
  { name: 'Reconnecting', snapshot: lessonStep(ph, 2, { coach: 'reconnecting' }) },
  { name: 'Voice offline', snapshot: lessonStep(ph, 2, { coach: 'error' }) },
  { name: 'Offline scripted coach', snapshot: lessonStep(ph, 0, { coach: 'off' }) },
  {
    name: 'Step 2 of 5 with progress and detail',
    // The curated step has no detail; this one is written for the gallery.
    snapshot: lessonStep(
      ph,
      1,
      {},
      { progress: 0.4, detail: 'A few drops in each cup is enough.' },
    ),
  },
  { name: 'Long detail', snapshot: lessonStep(SHIRT_FOLD, 3, {}, { progress: 0.7 }) },
  { name: 'Objects missing', snapshot: lessonStep(ph, 0, { missing: ['indicator', 'syringe'] }) },
  {
    name: 'Mistake',
    snapshot: lessonStep(ph, 2, { toast: { kind: 'mistake', text: wrongCup } }, { progress: 0.3 }),
  },
  { name: 'Step done', snapshot: lessonStep(ph, 3, { toast: { kind: 'success', text: 'Nice!' } }) },
  {
    name: 'Table calibration',
    snapshot: { ...QUIET, coach: 'off' },
    calibration: {
      step: 'first',
      text: 'Pinch the near-left corner of your work area.',
      error: null,
      firstCorner: null,
    },
  },
  {
    name: 'Table calibration error',
    snapshot: { ...QUIET, coach: 'off' },
    calibration: {
      step: 'second',
      text: 'Now pinch the near-right corner.',
      error: 'Calibration corners are too close together (need at least 10 cm)',
      firstCorner: [0, 0.75, -0.4],
    },
  },
  { name: 'Looking for the objects', snapshot: { ...QUIET, phase: 'locating', title: ph.title } },
  {
    name: 'Lesson complete',
    snapshot: { ...QUIET, phase: 'done', toast: { kind: 'success', text: 'Lesson complete!' } },
  },
  { name: 'Something went wrong', snapshot: { ...QUIET, phase: 'failed' } },
];

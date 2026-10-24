import {
  type Procedure,
  parseProcedure,
  type SceneAskRequest,
  type SceneAskResponse,
} from '@clio/protocol';
import { describe, expect, it } from 'vitest';
import { ManualClock } from '../../src/core/clock';
import { Emitter } from '../../src/core/emitter';
import type { LessonView } from '../../src/domain/coach/ports';
import type { AppEvents } from '../../src/domain/events';
import type { PlanView } from '../../src/domain/plan/recital';
import { CloserLook } from '../../src/domain/session/closer-look';
import type { CameraModel } from '../../src/domain/world/camera-model';
import { type CameraFrame, ObjectGrounder } from '../../src/domain/world/grounding';
import { ObjectRegistry } from '../../src/domain/world/object-registry';
import { PoseHistory } from '../../src/domain/world/pose-history';
import { Workspace } from '../../src/domain/world/workspace';

// look_closer: the voice coach asks the smart model about a fresh frame. The answer comes back in
// words; what it points out is placed and highlighted for the learner, and the coach only hears
// which things are highlighted.

const procedure: Procedure = parseProcedure({
  schema: 'clio.procedure/1',
  id: 'ph',
  version: 1,
  title: 'pH test',
  summary: 'S',
  workspace: { size: [1, 1] },
  objects: [
    {
      id: 'cup_c',
      label: 'cup C',
      placement: { method: 'detect' },
      tracking: { query: 'clear cup with a big letter C' },
    },
    { id: 'vinegar', label: 'vinegar bottle', placement: { method: 'detect' } },
  ],
  steps: [
    { id: 'base', instruction: 'Add baking soda to cup C.', success: { type: 'elapsed', ms: 10 } },
  ],
});

const plan: PlanView = {
  goal: 'Test an acid and a base with red-cabbage indicator',
  title: 'pH test',
  rev: 1,
  focusId: 'base',
  materials: [
    { id: 'cup_c', label: 'cup C' },
    { id: 'vinegar', label: 'vinegar bottle' },
  ],
  steps: [
    {
      id: 'base',
      instruction: 'Add baking soda to cup C.',
      doneWhen: 'cup C has turned blue-green',
      status: 'todo',
      uses: ['cup C'],
      demo: false,
    },
  ],
};

const model: CameraModel = {
  intrinsics: { width: 1280, height: 720, fx: 800, fy: 800, cx: 640, cy: 360 },
  headFromCamera: { p: [0, 0, 0], q: [0, 0, 0, 1] },
};

const FRAME: CameraFrame = { t: 100, width: 1280, height: 720, jpegBase64: 'JPEG' };

const KNIFE = { label: 'kitchen knife', objectId: null, point: [0.2, 0.4] as const, box: null };

const answer = (over: Partial<SceneAskResponse> = {}): SceneAskResponse => ({
  hazard: null,
  answer: 'Cup C, the one on the right, is still empty.',
  refs: [
    {
      label: 'cup C',
      objectId: 'cup_c',
      point: [0.5, 560 / 720],
      box: [0.45, 0.7, 0.55, 600 / 720],
    },
    { ...KNIFE, point: [...KNIFE.point] },
  ],
  model: 'gemini-robotics-er-2-preview',
  latencyMs: 1400,
  ...over,
});

function setup({
  reply = async () => answer(),
  lesson = true,
  camera = true,
  frame = FRAME as CameraFrame | null,
}: {
  reply?: () => Promise<SceneAskResponse>;
  lesson?: boolean;
  camera?: boolean;
  frame?: CameraFrame | null;
} = {}) {
  const bus = new Emitter<AppEvents>();
  const seen: { type: string; payload: Record<string, unknown> }[] = [];
  bus.onAny((type, payload) =>
    seen.push({ type: String(type), payload: payload as Record<string, unknown> }),
  );
  const registry = new ObjectRegistry(bus);
  registry.load(procedure.objects, 0);
  const poses = new PoseHistory(16);
  poses.push(90, { p: [0, 0.3, 0], q: [0, 0, 0, 1] });
  poses.push(110, { p: [0, 0.3, 0], q: [0, 0, 0, 1] });
  const widths: (number | undefined)[] = [];
  const source = {
    model: () => model,
    capture: async (maxWidth?: number) => {
      widths.push(maxWidth);
      return frame;
    },
  };
  const grounder = new ObjectGrounder({
    camera: source,
    locator: { locate: async () => ({ detections: [], model: 'unused' }) },
    registry,
    poses,
    workspace: () => new Workspace({ p: [0, 0, 0], q: [0, 0, 0, 1] }),
  });
  const asked: SceneAskRequest[] = [];
  const view: LessonView = {
    procedure: () => (lesson ? procedure : null),
    label: (id) => registry.spec(id)?.label ?? id,
    plan: () => (lesson ? plan : null),
  };
  const look = new CloserLook({
    camera: camera ? source : null,
    asker: {
      ask: async (request) => {
        asked.push(request);
        return reply();
      },
    },
    view,
    bus,
    clock: new ManualClock(1600),
    placer: grounder,
  });
  const call = (question: string) => look.handlers().look_closer({ question }, { callId: 'c1' });
  return { call, asked, widths, seen, registry };
}

describe('CloserLook', () => {
  it('asks the smart model about a fresh 1024 px frame, with the goal, the step and the materials', async () => {
    const { call, asked, widths } = setup();
    await call('Which cup is still empty?');
    expect(widths).toEqual([1024]);
    expect(asked).toEqual([
      {
        question: 'Which cup is still empty?',
        goal: 'Test an acid and a base with red-cabbage indicator',
        step: { instruction: 'Add baking soda to cup C.', doneWhen: 'cup C has turned blue-green' },
        objects: [
          { id: 'cup_c', label: 'cup C', look: 'clear cup with a big letter C' },
          { id: 'vinegar', label: 'vinegar bottle' },
        ],
        images: [{ mimeType: 'image/jpeg', data: 'JPEG' }],
      },
    ]);
  });

  it('asks only the question when no lesson is running', async () => {
    const { call, asked } = setup({ lesson: false });
    await call('What is this?');
    expect(asked).toEqual([
      { question: 'What is this?', images: [{ mimeType: 'image/jpeg', data: 'JPEG' }] },
    ]);
  });

  it('answers the coach in words, naming what it highlighted but never where it is', async () => {
    const { call } = setup();
    const outcome = await call('Which cup is still empty?');
    expect(outcome).toEqual({
      ok: true,
      result: { answer: 'Cup C, the one on the right, is still empty.', highlighted: ['cup C'] },
    });
    expect(JSON.stringify(outcome)).not.toMatch(/\d\.\d|point|box/);
  });

  it("places and highlights the lesson's objects it points out, from the frame it saw", async () => {
    const { call, seen, registry } = setup();
    await call('Which cup is still empty?');
    expect(registry.get('cup_c')?.source).toBe('detector');
    expect(registry.get('cup_c')?.position[2]).toBeCloseTo(-1);
    const of = (type: string) => seen.filter((e) => e.type === type).map((e) => e.payload);
    expect(of('overlay.highlight')).toEqual([
      { t: 1600, objectId: 'cup_c', style: 'attention', source: 'coach' },
    ]);
    expect(of('object.detected')).toEqual([
      expect.objectContaining({
        objectId: 'cup_c',
        stepId: 'base',
        phrase: 'cup C',
        description: 'Which cup is still empty?',
        found: true,
        source: 'gemini-robotics-er-2-preview',
        latencyMs: 1500,
      }),
    ]);
    // Everything it pointed out is recorded, the knife too.
    expect(of('annotation')).toEqual([
      {
        t: 1600,
        label: 'coach.look_closer',
        data: {
          callId: 'c1',
          model: 'gemini-robotics-er-2-preview',
          latencyMs: 1400,
          refs: answer().refs,
        },
      },
    ]);
  });

  it('passes a hazard on to the coach in words', async () => {
    const { call } = setup({
      reply: async () => answer({ hazard: 'a knife over cups A and B' }),
    });
    expect(await call('Is it safe to work here?')).toEqual({
      ok: true,
      result: {
        hazard: 'a knife over cups A and B',
        answer: 'Cup C, the one on the right, is still empty.',
        highlighted: ['cup C'],
      },
    });
  });

  it('highlights nothing when the answer points at nothing in the lesson', async () => {
    const { call, seen } = setup({
      reply: async () =>
        answer({
          answer: 'There is a knife by your hand.',
          refs: [{ ...KNIFE, point: [...KNIFE.point] }],
        }),
    });
    expect(await call('Is this safe?')).toEqual({
      ok: true,
      result: { answer: 'There is a knife by your hand.' },
    });
    expect(seen.filter((e) => e.type === 'overlay.highlight')).toEqual([]);
  });

  it('says why there is no answer: no camera, no picture, or the smart model failed', async () => {
    expect(await setup({ camera: false }).call('Which?')).toEqual({
      ok: false,
      error: 'The headset has no camera. Ask them to describe it.',
    });
    expect(await setup({ frame: null }).call('Which?')).toEqual({
      ok: false,
      error: 'The camera has no picture right now. Ask them to describe it.',
    });
    const failing = setup({
      reply: async () => {
        throw new Error('Closer look failed: Gemini did not answer within 8 s');
      },
    });
    expect(await failing.call('Which?')).toEqual({
      ok: false,
      error: 'No closer look this time (Closer look failed: Gemini did not answer within 8 s).',
    });
  });
});

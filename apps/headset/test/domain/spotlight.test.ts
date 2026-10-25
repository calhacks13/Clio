import { parseProcedure, type Step } from '@clio/protocol';
import { describe, expect, it } from 'vitest';
import { ManualClock } from '../../src/core/clock';
import { Emitter } from '../../src/core/emitter';
import type { AppEvents } from '../../src/domain/events';
import { Spotlight } from '../../src/domain/session/spotlight';
import type { CameraModel } from '../../src/domain/world/camera-model';
import {
  type FindRequest,
  type Grounder,
  type GroundingResult,
  ObjectGrounder,
} from '../../src/domain/world/grounding';
import { ObjectRegistry } from '../../src/domain/world/object-registry';
import type { ObjectOutline } from '../../src/domain/world/outline';
import { PoseHistory } from '../../src/domain/world/pose-history';
import { Workspace } from '../../src/domain/world/workspace';

const procedure = parseProcedure({
  schema: 'clio.procedure/1',
  id: 'washer',
  version: 1,
  title: 'Refill',
  summary: 'S',
  workspace: { size: [1, 1] },
  objects: [
    {
      id: 'cap',
      label: 'washer cap',
      placement: { method: 'detect' },
      tracking: { query: 'blue cap' },
    },
    {
      id: 'jug',
      label: 'fluid jug',
      kind: 'container',
      placement: { method: 'detect' },
      tracking: { query: 'blue jug', moves: true },
    },
    { id: 'rag', label: 'rag', placement: { method: 'detect' } },
    { id: 'mug', label: 'mug', placement: { method: 'layout', position: [0.15, 0.05, -0.3] } },
  ],
  steps: [
    {
      id: 'open',
      instruction: 'Open the cap.',
      targets: ['cap', 'rag'],
      show: [
        {
          object: 'cap',
          phrase: 'blue washer cap',
          description: 'Round blue cap with a windshield symbol, front left',
        },
      ],
      success: { type: 'confirm' },
    },
    {
      id: 'pour',
      instruction: 'Pour.',
      targets: ['jug', 'cap'],
      show: [
        { object: 'jug', phrase: 'fluid jug', description: 'Blue jug in your hand' },
        {
          object: 'cap',
          phrase: 'open reservoir',
          description: 'The open reservoir neck where the cap was',
        },
      ],
      success: { type: 'confirm' },
    },
    { id: 'done', instruction: 'Say done.', success: { type: 'confirm' } },
    {
      id: 'rinse',
      instruction: 'Rinse the mug.',
      targets: ['mug'],
      show: [{ object: 'mug', phrase: 'mug', description: 'White mug on the tray' }],
      success: { type: 'confirm' },
    },
  ],
});
const [OPEN, POUR, DONE, RINSE] = procedure.steps as [Step, Step, Step, Step];

const OUTLINE: ObjectOutline = {
  points: [
    [-0.05, 0.05],
    [0.05, 0.05],
    [0, -0.05],
  ],
  shape: 'contour',
};

/** A grounder that "sees" the objects in `visible`, placing them like the real one would. */
function setup({
  refreshMs,
  camera = true,
  hint,
}: {
  refreshMs?: number;
  camera?: boolean;
  hint?: number;
} = {}) {
  const bus = new Emitter<AppEvents>();
  const clock = new ManualClock(1000);
  const registry = new ObjectRegistry(bus);
  registry.load(procedure.objects, 0);
  const visible = new Set(['cap', 'jug', 'mug']);
  const asked: FindRequest[][] = [];
  let hold: Promise<void> | null = null;
  const answer = (requests: readonly FindRequest[]): GroundingResult => {
    const sightings = requests.map((r) => {
      const found = visible.has(r.id);
      if (found) {
        registry.observe(r.id, {
          position: [0.1, 0.05, -0.3],
          confidence: 0.9,
          source: 'detector',
          t: 900,
        });
      }
      return {
        id: r.id,
        description: r.description ?? `${r.id} query`,
        phrase: r.phrase ?? r.id,
        detection: found
          ? {
              id: r.id,
              found: true,
              point: [0.5, 0.5] as [number, number],
              box: [0.4, 0.4, 0.6, 0.6] as [number, number, number, number],
              outline: [
                [0.4, 0.4],
                [0.6, 0.4],
                [0.5, 0.6],
              ] as [number, number][],
              confidence: 0.9,
            }
          : { id: r.id, found: false, point: null, box: null, outline: null, confidence: 0 },
        position: found ? ([0.1, 0.05, -0.3] as [number, number, number]) : null,
        outline: found ? OUTLINE : null,
      };
    });
    return {
      ok: true,
      located: sightings.filter((s) => s.position).map((s) => s.id),
      missing: sightings.filter((s) => !s.position).map((s) => s.id),
      sightings,
      source: 'jev',
      frameT: 900,
      ...(hint !== undefined && { refreshMs: hint }),
    };
  };
  const grounder: Grounder = {
    ground: async (requests) => {
      asked.push([...requests]);
      if (hold) await hold;
      return answer(requests);
    },
  };
  /** Holds every answer until the returned function is called. */
  const pause = () => {
    let release = () => {};
    hold = new Promise<void>((resolve) => {
      release = () => {
        hold = null;
        resolve();
      };
    });
    return () => release();
  };
  const events: { type: string; payload: Record<string, unknown> }[] = [];
  bus.onAny((type, payload) => events.push({ type: String(type), payload: { ...payload } }));
  const of = (type: string) => events.filter((e) => e.type === type).map((e) => e.payload);
  const spotlight = new Spotlight({
    bus,
    clock,
    registry,
    grounder: camera ? grounder : null,
    ...(refreshMs === undefined ? {} : { options: { refreshMs } }),
  });
  return { spotlight, registry, clock, asked, visible, pause, events, of };
}

describe('Spotlight', () => {
  it("looks for what a step shows in the step's words, plus targets it has not found", async () => {
    const { spotlight, asked } = setup();
    await spotlight.enterStep(OPEN);
    expect(asked).toEqual([
      [
        {
          id: 'cap',
          description: 'Round blue cap with a windshield symbol, front left',
          phrase: 'blue washer cap',
        },
        { id: 'rag' },
      ],
    ]);
  });

  it('records every answer as an object.detected label for the step', async () => {
    const { spotlight, clock, of } = setup();
    clock.set(1500);
    await spotlight.enterStep(OPEN);
    expect(of('object.detected')).toEqual([
      {
        t: 1500,
        objectId: 'cap',
        stepId: 'open',
        phrase: 'blue washer cap',
        description: 'Round blue cap with a windshield symbol, front left',
        found: true,
        point: [0.5, 0.5],
        box: [0.4, 0.4, 0.6, 0.6],
        outline: [
          [0.4, 0.4],
          [0.6, 0.4],
          [0.5, 0.6],
        ],
        confidence: 0.9,
        position: [0.1, 0.05, -0.3],
        source: 'jev',
        latencyMs: 600,
      },
      {
        t: 1500,
        objectId: 'rag',
        stepId: 'open',
        phrase: 'rag',
        description: 'rag query',
        found: false,
        point: null,
        box: null,
        outline: null,
        confidence: 0,
        position: null,
        source: 'jev',
        latencyMs: 600,
      },
    ]);
  });

  it('outlines only what the step shows, ranked in its order', async () => {
    const { spotlight, of } = setup();
    await spotlight.enterStep(OPEN);
    await spotlight.enterStep(POUR);
    const at = { t: 1000, outline: OUTLINE, offset: [0, 0, 0] };
    expect(of('overlay.outline')).toEqual([
      { ...at, objectId: 'cap', rank: 0, role: 'act', phrase: 'blue washer cap' },
      { ...at, objectId: 'jug', rank: 0, role: 'destination', phrase: 'fluid jug' },
      { ...at, objectId: 'cap', rank: 1, role: 'destination', phrase: 'open reservoir' },
    ]);
  });

  it("takes an unroled item's role from what the step's hands do before its kind", async () => {
    const show = (object: string, extra = {}) => ({
      object,
      phrase: object,
      description: object,
      ...extra,
    });
    const [GRAB, FILL, MARK] = parseProcedure({
      ...procedure,
      steps: [
        {
          id: 'grab',
          instruction: 'Pick up the jug by its handle.',
          action: { verb: 'pick_up', object: 'jug' },
          show: [show('jug')],
          success: { type: 'confirm' },
        },
        {
          id: 'fill',
          instruction: 'Pour the mug into the jug.',
          action: { verb: 'pour', object: 'mug', target: 'jug' },
          show: [show('jug'), show('mug')],
          success: { type: 'confirm' },
        },
        {
          id: 'mark',
          instruction: 'Hold the jug up to the light.',
          action: { verb: 'pick_up', object: 'jug' },
          show: [show('jug', { role: 'level' })],
          success: { type: 'confirm' },
        },
      ],
    }).steps as [Step, Step, Step];
    const { spotlight, of } = setup();
    // The jug is a container, but the hands pick it up; the mug, listed second, is poured.
    for (const step of [GRAB, FILL, MARK]) await spotlight.enterStep(step);
    expect(of('overlay.outline').map((e) => [e.objectId, e.role])).toEqual([
      ['jug', 'act'],
      ['jug', 'destination'],
      ['mug', 'act'],
      ['jug', 'level'],
    ]);
  });

  it('outlines a layout object where the camera saw it, keeping its measured position', async () => {
    const { spotlight, registry, of } = setup();
    await spotlight.enterStep(RINSE);
    expect(registry.get('mug')?.position).toEqual([0.15, 0.05, -0.3]);
    const [mug] = of('overlay.outline');
    const offset = mug?.offset as number[];
    expect(offset.map((v) => Number(v.toFixed(6)))).toEqual([-0.05, 0, 0]);
  });

  it('does not outline an object that is in hand: its shape there is the hand', async () => {
    const { spotlight, registry, of } = setup();
    await spotlight.enterStep(OPEN);
    registry.attach('cap', 'left', { p: [0, 0, 0], q: [0, 0, 0, 1] }, 0);
    await spotlight.enterStep(POUR);
    expect(of('overlay.outline').map((e) => e.objectId)).toEqual(['cap', 'jug']);
  });

  it('resolves with what still has no position', async () => {
    const { spotlight } = setup();
    expect(await spotlight.enterStep(OPEN)).toEqual(['rag']);
  });

  it('asks nothing for a step that shows nothing and has no missing targets', async () => {
    const { spotlight, asked } = setup();
    expect(await spotlight.enterStep(DONE)).toEqual([]);
    expect(asked).toEqual([]);
  });

  it('looks again every refreshMs after an answer, one look at a time, skipping held objects', async () => {
    const { spotlight, clock, asked, registry, pause } = setup({ refreshMs: 3000 });
    await spotlight.enterStep(POUR);
    expect(spotlight.tick(clock.now() + 2999)).toBeNull();

    registry.attach('jug', 'right', { p: [0, 0, 0], q: [0, 0, 0, 1] }, clock.now());
    const resume = pause();
    clock.advance(3000);
    const look = spotlight.tick(clock.now());
    expect(look).not.toBeNull();
    expect(asked.at(-1)).toEqual([
      {
        id: 'cap',
        description: 'The open reservoir neck where the cap was',
        phrase: 'open reservoir',
      },
    ]);
    expect(spotlight.tick(clock.advance(10_000))).toBeNull();
    resume();
    await look;
    expect(spotlight.tick(clock.now() + 2999)).toBeNull();
    expect(spotlight.tick(clock.now() + 3000)).not.toBeNull();
  });

  it('looks again as soon as a tracking finder asks, but never later than refreshMs', async () => {
    const fast = setup({ refreshMs: 3000, hint: 50 });
    await fast.spotlight.enterStep(POUR);
    expect(fast.spotlight.tick(fast.clock.now() + 49)).toBeNull();
    expect(fast.spotlight.tick(fast.clock.now() + 50)).not.toBeNull();

    const slow = setup({ refreshMs: 3000, hint: 10_000 });
    await slow.spotlight.enterStep(POUR);
    expect(slow.spotlight.tick(slow.clock.now() + 3000)).not.toBeNull();
  });

  it('never refreshes with refreshMs 0, even when the finder asks', async () => {
    const { spotlight, clock } = setup({ refreshMs: 0, hint: 50 });
    await spotlight.enterStep(POUR);
    expect(spotlight.tick(clock.advance(60_000))).toBeNull();
  });

  it('never refreshes with refreshMs 0', async () => {
    const { spotlight, clock } = setup({ refreshMs: 0 });
    await spotlight.enterStep(POUR);
    expect(spotlight.tick(clock.advance(60_000))).toBeNull();
  });

  it('records a late answer under the step that asked, but does not outline it', async () => {
    const { spotlight, pause, of } = setup();
    const resume = pause();
    const first = spotlight.enterStep(OPEN);
    resume();
    const second = spotlight.enterStep(DONE);
    await Promise.all([first, second]);
    expect(of('object.detected').map((e) => e.stepId)).toEqual(['open', 'open']);
    expect(of('overlay.outline')).toEqual([]);
  });

  it('keeps an outline when a later look misses: the learner may be looking away', async () => {
    const { spotlight, clock, visible, of } = setup({ refreshMs: 3000 });
    await spotlight.enterStep(OPEN);
    visible.delete('cap');
    await spotlight.tick(clock.advance(3000));
    expect(of('overlay.outline')).toHaveLength(1);
    expect(of('object.detected').at(-1)).toMatchObject({ objectId: 'cap', found: false });
  });

  it("uses the current step's words for an object it shows, whoever asks", async () => {
    const { spotlight, asked } = setup();
    await spotlight.enterStep(OPEN);
    await spotlight.find([{ id: 'cap' }, { id: 'jug' }]);
    expect(asked.at(-1)).toEqual([
      {
        id: 'cap',
        description: 'Round blue cap with a windshield symbol, front left',
        phrase: 'blue washer cap',
      },
      { id: 'jug' },
    ]);
  });

  it('lets a caller join the look in flight for an object instead of asking again', async () => {
    const { spotlight, asked, pause } = setup();
    const resume = pause();
    const look = spotlight.enterStep(OPEN);
    let answer: string[] | null = null;
    const joined = spotlight.find([{ id: 'cap' }, { id: 'rag' }, { id: 'jug' }], { join: true });
    void joined.then((ids) => {
      answer = ids;
    });
    // Only the jug had no look out. A step's own look still asks again, in its words.
    expect(asked.map((r) => r.map((q) => q.id))).toEqual([['cap', 'rag'], ['jug']]);
    void spotlight.find([{ id: 'cap' }]);
    expect(asked).toHaveLength(3);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    // Not reported missing (nor found) before the look finding it has answered.
    expect(answer).toBeNull();
    resume();
    expect(await joined).toEqual(['rag']);
    await look;
  });

  it('asks anew for an object whose look belongs to a lesson that ended', async () => {
    const { spotlight, asked, pause } = setup();
    const resume = pause();
    const look = spotlight.enterStep(OPEN);
    spotlight.stop();
    const again = spotlight.find([{ id: 'cap' }], { join: true });
    expect(asked.map((r) => r.map((q) => q.id))).toEqual([['cap', 'rag'], ['cap']]);
    resume();
    await Promise.all([look, again]);
  });

  it("leaves an ended lesson's late answer out of the next lesson's labels", async () => {
    const { spotlight, pause, of } = setup();
    const resume = pause();
    const old = spotlight.enterStep(OPEN);
    spotlight.stop();
    // The next lesson starts on its first step, and its own look answers as usual.
    const next = spotlight.enterStep(POUR);
    resume();
    await Promise.all([old, next]);
    expect(of('object.detected').map((e) => `${e.objectId}:${e.stepId}`)).toEqual([
      'jug:pour',
      'cap:pour',
    ]);
  });

  it("leaves an ended lesson's late answer out of the registry", async () => {
    const bus = new Emitter<AppEvents>();
    const clock = new ManualClock(1000);
    const registry = new ObjectRegistry(bus);
    registry.load(procedure.objects, 0);
    const registered: string[] = [];
    bus.on('object.registered', (e) => registered.push(e.objectId));
    const poses = new PoseHistory(16);
    poses.push(890, { p: [0, 0.3, 0], q: [0, 0, 0, 1] });
    poses.push(910, { p: [0, 0.3, 0], q: [0, 0, 0, 1] });
    let answer: () => void = () => {};
    const answered = new Promise<void>((resolve) => (answer = resolve));
    const camera: CameraModel = {
      intrinsics: { width: 1280, height: 720, fx: 800, fy: 800, cx: 640, cy: 360 },
      headFromCamera: { p: [0, 0, 0], q: [0, 0, 0, 1] },
    };
    const grounder = new ObjectGrounder({
      camera: {
        capture: async () => ({ t: 900, width: 1280, height: 720, jpegBase64: 'AAAA' }),
        model: () => camera,
      },
      locator: {
        locate: async (_frame, objects) => {
          await answered;
          return {
            model: 'jev',
            detections: objects.map((o) => ({
              id: o.id,
              found: true,
              point: [0.5, 560 / 720] as [number, number],
              box: null,
              outline: null,
              confidence: 0.9,
            })),
          };
        },
      },
      registry,
      poses,
      workspace: () => new Workspace({ p: [0, 0, 0], q: [0, 0, 0, 1] }),
    });
    const spotlight = new Spotlight({ bus, clock, registry, grounder });
    const look = spotlight.enterStep(OPEN);
    // The lesson ends while the cap is being looked for; the next one may use the id for another.
    spotlight.stop();
    answer();
    expect(await look).toEqual(['cap', 'rag']);
    expect(registry.get('cap')).toBeUndefined();
    expect(registered).toEqual([]);
  });

  it('stops outlining and refreshing when the lesson ends', async () => {
    const { spotlight, clock, pause, of } = setup();
    const resume = pause();
    const look = spotlight.enterStep(OPEN);
    spotlight.stop();
    resume();
    await look;
    expect(of('overlay.outline')).toEqual([]);
    expect(spotlight.tick(clock.advance(60_000))).toBeNull();
  });

  it('without a camera, outlines nothing and reports what has no position', async () => {
    const { spotlight, events } = setup({ camera: false });
    expect(await spotlight.enterStep(OPEN)).toEqual(['cap', 'rag']);
    expect(events).toEqual([]);
  });
});

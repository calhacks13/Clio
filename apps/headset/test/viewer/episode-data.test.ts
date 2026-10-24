import {
  type EpisodeEvent,
  type EpisodeMeta,
  type FrameRecord,
  HAND_LAYOUT,
  type HandSample,
  type ObjectTrackRecord,
} from '@clio/protocol';
import { describe, expect, it } from 'vitest';
import {
  atOrBefore,
  type Detection,
  EpisodeData,
  episodeDuration,
  formatClock,
  insertByTime,
  isRecording,
  NdjsonDecoder,
  upperBound,
} from '../../src/viewer/episode-data';

function meta(overrides: Partial<EpisodeMeta> = {}): EpisodeMeta {
  return {
    schema: 'clio.episode/1',
    episodeId: 'ep-20261024-065830-test',
    createdAt: '2026-10-24T06:58:30.603Z',
    mode: 'learn',
    procedure: { id: 'shirt-fold', version: 1, title: 'Fold a T-shirt' },
    operator: { role: 'learner' },
    clock: { timeline: 'performance.now', startEpochMs: 1_000_000 },
    space: {
      frame: 'workspace',
      units: 'm',
      upAxis: '+y',
      worldFromWorkspace: [0, 1, -0.5, 0, 0, 0, 1],
      calibration: 'default_in_front',
      anchored: false,
    },
    hands: HAND_LAYOUT,
    objects: [
      { id: 'cup', label: 'cup A', position: [0.1, 0, -0.2], radius: 0.04, method: 'layout' },
    ],
    coach: { kind: 'scripted' },
    device: { userAgent: 'test', emulated: true, xrFeatures: [] },
    app: { version: '0.1.0' },
    ...overrides,
  };
}

const hand = (value: number): HandSample => ({ joints: new Array(200).fill(value), pinch: 0.03 });

function frame(t: number, x = t / 1000): FrameRecord {
  return { t, head: [x, 0.5, 0.4, 0, 0, 0, 1], left: hand(t), right: null };
}

const entered = (t: number, index: number): EpisodeEvent => ({
  t,
  type: 'step.entered',
  stepId: `s${index}`,
  index,
  instruction: `Do step ${index + 1}.`,
  targets: [],
});

function detected(t: number, objectId: string, x: number, latencyMs = 0): Detection {
  return {
    t,
    type: 'object.detected',
    objectId,
    stepId: null,
    phrase: null,
    description: objectId,
    found: true,
    point: [0.5, 0.5],
    box: [0.4, 0.4, 0.6, 0.6],
    outline: null,
    confidence: 0.9,
    position: [x, 0, -0.2],
    source: 'gemini',
    latencyMs,
  };
}

const track = (t: number, id: string, x: number): ObjectTrackRecord => ({
  t,
  objects: [{ id, position: [x, 0, -0.2], orientation: null, confidence: 0.8, source: 'detector' }],
});

describe('NdjsonDecoder', () => {
  it('parses whole lines and holds a line cut between chunks until it ends', () => {
    const decoder = new NdjsonDecoder();
    expect(decoder.push('{"t":1}\n{"t":')).toEqual([{ t: 1 }]);
    expect(decoder.push('2}\n\n{"t":3}')).toEqual([{ t: 2 }]);
    expect(decoder.push('\n')).toEqual([{ t: 3 }]);
  });

  it('decodes bytes with a multibyte character split across chunks', () => {
    const bytes = new TextEncoder().encode('{"text":"café"}\n');
    const cut = bytes.length - 4; // inside the two bytes of "é"
    const decoder = new NdjsonDecoder();
    expect(decoder.push(bytes.slice(0, cut))).toEqual([]);
    expect(decoder.push(bytes.slice(cut))).toEqual([{ text: 'café' }]);
  });

  it('skips and counts lines that are not JSON', () => {
    const decoder = new NdjsonDecoder();
    expect(decoder.push('{"t":1}\nnot json\n{"t":2}\n')).toEqual([{ t: 1 }, { t: 2 }]);
    expect(decoder.corrupt).toBe(1);
  });
});

describe('time search', () => {
  const items = [{ t: 0 }, { t: 10 }, { t: 10 }, { t: 20 }];

  it('finds the first item after t, and the last at or before it', () => {
    expect(upperBound(items, -1)).toBe(0);
    expect(upperBound(items, 10)).toBe(3);
    expect(upperBound(items, 15)).toBe(3);
    expect(upperBound(items, 99)).toBe(4);
    expect(atOrBefore(items, -1)).toBeNull();
    expect(atOrBefore(items, 19.9)).toBe(items[2]);
    expect(atOrBefore([], 5)).toBeNull();
  });

  it('inserts late arrivals in order, after equal times', () => {
    const list = [
      { t: 0, n: 'a' },
      { t: 20, n: 'b' },
    ];
    insertByTime(list, { t: 30, n: 'c' });
    insertByTime(list, { t: 10, n: 'd' });
    insertByTime(list, { t: 20, n: 'e' });
    expect(list.map((i) => i.n)).toEqual(['a', 'd', 'b', 'e', 'c']);
  });
});

describe('EpisodeData', () => {
  it('looks up the frame at or before a time, in t order even when lines arrive late', () => {
    const data = new EpisodeData(meta());
    data.addFrames([frame(100), frame(300)]);
    data.addFrames([frame(200)]);
    expect(data.frames.map((f) => f.t)).toEqual([100, 200, 300]);
    expect(data.frameAt(50)).toBeNull();
    expect(data.frameAt(200)?.t).toBe(200);
    expect(data.frameAt(299)?.t).toBe(200);
    expect(data.frameAt(1e9)?.t).toBe(300);
    expect(data.lastFrameT).toBe(300);
  });

  it('rejects lines that do not match the protocol', () => {
    const data = new EpisodeData(meta());
    data.addFrames([{ t: 'soon' }, { ...frame(0), left: { joints: [1, 2], pinch: 0 } }, frame(5)]);
    data.addEvents([{ t: 1, type: 'no.such.event' }, entered(2, 0)]);
    data.addObjects([{ t: 3 }, track(4, 'cup', 0.2)]);
    expect([data.frames.length, data.events.length, data.rejected]).toEqual([1, 1, 4]);
  });

  it('gives the events and the running step up to a time', () => {
    const data = new EpisodeData(meta());
    data.addEvents([entered(0, 0), entered(1000, 1), entered(2000, 2)]);
    expect(data.eventsUntil(1000).map((e) => e.t)).toEqual([0, 1000]);
    expect(data.stepAt(-1)).toBeNull();
    expect(data.stepAt(1500)?.index).toBe(1);
    expect(data.stepAt(5000)?.index).toBe(2);
  });

  it('starts objects at their placement and moves each to its newest estimate at t', () => {
    const data = new EpisodeData(meta());
    data.addObjects([track(100, 'cup', 0.2), track(200, 'cup', 0.3), track(150, 'lid', 0.5)]);
    const at = (t: number) => Object.fromEntries(data.objectsAt(t).map((o) => [o.id, o]));

    expect(at(50)).toEqual({
      cup: {
        id: 'cup',
        label: 'cup A',
        radius: 0.04,
        position: [0.1, 0, -0.2],
        orientation: null,
        confidence: 1,
        source: 'layout',
        updatedT: null,
      },
    });
    expect(at(150).cup?.position).toEqual([0.2, 0, -0.2]);
    expect(at(150).cup?.label).toBe('cup A');
    expect(at(150).lid).toMatchObject({ label: 'lid', radius: 0.03, position: [0.5, 0, -0.2] });
    expect(at(250).cup).toMatchObject({
      position: [0.3, 0, -0.2],
      orientation: null,
      source: 'detector',
      updatedT: 200,
    });
    // Seeking back after a later pose rebuilds from the placement, never keeping the later one.
    expect(at(120).cup).toMatchObject({ position: [0.2, 0, -0.2], updatedT: 100 });
    expect(at(50).cup).toMatchObject({ position: [0.1, 0, -0.2], updatedT: null });
    expect(data.endT).toBe(200);
  });

  it('keeps a measured orientation and leaves an unmeasured one unknown', () => {
    const data = new EpisodeData(meta());
    data.addObjects([
      {
        t: 10,
        objects: [
          {
            id: 'cup',
            position: [0, 0, 0],
            orientation: [0, 0.6, 0, 0.8],
            confidence: 1,
            source: 'marker',
          },
        ],
      },
    ]);
    expect(data.objectsAt(5)[0]?.orientation).toBeNull();
    expect(data.objectsAt(10)[0]?.orientation).toEqual([0, 0.6, 0, 0.8]);
  });

  it('keeps the newest object-finder answer per object', () => {
    const data = new EpisodeData(meta());
    data.addEvents([
      detected(100, 'cup', 0.1),
      detected(200, 'lid', 0.2),
      detected(300, 'cup', 0.3),
    ]);
    expect(data.detectionsAt(250).map((d) => [d.objectId, d.position?.[0]])).toEqual([
      ['cup', 0.1],
      ['lid', 0.2],
    ]);
    expect(data.detectionsAt(300).find((d) => d.objectId === 'cup')?.position?.[0]).toBe(0.3);
  });

  it('finds the head pose when a detection frame was captured', () => {
    const data = new EpisodeData(meta());
    data.addFrames([frame(0), frame(100), frame(200)]);
    expect(data.headAtCapture(detected(250, 'cup', 0, 120))?.[0]).toBe(0.1);
    expect(data.headAtCapture(detected(50, 'cup', 0, 100))).toBeNull();
  });

  it('thins the head trail to a window and always ends on the newest frame', () => {
    const data = new EpisodeData(meta());
    data.addFrames(Array.from({ length: 11 }, (_, i) => frame(i * 100)));
    expect(data.headTrail(1000, 300).map((p) => p[0])).toEqual([0.8, 0.9, 1]);
    const thinned = data.headTrail(1000, 10_000, 4).map((p) => p[0]);
    expect(thinned).toEqual([0, 0.3, 0.6, 0.9, 1]);
    expect(data.headTrail(-5, 1000)).toEqual([]);
  });
});

describe('episode helpers', () => {
  it('spans the timeline to the finish or the newest record', () => {
    const data = new EpisodeData(meta());
    data.addFrames([frame(500)]);
    data.addEvents([entered(700, 0)]);
    expect(episodeDuration(data, null)).toBe(700);
    expect(episodeDuration(data, 900)).toBe(900);
  });

  it('calls an episode recording while its newest record is recent', () => {
    const m = meta();
    expect(isRecording(m, 5000, 1_000_000 + 5000 + 2000)).toBe(true);
    expect(isRecording(m, 5000, 1_000_000 + 5000 + 60_000)).toBe(false);
  });

  it('formats times as m:ss.s', () => {
    expect(formatClock(0)).toBe('0:00.0');
    expect(formatClock(9_950)).toBe('0:09.9');
    expect(formatClock(189_366.4)).toBe('3:09.3');
    expect(formatClock(-5)).toBe('0:00.0');
  });
});

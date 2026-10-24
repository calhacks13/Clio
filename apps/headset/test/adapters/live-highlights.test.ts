/// <reference path="../../src/adapters/render/troika.d.ts" />
import { parseProcedure } from '@clio/protocol';
import { Object3D } from 'three';
import { describe, expect, it, vi } from 'vitest';

// troika's SDF text needs a browser; a plain object stands in for each label.
vi.mock('../../src/adapters/render/text', () => ({
  makeText: () =>
    Object.assign(new Object3D(), { text: '', fillOpacity: 1, sync() {}, dispose() {} }),
  setText: (t: { text: string }, value: string) => {
    t.text = value;
  },
}));

import {
  OBJECT_HIGHLIGHT_COLOR,
  ObjectHighlight,
} from '../../src/adapters/render/object-highlight';
import type { PresentContext } from '../../src/adapters/render/presenter';
import {
  type LiveHighlight,
  LiveHighlightsPresenter,
  liveColor,
  WARNING_COLOR,
} from '../../src/adapters/render/presenters/live-highlights';
import { ObjectMarkersPresenter } from '../../src/adapters/render/presenters/object-markers';
import { RANK_COLORS } from '../../src/adapters/render/presenters/outlines';
import type { OverlaySnapshot } from '../../src/domain/overlay/overlay-model';
import type { ObjectEstimate } from '../../src/domain/world/object-registry';
import type { Placement } from '../../src/domain/world/placement';

const placement = (center: [number, number, number]): Placement =>
  ({
    center,
    outline: {
      shape: 'contour',
      points: [
        [-0.05, -0.02],
        [0.05, -0.02],
        [0.05, 0.02],
        [-0.05, 0.02],
      ],
    },
  }) as Placement;

const light = (id: string, extra: Partial<LiveHighlight> = {}): LiveHighlight => ({
  id,
  placement: placement([0, 1, -0.5]),
  shapeVersion: 1,
  label: id,
  rank: 0,
  style: null,
  mode: 'object',
  held: false,
  ...extra,
});

const snapshot = (highlights: OverlaySnapshot['highlights'] = []): OverlaySnapshot => ({
  phase: 'lesson',
  title: null,
  instruction: null,
  highlights,
  outlines: [],
  toast: null,
  demoStepId: null,
  caption: null,
  coach: 'off',
  recording: null,
  missing: [],
});

const context = (t: number, dt = 16, highlights: OverlaySnapshot['highlights'] = []) =>
  ({
    t,
    dt,
    snapshot: snapshot(highlights),
    procedure: null,
    objects: [],
    demo: null,
    demoHands: null,
    hands: null,
    head: { p: [0, 1.2, 0], q: [0, 0, 0, 1] },
    worldFromWorkspace: { p: [0, 0, 0], q: [0, 0, 0, 1] },
    calibration: null,
    debug: false,
  }) as PresentContext;

function setup(options: { hideHeld?: boolean } = {}) {
  let lights: LiveHighlight[] = [];
  const presenter = new LiveHighlightsPresenter(() => lights, options);
  const show = (next: LiveHighlight[]) => {
    lights = next;
  };
  return { presenter, show };
}

describe('liveColor', () => {
  it("colours by the step's rank unless the coach highlights the object", () => {
    expect(liveColor({ rank: 0, style: null })).toBe(RANK_COLORS[0]);
    expect(liveColor({ rank: 1, style: null })).toBe(RANK_COLORS[1]);
    expect(liveColor({ rank: 3, style: null })).toBe(RANK_COLORS[1]);
    expect(liveColor({ rank: 1, style: 'target' })).toBe(OBJECT_HIGHLIGHT_COLOR);
    expect(liveColor({ rank: 1, style: 'attention' })).toBe(RANK_COLORS[1]);
    expect(liveColor({ rank: null, style: 'attention' })).toBe(OBJECT_HIGHLIGHT_COLOR);
    expect(liveColor({ rank: 0, style: 'warning' })).toBe(WARNING_COLOR);
  });
});

describe('LiveHighlightsPresenter', () => {
  it('draws one light per followed object, all sharing one depth occlusion', () => {
    const setOcclusion = vi.spyOn(ObjectHighlight.prototype, 'setOcclusion');
    const { presenter, show } = setup();
    show([light('cap'), light('jug', { rank: 1, placement: placement([0.3, 1, -0.5]) })]);
    presenter.update(context(0));
    expect(presenter.object.children).toHaveLength(2);
    expect(presenter.object.children.map((c) => c.position.x)).toEqual([0, 0.3]);
    const occlusions = new Set(setOcclusion.mock.calls.map(([occlusion]) => occlusion));
    expect(occlusions.size).toBe(1);
    setOcclusion.mockRestore();
  });

  it('reshapes a light only for a new shape, and otherwise just moves it', () => {
    const setOutline = vi.spyOn(ObjectHighlight.prototype, 'setOutline');
    const { presenter, show } = setup();
    show([light('cap')]);
    presenter.update(context(0));
    show([light('cap', { placement: placement([0.01, 1, -0.5]) })]);
    presenter.update(context(16));
    expect(setOutline).toHaveBeenCalledTimes(1);
    expect(presenter.object.children[0]?.position.x).toBe(0.01);
    show([light('cap', { shapeVersion: 2 })]);
    presenter.update(context(32));
    expect(setOutline).toHaveBeenCalledTimes(2);
    setOutline.mockRestore();
  });

  it('flares once and pulses for a coach asking for attention, red for a warning', () => {
    const ignite = vi.spyOn(ObjectHighlight.prototype, 'ignite');
    const setColor = vi.spyOn(ObjectHighlight.prototype, 'setColor');
    const { presenter, show } = setup();
    show([light('cap')]);
    presenter.update(context(0));
    const lit = ignite.mock.calls.length;
    show([light('cap', { style: 'attention' })]);
    presenter.update(context(16));
    presenter.update(context(32));
    expect(ignite.mock.calls.length).toBe(lit + 1);
    show([light('cap', { style: 'warning' })]);
    presenter.update(context(48));
    expect(setColor).toHaveBeenLastCalledWith(WARNING_COLOR);
    ignite.mockRestore();
    setColor.mockRestore();
  });

  it('fades out an object no longer followed, then lets it go', () => {
    const { presenter, show } = setup();
    show([light('cap')]);
    presenter.update(context(0, 1000));
    expect(presenter.object.children[0]?.visible).toBe(true);
    show([]);
    presenter.update(context(1000, 300));
    expect(presenter.object.children).toHaveLength(1);
    presenter.update(context(2000, 1000));
    expect(presenter.object.children).toHaveLength(0);
  });

  it('follows an object in hand unless asked to hide it there', () => {
    const follow = setup();
    follow.show([light('cap', { held: true })]);
    follow.presenter.update(context(0, 1000));
    expect(follow.presenter.object.children[0]?.visible).toBe(true);

    const hide = setup({ hideHeld: true });
    hide.show([light('cap', { held: true })]);
    hide.presenter.update(context(0, 1000));
    expect(hide.presenter.object.children).toHaveLength(0);
  });
});

describe('ObjectMarkersPresenter with live lights', () => {
  const [spec] = parseProcedure({
    schema: 'clio.procedure/1',
    id: 'p',
    version: 1,
    title: 'P',
    summary: 'S',
    workspace: { size: [1, 1] },
    objects: [{ id: 'cap', label: 'cap', placement: { method: 'detect' } }],
    steps: [{ id: 's', instruction: 'Wait.', success: { type: 'confirm' } }],
  }).objects;
  const cap = {
    id: 'cap',
    spec,
    position: [0, 0, -0.3],
    orientation: null,
    confidence: 0.9,
    source: 'detector',
    t: 0,
    heldBy: null,
  } as ObjectEstimate;

  it('drops the ring and label of a highlighted object whose live light names it', () => {
    let lit = false;
    const markers = new ObjectMarkersPresenter(() => lit);
    const highlights = [
      { objectId: 'cap', style: 'target' as const, source: 'auto' as const, until: null },
    ];
    const ctx = { ...context(0, 16, highlights), objects: [cap] } as PresentContext;
    markers.update(ctx);
    const [group] = markers.object.children;
    const [, ring, label] = group?.children ?? [];
    expect([ring?.visible, label?.visible]).toEqual([true, true]);
    lit = true;
    markers.update(ctx);
    expect([ring?.visible, label?.visible]).toEqual([false, false]);
  });
});

import { HAND_SAMPLE_LENGTH, type HandSample, jointOffset, WIDGET_KINDS } from '@clio/protocol';
import {
  CylinderGeometry,
  Group,
  HemisphereLight,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  type Object3D,
  OrthographicCamera,
  PerspectiveCamera,
  PlaneGeometry,
  Quaternion,
  Scene,
  SRGBColorSpace,
  TextureLoader,
  Vector3,
  WebGLRenderer,
} from 'three';
import { ObjectHighlight } from '../adapters/render/object-highlight';
import { PANEL_DISTANCE } from '../adapters/render/panel-placement';
import type { PresentContext } from '../adapters/render/presenter';
import { InstructionPanelPresenter } from '../adapters/render/presenters/instruction-panel';
import { WidgetChipsPresenter } from '../adapters/render/widgets/chips';
import { WidgetDockPresenter } from '../adapters/render/widgets/dock';
import {
  FIXTURE_STATES,
  FIXTURE_T,
  type FixtureState,
  selectFixtures,
  timer,
  type WidgetFixture,
  widgetFixtures,
} from '../adapters/render/widgets/fixtures';
import { preloadWidgetFonts } from '../adapters/render/widgets/fonts';
import { angularBounds } from '../adapters/render/widgets/placement';
import { troikaText } from '../adapters/render/widgets/text-port';
import { DOCK_ORDERS, type Face } from '../adapters/render/widgets/views/face';
import { PillFace } from '../adapters/render/widgets/views/pill';
import { createCard } from '../adapters/render/widgets/views/view';
import { ManualClock } from '../core/clock';
import { Emitter } from '../core/emitter';
import type { Vec3 } from '../core/math';
import type { AppEvents } from '../domain/events';
import { WidgetBoard } from '../domain/widgets/board';
import type { Widget, WidgetIntent, WidgetKind, WidgetSnapshot } from '../domain/widgets/types';
import type { ObjectEstimate } from '../domain/world/object-registry';
import { billboard, type ObjectOutline, outlinePoint } from '../domain/world/outline';
import type { Placement } from '../domain/world/placement';

// Desktop preview of the coach's widgets (docs/widgets.md), on the real presenters: the dock beside
// the real step card (placed by its own code, as on the headset, with a short or long step), every
// fixture face-on in a grid, or timer chips beside stand-in objects. ?block= puts a tracked object
// where the column hangs, so it changes sides. Fixtures by default; ?live=1 drives a real
// WidgetBoard on a manual clock with a button per tool. ?t= freezes the clock (dt 0) after a short
// pre-roll, so screenshots are stable. window.__preview: ready (fonts loaded, every text laid
// out, two frames drawn), set(widgets) and probe(x, y), which reads a pixel back to check that
// tokens come out exact.

type ViewMode = 'dock' | 'grid' | 'chip';
type Background = 'photo' | 'bright' | 'dark';
type CardText = 'short' | 'long';
type Block = 'none' | 'right' | 'left' | 'both';

interface PreviewHook {
  ready: Promise<void>;
  set(widgets: readonly Widget[]): void;
  probe(x: number, y: number): [number, number, number];
}

declare global {
  interface Window {
    __preview?: PreviewHook;
    __cost?: { updateMs: number; calls: number };
  }
}

const params = new URLSearchParams(location.search);
const pick = <T extends string>(value: string | null, options: readonly T[], fallback: T): T =>
  options.includes(value as T) ? (value as T) : fallback;

const view = pick<ViewMode>(params.get('view'), ['dock', 'grid', 'chip'], 'dock');
const state = pick<FixtureState | 'all'>(params.get('state'), [...FIXTURE_STATES, 'all'], 'all');
const background = pick<Background>(params.get('bg'), ['photo', 'bright', 'dark'], 'bright');
const cardText = pick<CardText>(params.get('card'), ['short', 'long'], 'short');
let block = pick<Block>(params.get('block'), ['none', 'right', 'left', 'both'], 'none');
const kinds = (params.get('kinds') ?? '')
  .split(',')
  .filter((k): k is WidgetKind => (WIDGET_KINDS as readonly string[]).includes(k));
const frozen = params.has('t') ? Number(params.get('t')) : null;
const px = params.has('px') ? Math.max(1, Number(params.get('px')) || 25) : null;
const orbit = params.get('orbit') === '1';
const live = params.get('live') === '1';
const speed = Math.max(0.1, Number(params.get('speed') ?? '1') || 1);
const touchAt = parseTouch(params.get('touch'));
const nearAt = parseTouch(params.get('near'));

function parseTouch(value: string | null): { widgetId: string; index: number } | null {
  if (!value) return null;
  const [widgetId, index] = value.split(':');
  return widgetId ? { widgetId, index: Number(index ?? 0) || 0 } : null;
}

// ---- time --------------------------------------------------------------------------------------

const T0 = frozen ?? FIXTURE_T;
const wallStart = performance.now();
const now = (): number => frozen ?? T0 + (performance.now() - wallStart) * (live ? speed : 1);
/** Frames drawn before the frozen t, so motion has settled and touch has armed. */
const PREROLL = [-1500, -1000, -600, -300];

// ---- scene -------------------------------------------------------------------------------------

const EYE = new Vector3(0, 1.6, 0);
const BG: Record<Exclude<Background, 'photo'>, number> = { bright: 0xeef0f2, dark: 0x1a1d22 };
/** Pixels per metre at 0.65 m for ?px= (pixels per degree). */
const pxPerMetre = (perDegree: number): number => (perDegree * 180) / Math.PI / PANEL_DISTANCE;
/** How wide the ?px= view is (deg). */
const PX_FOV_H = 40;

const renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(px ? 1 : devicePixelRatio);
if (px) renderer.domElement.classList.add('pixelated');
document.body.prepend(renderer.domElement);
const scene = new Scene();
scene.add(new HemisphereLight(0xffffff, 0x8a94a4, 2.2));
const perspective = new PerspectiveCamera(50, 1, 0.01, 20);
const ortho = new OrthographicCamera(-1, 1, 1, -1, 0.01, 20);
const camera = view === 'grid' ? ortho : perspective;
scene.add(camera);

/** The passthrough stand-in: a photo or a flat colour, 1.2 m in front of the eye. */
const backdrop = new Mesh(
  new PlaneGeometry(1, 1),
  new MeshBasicMaterial({
    color: background === 'photo' ? 0xffffff : BG[background],
    // Like passthrough, it is behind everything, whatever its distance.
    depthTest: false,
    depthWrite: false,
  }),
);
backdrop.renderOrder = -1;
backdrop.position.z = -1.2;
camera.add(backdrop);
if (background === 'photo') {
  new TextureLoader().load('/demo/caliper.jpg', (texture) => {
    texture.colorSpace = SRGBColorSpace;
    backdrop.material.map = texture;
    backdrop.material.needsUpdate = true;
  });
}

const captions = document.querySelector('#captions') as HTMLElement;
const status = document.querySelector('#status') as HTMLElement;
const captionTags: { el: HTMLElement; at: Object3D; offset: Vector3 }[] = [];
function caption(text: string, at: Object3D, offset: Vector3): void {
  const el = document.createElement('div');
  el.className = background === 'bright' ? 'caption' : 'caption light';
  el.textContent = text;
  captions.append(el);
  captionTags.push({ el, at, offset });
}

// ---- what the presenters read ------------------------------------------------------------------

const fixtures = widgetFixtures(T0);
let snapshot: WidgetSnapshot = { rev: 1, widgets: [] };
const intents: WidgetIntent[] = [];
const clock = new ManualClock(T0);
const board = live
  ? new WidgetBoard({
      bus: new Emitter<AppEvents>(),
      clock,
      view: { procedure: () => null, label: (id) => id, plan: () => null },
    })
  : null;
board?.attach();
const source = (): WidgetSnapshot => (board ? board.snapshot() : snapshot);
const onIntent = (intent: WidgetIntent): void => {
  intents.push(intent);
  board?.touch(intent);
  status.textContent = `${intent.type} ${intent.widgetId} ${intent.index} (${intent.hand})`;
};

const objects: ObjectEstimate[] = [];
const ctx: PresentContext = {
  t: T0,
  dt: 0,
  snapshot: {
    phase: 'lesson',
    title: null,
    instruction: null,
    highlights: [],
    outlines: [],
    toast: null,
    demoStepId: null,
    caption: null,
    coach: 'off',
    voice: 'off',
    recording: null,
    missing: [],
  },
  procedure: null,
  objects,
  demo: null,
  demoHands: null,
  hands: null,
  head: { p: [EYE.x, EYE.y, EYE.z], q: [0, 0, 0, 1] },
  worldFromWorkspace: { p: [0, 0, 0], q: [0, 0, 0, 1] },
  calibration: null,
  debug: false,
};

// ---- the dock beside the step card -------------------------------------------------------------

/** Steps from the curated lessons: a short one, and a long one with a detail. */
const STEPS: Record<CardText, NonNullable<PresentContext['snapshot']['instruction']>> = {
  short: { text: 'Now add vinegar to cup A.', index: 2, total: 5, progress: 0 },
  long: {
    text: 'Cross your left hand over your right and pinch the hem dot.',
    detail: 'Your left hand keeps holding the shoulder fabric and brings it to the hem.',
    index: 3,
    total: 5,
    progress: 0,
  },
};

/** The real step card, placed by its own code for a head at EYE looking straight ahead. */
const card = new InstructionPanelPresenter(() => {});
const dock = new WidgetDockPresenter({ source, onIntent, anchor: card });
const chips = new WidgetChipsPresenter({ source });
const workspace = new Group();
scene.add(workspace);

/** The default dock: a lesson mid-step. */
const DOCK_KINDS: readonly WidgetKind[] = ['timer', 'value', 'checklist'];

function dockWidgets(): Widget[] {
  const wanted = kinds.length ? kinds : state === 'all' ? WIDGET_KINDS : DOCK_KINDS;
  const wantedState: FixtureState = state === 'all' || state === 'collapsed' ? 'running' : state;
  const out: Widget[] = [];
  for (const kind of wanted) {
    const found =
      fixtures.find((f) => f.kind === kind && f.state === wantedState) ??
      fixtures.find((f) => f.kind === kind && f.state === 'running');
    if (found) out.push(found.widget);
  }
  return out;
}

/**
 * A tracked object's silhouette, a 10 cm square behind where the column hangs on `side` and clear
 * of the card, and its glow: what the live tracker gives the card and the dock to keep clear of.
 */
function trackedObject(side: 1 | -1): { mask: Placement; glow: ObjectHighlight } {
  const center: Vec3 = [EYE.x + side * 0.37, EYE.y - 0.12, EYE.z - 0.62];
  const half = 0.05;
  const outline: ObjectOutline = {
    shape: 'contour',
    points: [
      [-half, -half],
      [half, -half],
      [half, half],
      [-half, half],
    ],
  };
  const plane = billboard(center, [EYE.x, EYE.y, EYE.z]);
  if (!plane) throw new Error('A tracked object at the eye');
  const mask: Placement = {
    center,
    outline,
    points: outline.points.map((point) => outlinePoint(plane, center, point)),
    label: outlinePoint(plane, center, [0, half]),
    depth: 'fixed',
  };
  const glow = new ObjectHighlight();
  glow.setOutline(outline, 'object');
  glow.position.set(...center);
  glow.quaternion.setFromRotationMatrix(
    new Matrix4().makeBasis(
      new Vector3(...plane.right),
      new Vector3(...plane.up),
      new Vector3(...plane.normal),
    ),
  );
  glow.visible = false;
  return { mask, glow };
}

const tracked = view === 'dock' ? { right: trackedObject(1), left: trackedObject(-1) } : null;

/** Puts a tracked object behind the column's place on the right, the left, both or neither. */
function setBlock(next: Block): void {
  block = next;
  if (!tracked) return;
  const masks: Placement[] = [];
  for (const side of ['right', 'left'] as const) {
    const on = next === side || next === 'both';
    tracked[side].glow.visible = on;
    if (on) masks.push(tracked[side].mask);
  }
  ctx.objectMasks = masks;
}

function setupDock(): void {
  scene.add(card.object, dock.object);
  if (tracked) scene.add(tracked.right.glow, tracked.left.glow);
  setBlock(block);
  ctx.snapshot.instruction = STEPS[cardText];
  if (!board) snapshot = { rev: 1, widgets: dockWidgets() };
  // Look ahead and down at card and dock, as a head reading the card would.
  camera.position.copy(EYE);
  perspective.rotation.order = 'YXZ';
  perspective.rotation.x = (-15 * Math.PI) / 180;
  perspective.fov = px ? 30 : 46;
  aimAtDock();
}

/**
 * The ?px= view is 40 degrees wide: it turns to show the whole column and as much of the card as
 * fits beside it. Without ?px= it looks straight ahead, wide enough for either side.
 */
function aimAtDock(): void {
  if (view !== 'dock' || orbit) return;
  if (!px) {
    perspective.rotation.y = 0;
    return;
  }
  const at = card.object.position;
  const cardYaw = (Math.atan2(at.x - EYE.x, EYE.z - at.z) * 180) / Math.PI;
  const side = dock.side;
  const spans = angularBounds(side, card.panelWidth);
  const left = cardYaw + Math.min(spans.card.left, spans.dock.left);
  const right = cardYaw + Math.max(spans.card.right, spans.dock.right);
  const half = PX_FOV_H / 2 - 1;
  const middle = (left + right) / 2;
  const center =
    side === 1
      ? Math.max(middle, cardYaw + spans.dock.right - half)
      : Math.min(middle, cardYaw + spans.dock.left + half);
  perspective.rotation.y = (-center * Math.PI) / 180;
}

// ---- every fixture face-on ---------------------------------------------------------------------

const gridFaces: { face: Face; fixture: WidgetFixture }[] = [];
const grid = new Group();

function setupGrid(): void {
  scene.add(grid);
  const selected = selectFixtures(fixtures, state, kinds);
  const pre = T0 + (PREROLL[0] ?? -1500);
  for (const fixture of selected) {
    const face =
      fixture.state === 'collapsed'
        ? new PillFace(troikaText, fixture.kind)
        : createCard(fixture.widget, troikaText);
    face.set(fixture.widget, pre);
    face.setOrders(DOCK_ORDERS, 0);
    if (fixture.touch) face.setTouch(fixture.touch.index, fixture.touch.look, T0 - 300);
    grid.add(face.object);
    gridFaces.push({ face, fixture });
  }
  layoutGrid();
}

/** Columns that fit the window best; cards top-aligned per row, a caption under each. */
function layoutGrid(): void {
  const cellW = 0.18 + 0.04;
  const captionH = 0.016;
  const n = gridFaces.length;
  if (n === 0) return;
  const aspect = innerWidth / Math.max(1, innerHeight);
  let best = { cols: 1, scale: 0, w: 0, h: 0, rows: [] as number[] };
  for (let cols = 1; cols <= n; cols++) {
    const rows: number[] = [];
    for (let i = 0; i < n; i += cols) {
      let h = 0;
      for (let j = i; j < Math.min(n, i + cols); j++)
        h = Math.max(h, gridFaces[j]?.face.height ?? 0);
      rows.push(h + captionH + 0.03);
    }
    const w = cols * cellW;
    const h = rows.reduce((a, b) => a + b, 0) + 0.05;
    const scale = Math.min(aspect / w, 1 / h);
    if (scale > best.scale) best = { cols, scale, w, h, rows };
  }
  let y = -0.05;
  for (const [r, rowH] of best.rows.entries()) {
    for (let c = 0; c < best.cols; c++) {
      const item = gridFaces[r * best.cols + c];
      if (!item) continue;
      item.face.object.position.set(c * cellW + 0.02, y, 0);
      if (!captionTags.some((tag) => tag.at === item.face.object)) {
        caption(item.fixture.name, item.face.object, new Vector3(0, -item.face.height - 0.004, 0));
      }
    }
    y -= rowH;
  }
  grid.position.set(-best.w / 2, best.h / 2, -0.65);
  // The view fits the grid both ways: a wide grid sets the height, as a tall one does.
  const halfH = Math.max(best.h, best.w / aspect) / 2 + 0.01;
  ortho.top = halfH;
  ortho.bottom = -halfH;
  ortho.left = -halfH * aspect;
  ortho.right = halfH * aspect;
  ortho.position.set(0, 0, 0);
  ortho.updateProjectionMatrix();
}

// ---- timer chips beside stand-in objects -------------------------------------------------------

function setupChips(): void {
  scene.add(workspace);
  workspace.add(chips.object);
  const table = new Mesh(new PlaneGeometry(1.2, 1.4), new MeshLambertMaterial({ color: 0xd9dee5 }));
  table.rotation.x = -Math.PI / 2;
  table.position.set(0, 0.86, -0.75);
  workspace.add(table);
  const spots: [string, number, number][] = [
    ['cup_a', -0.1, 0.5],
    ['cup_b', 0.02, 0.8],
    ['cup_c', 0.14, 1.1],
  ];
  const widgets: Widget[] = [];
  for (const [i, [id, x, d]] of spots.entries()) {
    const cup = new Mesh(
      new CylinderGeometry(0.03, 0.026, 0.08, 32),
      new MeshLambertMaterial({ color: 0x8a94a4 }),
    );
    cup.position.set(x, 0.9, -d);
    workspace.add(cup);
    caption(`${d} m`, cup, new Vector3(-0.1, -0.03, 0));
    objects.push({
      id,
      spec: { id, label: id, radius: 0.03 },
      position: [x, 0.9, -d],
      orientation: null,
      confidence: 1,
      source: 'layout',
      t: T0 - 5000,
      heldBy: null,
    } as unknown as ObjectEstimate);
    widgets.push(
      timer(T0, {
        id: i === 0 ? 'timer' : `timer-${i + 1}`,
        seq: i + 1,
        objectId: id,
        label: ['Glue sets', 'Mixture thickens', 'Paint dries'][i] ?? 'Timer',
        ...(i === 2 ? { left: -2000, status: 'done', doneT: T0 - 2000, closeAt: T0 + 8000 } : {}),
      }),
    );
  }
  if (!board) snapshot = { rev: 1, widgets };
  camera.position.copy(EYE);
  perspective.rotation.order = 'YXZ';
  perspective.rotation.x = (-40 * Math.PI) / 180;
  perspective.fov = 46;
}

// ---- a fake fingertip --------------------------------------------------------------------------

const TIP = jointOffset('index-finger-tip');
const DISTAL = jointOffset('index-finger-phalanx-distal');
const INTERMEDIATE = jointOffset('index-finger-phalanx-intermediate');
const tipWorld = new Vector3();

/** A right hand whose index fingertip is `z` in front of target (widgetId, index), or null. */
function fingertip(at: { widgetId: string; index: number } | null, z: number): HandSample | null {
  if (!at) return null;
  const target = dock.targets.find((h) => h.widgetId === at.widgetId && h.index === at.index);
  if (!target) return null;
  dock.column.updateWorldMatrix(true, false);
  const joints = new Array<number>(HAND_SAMPLE_LENGTH).fill(0);
  const put = (offset: number, dy: number, dz: number) => {
    tipWorld.set(target.cx, target.cy + dy, z + dz);
    dock.column.localToWorld(tipWorld);
    joints[offset] = tipWorld.x;
    joints[offset + 1] = tipWorld.y;
    joints[offset + 2] = tipWorld.z;
    joints[offset + 6] = 1;
  };
  put(TIP, 0, 0);
  put(DISTAL, -0.012, 0.018);
  put(INTERMEDIATE, -0.024, 0.036);
  return { joints, pinch: 0.08 };
}

// ---- frames ------------------------------------------------------------------------------------

/** A frozen clock's pre-roll has run (see preroll below). */
let prerolled = false;

/** One frame of the presenters; `withCard` false for the pre-roll, which goes back in time. */
function update(t: number, dt: number, finger: HandSample | null, withCard = true): void {
  ctx.t = t;
  ctx.dt = dt;
  ctx.hands = finger ? { t, head: ctx.head, left: null, right: finger } : null;
  if (board) {
    clock.set(t);
    board.tick(t);
  }
  if (view === 'dock') {
    if (withCard) card.update(ctx);
    // A frozen clock holds the dock until the card's text is laid out and its pre-roll has run.
    if (frozen === null || prerolled) dock.update(ctx);
    aimAtDock();
  }
  if (view === 'chip') chips.update(ctx);
  if (view === 'grid') for (const { face } of gridFaces) face.frame(t, 1);
}

function fingerFor(t: number): HandSample | null {
  if (touchAt) return fingertip(touchAt, t >= T0 - 300 ? 0 : 0.03);
  if (nearAt) return fingertip(nearAt, 0.03);
  return null;
}

/** ?orbit=1: the eye swings +-10 deg about the column, looking the same way relative to it. */
const ORBIT_PIVOT = new Vector3(0.2, EYE.y - 0.25, -0.6);
const UP = new Vector3(0, 1, 0);
const swing = new Quaternion();
let baseQuaternion: Quaternion | null = null;
function placeCamera(): void {
  if (!orbit || view === 'grid') return;
  baseQuaternion ??= camera.quaternion.clone();
  const yaw =
    ((10 * Math.PI) / 180) * Math.sin(((performance.now() - wallStart) / 6000) * 2 * Math.PI);
  swing.setFromAxisAngle(UP, yaw);
  camera.position.copy(EYE).sub(ORBIT_PIVOT).applyQuaternion(swing).add(ORBIT_PIVOT);
  camera.quaternion.copy(swing).multiply(baseQuaternion);
  ctx.head.p = [camera.position.x, camera.position.y, camera.position.z];
}

function resize(): void {
  const w = innerWidth;
  const h = innerHeight;
  if (px && view !== 'grid') {
    // 1 degree is `px` pixels at the centre, drawn 2x with nearest-neighbour: what Quest 3 shows.
    const fovH = PX_FOV_H;
    const fovV = perspective.fov;
    const cw = Math.round(fovH * px);
    const ch = Math.round(fovV * px);
    perspective.aspect =
      Math.tan(((fovH / 2) * Math.PI) / 180) / Math.tan(((fovV / 2) * Math.PI) / 180);
    renderer.setSize(cw, ch, false);
    renderer.domElement.style.width = `${cw * 2}px`;
    renderer.domElement.style.height = `${ch * 2}px`;
  } else if (px) {
    // True size: 1 mm at 0.65 m covers what it does on Quest 3, drawn 2x with nearest-neighbour.
    layoutGrid();
    const cw = Math.round((ortho.right - ortho.left) * pxPerMetre(px));
    const ch = Math.round((ortho.top - ortho.bottom) * pxPerMetre(px));
    renderer.setSize(cw, ch, false);
    renderer.domElement.style.width = `${cw * 2}px`;
    renderer.domElement.style.height = `${ch * 2}px`;
  } else {
    renderer.setSize(w, h);
    perspective.aspect = w / Math.max(1, h);
  }
  perspective.updateProjectionMatrix();
  if (view === 'grid') layoutGrid();
  // Fill the view with the backdrop at its 1.2 m.
  if (camera === perspective) {
    const bh = 2 * 1.2 * Math.tan(((perspective.fov / 2) * Math.PI) / 180) * 1.1;
    backdrop.scale.set(bh * perspective.aspect, bh, 1);
  } else {
    backdrop.scale.set((ortho.right - ortho.left) * 1.1, (ortho.top - ortho.bottom) * 1.1, 1);
  }
}

const projected = new Vector3();
function placeCaptions(): void {
  const rect = renderer.domElement.getBoundingClientRect();
  for (const tag of captionTags) {
    projected.copy(tag.offset);
    tag.at.localToWorld(projected);
    projected.project(camera);
    tag.el.style.left = `${rect.left + ((projected.x + 1) / 2) * rect.width}px`;
    tag.el.style.top = `${rect.top + ((1 - projected.y) / 2) * rect.height}px`;
  }
}

function allReady(): boolean {
  if (view === 'dock') return card.object.visible && dock.ready;
  if (view === 'chip') return chips.ready;
  return gridFaces.every(({ face }) => face.ready);
}

// ---- controls ----------------------------------------------------------------------------------

const controls = document.querySelector('#controls') as HTMLElement;
function group(): HTMLElement {
  const g = document.createElement('div');
  g.className = 'group';
  controls.append(g);
  return g;
}
function button(parent: HTMLElement, text: string, onClick: () => void, pressed?: boolean) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = text;
  b.onclick = onClick;
  if (pressed !== undefined) b.setAttribute('aria-pressed', String(pressed));
  parent.append(b);
  return b;
}
function reload(key: string, value: string | null): void {
  const next = new URLSearchParams(location.search);
  if (value === null) next.delete(key);
  else next.set(key, value);
  location.search = next.toString();
}

const views = group();
for (const v of ['dock', 'grid', 'chip'] as const) {
  button(views, v[0]?.toUpperCase() + v.slice(1), () => reload('view', v), view === v);
}
const states = group();
for (const s of [...FIXTURE_STATES, 'all'] as const) {
  button(states, s, () => reload('state', s), state === s);
}
const kindButtons = group();
for (const k of WIDGET_KINDS) {
  const on = kinds.includes(k);
  button(
    kindButtons,
    k,
    () => {
      const next = on ? kinds.filter((x) => x !== k) : [...kinds, k];
      reload('kinds', next.length ? next.join(',') : null);
    },
    on,
  );
}
const backgrounds = group();
for (const b of ['photo', 'bright', 'dark'] as const) {
  button(backgrounds, b, () => reload('bg', b), background === b);
}
if (view === 'dock') {
  const cards = group();
  for (const c of ['short', 'long'] as const) {
    button(cards, `${c} step`, () => reload('card', c), cardText === c);
  }
  // Live, without a reload, so the column can be seen changing sides.
  const blocks = group();
  const blockButtons: HTMLButtonElement[] = [];
  const labels: Record<Block, string> = {
    none: 'no object',
    right: 'object right',
    left: 'object left',
    both: 'objects both sides',
  };
  for (const b of ['none', 'right', 'left', 'both'] as const) {
    const el = button(
      blocks,
      labels[b],
      () => {
        setBlock(b);
        for (const other of blockButtons) other.setAttribute('aria-pressed', 'false');
        el.setAttribute('aria-pressed', 'true');
        const next = new URLSearchParams(location.search);
        if (b === 'none') next.delete('block');
        else next.set('block', b);
        history.replaceState(null, '', `?${next.toString()}`);
      },
      block === b,
    );
    blockButtons.push(el);
  }
}
const tools = group();
button(tools, 'Measure', () => measure());
if (board) {
  const handlers = board.handlers();
  const samples: [keyof typeof handlers, Record<string, unknown>][] = [
    ['show_timer', { seconds: 120, label: 'Glue sets' }],
    ['show_progress', { label: 'Screws out', value: 2, total: 4 }],
    [
      'show_checklist',
      { title: 'Gather', items: ['Funnel', 'Rag', 'Washer fluid'], done: ['Funnel'] },
    ],
    ['show_choices', { question: 'Which screwdriver do you have?', options: ['Phillips', 'Flat'] }],
    ['show_value', { label: 'Torque', value: '25 N m' }],
    ['show_caution', { text: 'The pan stays hot for 10 minutes' }],
    ['clear_widget', { widget_id: 'all' }],
  ];
  const liveTools = group();
  for (const [name, args] of samples) {
    button(liveTools, name, () => {
      const handler = handlers[name] as (a: unknown, call: { callId: string }) => unknown;
      clock.set(now());
      const outcome = handler(args, { callId: `preview-${name}` });
      status.textContent = JSON.stringify(outcome);
    });
  }
}

/** window.__cost: the median dock update with three widgets (ms), and this frame's draw calls. */
function measure(): void {
  const t0 = T0;
  const trial = new WidgetDockPresenter({
    source: () => measured,
    onIntent: () => {},
    anchor: card,
  });
  const measured: WidgetSnapshot = {
    rev: 1,
    widgets: fixtures
      .filter((f) => f.state === 'running' && f.kind !== 'choices')
      .filter((f, i, all) => all.findIndex((g) => g.kind === f.kind) === i)
      .slice(0, 3)
      .map((f) => f.widget),
  };
  const trialCtx: PresentContext = { ...ctx, hands: null };
  for (let i = 0; i < 20; i++) {
    trialCtx.t = t0 + i * 16;
    trialCtx.dt = 16;
    trial.update(trialCtx);
  }
  const runs: number[] = [];
  for (let k = 0; k < 10; k++) {
    const start = performance.now();
    for (let i = 0; i < 20; i++) {
      trialCtx.t += 16;
      trial.update(trialCtx);
    }
    runs.push((performance.now() - start) / 20);
  }
  trial.dispose();
  runs.sort((a, b) => a - b);
  renderer.render(scene, camera);
  const cost = {
    updateMs: runs[Math.floor(runs.length / 2)] ?? 0,
    calls: renderer.info.render.calls,
  };
  window.__cost = cost;
  status.textContent = `update ${cost.updateMs.toFixed(3)} ms, ${cost.calls} draw calls`;
}

// ---- start -------------------------------------------------------------------------------------

if (view === 'dock') setupDock();
else if (view === 'grid') setupGrid();
else setupChips();
addEventListener('resize', resize);
resize();

let resolveReady: () => void = () => {};
const ready = new Promise<void>((resolve) => {
  resolveReady = resolve;
});
let fontsLoaded = false;
preloadWidgetFonts().then(() => {
  fontsLoaded = true;
});

window.__preview = {
  ready,
  set(widgets) {
    snapshot = { rev: snapshot.rev + 1, widgets: [...widgets] };
  },
  probe(x, y) {
    renderer.render(scene, camera);
    const canvas = renderer.domElement;
    const rect = canvas.getBoundingClientRect();
    const gl = renderer.getContext();
    const bx = Math.floor(((x - rect.left) / rect.width) * gl.drawingBufferWidth);
    const by = Math.floor((1 - (y - rect.top) / rect.height) * gl.drawingBufferHeight);
    const out = new Uint8Array(4);
    gl.readPixels(bx, by, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return [out[0] ?? 0, out[1] ?? 0, out[2] ?? 0];
  },
};

// Pre-roll a frozen clock so enter motion, done states and an armed fingertip have settled by t:
// once the step card shows (its text lays out in a worker), and at once in the other views.
function preroll(): void {
  if (prerolled || frozen === null || (view === 'dock' && !card.object.visible)) return;
  prerolled = true;
  for (const offset of PREROLL) update(T0 + offset, 0, fingerFor(T0 + offset), false);
}
let readyFrames = 0;
let lastWall = performance.now();
renderer.setAnimationLoop(() => {
  const wall = performance.now();
  const t = now();
  const dt = frozen !== null ? 0 : Math.min(100, wall - lastWall);
  lastWall = wall;
  placeCamera();
  preroll();
  update(t, dt, fingerFor(t));
  renderer.render(scene, camera);
  placeCaptions();
  if (fontsLoaded && allReady()) {
    readyFrames++;
    if (readyFrames === 2) resolveReady();
  } else {
    readyFrames = 0;
  }
  if (!status.textContent) status.textContent = `t ${Math.round(t)} ms`;
});

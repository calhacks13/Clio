import {
  Color,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  SRGBColorSpace,
  TextureLoader,
  WebGLRenderer,
} from 'three';
import type { PresentContext } from '../adapters/render/presenter';
import { InstructionPanelPresenter } from '../adapters/render/presenters/instruction-panel';
import type { Pose } from '../core/math';
import type { PanelState } from './states';

// The in-headset instruction panel, one card per state: the real presenter, fed a fixed head pose
// and the state's snapshot every animation frame (ctx.t moves its animated parts). Browsers cap
// WebGL contexts, so one renderer draws every visible card in turn and each card copies the
// result into its own 2D canvas. Behind the panel, the demo photo dimmed to about 60% stands in
// for passthrough.

/** The panel's width in metres (instruction-panel.ts W). */
const PANEL_WIDTH = 0.44;
/** Share of the card's width the panel fills; the rest shows the room and any overflowing text. */
const FILL = 0.78;
const FOV = 40;
const BACKDROP_BEHIND = 0.8;
const BACKDROP = '/demo/caliper.jpg';
const HEAD: Pose = { p: [0, 1.6, 0], q: [0, 0, 0, 1] };
const WORKSPACE: Pose = { p: [0, 0, 0], q: [0, 0, 0, 1] };

interface Card {
  state: PanelState;
  presenter: InstructionPanelPresenter;
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  visible: boolean;
}

export function mountPanelCards(grid: HTMLElement, states: readonly PanelState[]): void {
  const renderer = new WebGLRenderer({ antialias: true });
  const scene = new Scene();
  scene.background = new Color(0x15181d);
  const camera = new PerspectiveCamera(FOV, 2, 0.01, 10);
  const backdrop = new Mesh(
    new PlaneGeometry(1, 1),
    new MeshBasicMaterial({ color: 0x999999, depthWrite: false }),
  );
  backdrop.renderOrder = -1;
  backdrop.visible = false;
  scene.add(backdrop);
  let photoAspect = 1;
  new TextureLoader().load(BACKDROP, (texture) => {
    texture.colorSpace = SRGBColorSpace;
    backdrop.material.map = texture;
    backdrop.material.needsUpdate = true;
    photoAspect = texture.image.width / texture.image.height;
    backdrop.visible = true;
    resize();
  });

  const cards: Card[] = states.map((state) => {
    const figure = document.createElement('figure');
    figure.className = 'card';
    const canvas = document.createElement('canvas');
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', state.name);
    const caption = document.createElement('figcaption');
    caption.textContent = state.name;
    figure.append(canvas, caption);
    grid.append(figure);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('No 2D canvas context');
    // The Done button is touched by a fingertip; no hands here, so it never fires.
    return {
      state,
      presenter: new InstructionPanelPresenter(() => {}),
      canvas,
      context,
      visible: false,
    };
  });

  const seen = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const card = cards.find((c) => c.canvas === entry.target);
      if (card) card.visible = entry.isIntersecting;
    }
  });
  for (const card of cards) seen.observe(card.canvas);

  let distance = 1;
  function resize(): void {
    const first = cards[0]?.canvas;
    if (!first) return;
    const ratio = Math.min(window.devicePixelRatio, 2);
    const width = Math.max(1, Math.round(first.clientWidth * ratio));
    const height = Math.max(1, Math.round(first.clientHeight * ratio));
    renderer.setSize(width, height, false);
    for (const card of cards) {
      card.canvas.width = width;
      card.canvas.height = height;
    }
    const aspect = width / height;
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
    const tan = Math.tan(((FOV / 2) * Math.PI) / 180);
    distance = PANEL_WIDTH / FILL / aspect / 2 / tan;
    // Cover the view behind the panel with the photo, like object-fit: cover.
    const viewHeight = 2 * (distance + BACKDROP_BEHIND) * tan;
    const viewWidth = viewHeight * aspect;
    const wider = aspect > photoAspect;
    backdrop.scale.set(
      wider ? viewWidth : viewHeight * photoAspect,
      wider ? viewWidth / photoAspect : viewHeight,
      1,
    );
  }
  new ResizeObserver(resize).observe(grid);
  resize();

  const draw = (card: Card, t: number, dt: number) => {
    const ctx: PresentContext = {
      t,
      dt,
      snapshot: card.state.snapshot,
      procedure: null,
      objects: [],
      demo: null,
      demoHands: null,
      hands: null,
      head: HEAD,
      worldFromWorkspace: WORKSPACE,
      calibration: card.state.calibration ?? null,
      debug: false,
    };
    scene.add(card.presenter.object);
    card.presenter.update(ctx);
    // The panel settles in front of the head, facing it; look straight at it.
    const at = card.presenter.object.position;
    camera.position.set(at.x, at.y, at.z + distance);
    camera.lookAt(at);
    backdrop.position.set(at.x, at.y, at.z - BACKDROP_BEHIND);
    renderer.render(scene, camera);
    scene.remove(card.presenter.object);
    card.context.drawImage(renderer.domElement, 0, 0);
  };

  let last = performance.now();
  const frame = (t: number) => {
    const dt = Math.min(100, Math.max(0, t - last));
    last = t;
    for (const card of cards) if (card.visible) draw(card, t, dt);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

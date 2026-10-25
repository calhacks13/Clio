import { HAND_SAMPLE_LENGTH, jointOffset } from '@clio/protocol';
import {
  Color,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  SRGBColorSpace,
  TextureLoader,
  Vector3,
  WebGLRenderer,
} from 'three';
import { ObjectHighlight } from '../adapters/render/object-highlight';
import type { PresentContext } from '../adapters/render/presenter';
import {
  InstructionPanelPresenter,
  PANEL_TOP,
} from '../adapters/render/presenters/instruction-panel';
import type { Pose, Vec3 } from '../core/math';
import type { TrackedFrame } from '../domain/hands/types';
import { billboard, outlinePoint } from '../domain/world/outline';
import type { Placement } from '../domain/world/placement';
import { CALIPER_OUTLINE, CALIPER_PHOTO_HEIGHT, CALIPER_PHOTO_WIDTH } from './caliper-outline';
import type { PanelState } from './states';

// One real instruction presenter per state, with the saved caliper segmentation as an obstacle.
// The photo and its exact mask share a plane, so the gallery shows genuine clearance instead of
// putting a centred card over an unrelated background. A single renderer serves visible cards.

const HEAD: Pose = { p: [0, 1.6, 0], q: [0, 0, 0, 1] };
const WORKSPACE: Pose = { p: [0, 0, 0], q: [0, 0, 0, 1] };
const FRAME_PADDING = 1.1;

interface Card {
  state: PanelState;
  presenter: InstructionPanelPresenter;
  mask: Placement;
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  visible: boolean;
}

/** The original photo silhouette, upright and facing the learner as in the production renderer. */
function caliperAt(center: Vec3): Placement {
  const plane = billboard(center, HEAD.p);
  if (!plane) throw new Error('Caliper preview is at the eye');
  return {
    center,
    outline: CALIPER_OUTLINE,
    points: CALIPER_OUTLINE.points.map((point) => outlinePoint(plane, center, point)),
    label: outlinePoint(plane, center, [0, 0.095]),
    depth: 'fixed',
  };
}

/** A left hand whose index fingertip is at `tip` (the gallery's workspace is the world). */
function fingertipAt(tip: Vector3, t: number): TrackedFrame {
  const joints = new Array<number>(HAND_SAMPLE_LENGTH).fill(0);
  joints.splice(jointOffset('index-finger-tip'), 3, tip.x, tip.y, tip.z);
  return { t, head: HEAD, left: { joints, pinch: 0.03 }, right: null };
}

export function mountPanelCards(grid: HTMLElement, states: readonly PanelState[]): void {
  const renderer = new WebGLRenderer({ antialias: true });
  const scene = new Scene();
  scene.background = new Color(0x15181d);
  const camera = new PerspectiveCamera(40, 1.6, 0.01, 10);
  camera.position.set(...HEAD.p);
  const backdrop = new Mesh(
    new PlaneGeometry(CALIPER_PHOTO_WIDTH, CALIPER_PHOTO_HEIGHT),
    new MeshBasicMaterial({ depthWrite: false }),
  );
  backdrop.renderOrder = -1;
  backdrop.visible = false;
  scene.add(backdrop);
  new TextureLoader().load('/demo/caliper.jpg', (texture) => {
    texture.colorSpace = SRGBColorSpace;
    backdrop.material.map = texture;
    backdrop.material.needsUpdate = true;
    backdrop.visible = true;
  });
  const glow = new ObjectHighlight();
  glow.setOutline(CALIPER_OUTLINE, 'object');
  scene.add(glow);

  const cards: Card[] = states.map((state, index) => {
    const figure = document.createElement('figure');
    figure.className = 'card';
    figure.id = `panel-${state.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    const canvas = document.createElement('canvas');
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', `${state.name}, lesson card beside the highlighted object`);
    const caption = document.createElement('figcaption');
    caption.textContent = state.name;
    figure.append(canvas, caption);
    grid.append(figure);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('No 2D canvas context');
    // Alternate the task's place in view to exercise clear placements on either side.
    const mask = caliperAt([index % 2 === 0 ? -0.12 : 0.12, 1.48, -0.65]);
    return {
      state,
      presenter: new InstructionPanelPresenter(
        () => {},
        () => {},
      ),
      mask,
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

  let aspect = 1.6;
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
    aspect = width / height;
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(grid);
  resize();

  const basis = new Matrix4();
  const right = new Vector3();
  const up = new Vector3();
  const normal = new Vector3();
  const point = new Vector3();
  const target = new Vector3();
  const min = new Vector3();
  const max = new Vector3();
  const panelCorners = Array.from({ length: 4 }, () => new Vector3());

  /** Keep the actual eye fixed and fit both the task and card, preserving their projection. */
  function frameCard(card: Card): void {
    const { presenter, mask } = card;
    presenter.object.updateMatrixWorld(true);
    const halfWidth = presenter.panelWidth / 2;
    const bottom = PANEL_TOP - presenter.panelHeight;
    panelCorners[0]?.set(-halfWidth, PANEL_TOP, 0).applyMatrix4(presenter.object.matrixWorld);
    panelCorners[1]?.set(halfWidth, PANEL_TOP, 0).applyMatrix4(presenter.object.matrixWorld);
    panelCorners[2]?.set(-halfWidth, bottom, 0).applyMatrix4(presenter.object.matrixWorld);
    panelCorners[3]?.set(halfWidth, bottom, 0).applyMatrix4(presenter.object.matrixWorld);
    min.set(Infinity, Infinity, Infinity);
    max.set(-Infinity, -Infinity, -Infinity);
    for (const corner of panelCorners) {
      min.min(corner);
      max.max(corner);
    }
    for (const vertex of mask.points) {
      point.set(...vertex);
      min.min(point);
      max.max(point);
    }
    target.addVectors(min, max).multiplyScalar(0.5);
    camera.lookAt(target);
    camera.updateMatrixWorld(true);
    let tan = 0;
    for (const corner of panelCorners) {
      point.copy(corner).applyMatrix4(camera.matrixWorldInverse);
      tan = Math.max(tan, Math.abs(point.y / point.z), Math.abs(point.x / point.z) / aspect);
    }
    for (const vertex of mask.points) {
      point.set(...vertex).applyMatrix4(camera.matrixWorldInverse);
      tan = Math.max(tan, Math.abs(point.y / point.z), Math.abs(point.x / point.z) / aspect);
    }
    camera.fov = (2 * Math.atan(tan * FRAME_PADDING) * 180) / Math.PI;
    camera.updateProjectionMatrix();
  }

  const draw = (card: Card, t: number, dt: number) => {
    const ctx: PresentContext = {
      t,
      dt,
      snapshot: card.state.snapshot,
      procedure: null,
      objects: [],
      objectMasks: [card.mask],
      demo: null,
      demoHands: null,
      hands: null,
      head: HEAD,
      worldFromWorkspace: WORKSPACE,
      calibration: card.state.calibration ?? null,
      debug: false,
    };
    // A fingertip comes onto the close button whenever it is not armed: one touch, never two.
    if (card.state.closeArmed && !card.presenter.closeButton.armed) {
      ctx.hands = fingertipAt(card.presenter.closeButtonAt(point), t);
    }
    scene.add(card.presenter.object);
    card.presenter.update(ctx);
    const plane = billboard(card.mask.center, HEAD.p);
    if (plane) {
      basis.makeBasis(right.set(...plane.right), up.set(...plane.up), normal.set(...plane.normal));
      backdrop.quaternion.setFromRotationMatrix(basis);
      glow.quaternion.copy(backdrop.quaternion);
    }
    backdrop.position.set(...card.mask.center);
    glow.position.copy(backdrop.position);
    frameCard(card);
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

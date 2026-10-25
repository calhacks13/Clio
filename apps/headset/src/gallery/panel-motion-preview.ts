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
import { InstructionPanelPresenter } from '../adapters/render/presenters/instruction-panel';
import { type Pose, quatFromAxisAngle, type Vec3 } from '../core/math';
import { billboard, outlinePoint } from '../domain/world/outline';
import type { Placement } from '../domain/world/placement';
import { CALIPER_OUTLINE, CALIPER_PHOTO_HEIGHT, CALIPER_PHOTO_WIDTH } from './caliper-outline';
import { PANEL_STATES } from './states';

// This developer preview deliberately never frames or follows the card with its camera.
// Only the simulated head moves. The real presenter decides when its world anchor should hold
// or catch up, using exactly the same frame context and object silhouette as the headset.
const HEAD_POSITION: Vec3 = [0, 1.6, 0];
const TASK_CENTER: Vec3 = [-0.1, 1.48, -0.85];
const IDENTITY: Pose = { p: [0, 0, 0], q: [0, 0, 0, 1] };
const REPLAY_DURATION_MS = 7700;

export function mountPanelMotionPreview(host: HTMLElement): void {
  host.classList.add('panel-motion');
  host.innerHTML = `
    <h3 id="panel-motion-title">Head movement</h3>
    <canvas aria-label="Fixed room view with a lesson card beside a highlighted caliper" role="img"></canvas>
    <div class="panel-motion-controls">
      <label for="panel-motion-direction">View direction <output id="panel-motion-angle" for="panel-motion-direction">0°</output></label>
      <input id="panel-motion-direction" type="range" min="-65" max="65" step="1" value="0">
      <div class="panel-motion-actions">
        <button type="button" data-motion-action="replay">Replay head movement</button>
        <button type="button" data-motion-action="reset">Reset preview</button>
      </div>
      <p class="panel-motion-note" hidden>Reduced motion is enabled. Use View direction to inspect a fixed view.</p>
      <p class="panel-motion-status" role="status" aria-live="polite"></p>
    </div>`;
  const required = <T extends Element>(selector: string): T => {
    const element = host.querySelector<T>(selector);
    if (!element) throw new Error(`Panel motion preview has no ${selector}`);
    return element;
  };
  const canvas = required<HTMLCanvasElement>('canvas');
  const slider = required<HTMLInputElement>('#panel-motion-direction');
  const output = required<HTMLOutputElement>('#panel-motion-angle');
  const replayButton = required<HTMLButtonElement>('[data-motion-action="replay"]');
  const resetButton = required<HTMLButtonElement>('[data-motion-action="reset"]');
  const note = required<HTMLElement>('.panel-motion-note');
  const status = required<HTMLElement>('.panel-motion-status');
  const snapshot = PANEL_STATES.find((state) => state.name === 'Ready')?.snapshot;
  if (!snapshot) {
    throw new Error('Incomplete panel motion preview');
  }

  const renderer = new WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  const scene = new Scene();
  scene.background = new Color(0x15181d);
  const camera = new PerspectiveCamera(58, 16 / 9, 0.01, 10);
  const head: Pose = { p: [...HEAD_POSITION], q: [0, 0, 0, 1] };
  camera.position.set(...head.p);
  const plane = billboard(TASK_CENTER, HEAD_POSITION);
  if (!plane) throw new Error('Preview task is at the eye');
  const mask: Placement = {
    center: TASK_CENTER,
    outline: CALIPER_OUTLINE,
    points: CALIPER_OUTLINE.points.map((point) => outlinePoint(plane, TASK_CENTER, point)),
    label: outlinePoint(plane, TASK_CENTER, [0, 0.095]),
    depth: 'fixed',
  };
  const basis = new Matrix4().makeBasis(
    new Vector3(...plane.right),
    new Vector3(...plane.up),
    new Vector3(...plane.normal),
  );
  const backdrop = new Mesh(
    new PlaneGeometry(CALIPER_PHOTO_WIDTH, CALIPER_PHOTO_HEIGHT),
    new MeshBasicMaterial({ depthWrite: false }),
  );
  backdrop.position.set(...TASK_CENTER);
  backdrop.quaternion.setFromRotationMatrix(basis);
  backdrop.renderOrder = -1;
  backdrop.visible = false;
  scene.add(backdrop);
  const glow = new ObjectHighlight();
  glow.setOutline(CALIPER_OUTLINE, 'object');
  glow.position.copy(backdrop.position);
  glow.quaternion.copy(backdrop.quaternion);
  scene.add(glow);
  let disposed = false;
  new TextureLoader().load('/demo/caliper.jpg', (texture) => {
    if (disposed) {
      texture.dispose();
      return;
    }
    texture.colorSpace = SRGBColorSpace;
    backdrop.material.map = texture;
    backdrop.material.needsUpdate = true;
    backdrop.visible = true;
  });

  let presenter = new InstructionPanelPresenter(() => {});
  scene.add(presenter.object);
  const context: PresentContext = {
    t: performance.now(),
    dt: 0,
    snapshot,
    procedure: null,
    objects: [],
    objectMasks: [mask],
    demo: null,
    demoHands: null,
    hands: null,
    head,
    worldFromWorkspace: IDENTITY,
    calibration: null,
    debug: false,
  };
  let yaw = 0;
  let targetYaw = 0;
  let replayElapsed: number | null = null;
  let replaySide: number | null = null;
  let visible = false;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  function stopReplay(message = ''): void {
    replayElapsed = null;
    replaySide = null;
    replayButton.textContent = 'Replay head movement';
    status.textContent = message;
  }

  function setDirection(value: number): void {
    targetYaw = value;
    slider.value = String(Math.round(value));
    output.value = `${Math.round(value)}°`;
  }

  function reset(): void {
    stopReplay('Preview reset.');
    yaw = 0;
    head.q = [0, 0, 0, 1];
    setDirection(0);
    scene.remove(presenter.object);
    presenter.dispose();
    presenter = new InstructionPanelPresenter(() => {});
    scene.add(presenter.object);
  }

  slider.addEventListener('input', () => {
    stopReplay();
    setDirection(slider.valueAsNumber);
  });
  replayButton.addEventListener('click', () => {
    if (reducedMotion.matches) return;
    if (replayElapsed !== null) {
      stopReplay('Replay stopped.');
      return;
    }
    reset();
    replayElapsed = 0;
    replayButton.textContent = 'Stop replay';
    status.textContent = 'Replaying a brief look, then holding a larger head turn.';
  });
  resetButton.addEventListener('click', reset);

  function motionPreference(): void {
    replayButton.disabled = reducedMotion.matches;
    note.hidden = !reducedMotion.matches;
    if (reducedMotion.matches) {
      stopReplay();
      yaw = targetYaw;
    }
  }
  reducedMotion.addEventListener('change', motionPreference);
  motionPreference();

  const seen = new IntersectionObserver(([entry]) => {
    visible = entry?.isIntersecting ?? false;
  });
  seen.observe(canvas);
  const resize = new ResizeObserver(() => {
    const width = Math.max(1, canvas.clientWidth);
    const height = Math.max(1, canvas.clientHeight);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  });
  resize.observe(canvas);

  let last = performance.now();
  let frameId = 0;
  const frame = (t: number) => {
    const dt = Math.min(100, Math.max(0, t - last));
    last = t;
    if (visible && !document.hidden) {
      if (replayElapsed !== null) {
        replayElapsed += dt;
        if (replayElapsed >= 400 && replaySide === null) {
          // Turn away from whichever side the real placer chose, guaranteeing a meaningful
          // out-of-view hold without changing the presenter's anchor or motion settings.
          replaySide = presenter.object.position.x >= head.p[0] ? 1 : -1;
        }
        const side = replaySide ?? 1;
        const angle =
          replayElapsed < 400
            ? 0
            : replayElapsed < 1300
              ? 20
              : replayElapsed < 2000
                ? 0
                : replayElapsed < 5500
                  ? 65
                  : 0;
        setDirection(angle * side);
        if (replayElapsed >= REPLAY_DURATION_MS) stopReplay('Replay complete.');
      }
      yaw = reducedMotion.matches ? targetYaw : yaw + (targetYaw - yaw) * (1 - Math.exp(-dt / 90));
      head.q = quatFromAxisAngle([0, 1, 0], (yaw * Math.PI) / 180);
      context.t = t;
      context.dt = dt;
      presenter.update(context);
      camera.position.set(...head.p);
      camera.quaternion.set(...head.q);
      renderer.render(scene, camera);
    }
    frameId = requestAnimationFrame(frame);
  };
  frameId = requestAnimationFrame(frame);
  window.addEventListener(
    'pagehide',
    (event) => {
      if (event.persisted) return;
      disposed = true;
      cancelAnimationFrame(frameId);
      seen.disconnect();
      resize.disconnect();
      reducedMotion.removeEventListener('change', motionPreference);
      presenter.dispose();
      glow.dispose();
      backdrop.geometry.dispose();
      backdrop.material.map?.dispose();
      backdrop.material.dispose();
      renderer.dispose();
    },
    { once: true },
  );
}

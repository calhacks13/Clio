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
import { type Pose, quatFromAxisAngle, quatMultiply, type Vec3 } from '../core/math';
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
      <div class="panel-motion-axes">
        <div>
          <label for="panel-motion-direction">View direction <output id="panel-motion-angle" for="panel-motion-direction">0°</output></label>
          <input id="panel-motion-direction" type="range" min="-65" max="65" step="1" value="0">
        </div>
        <div>
          <label for="panel-motion-pitch">Look up or down <output id="panel-motion-pitch-angle" for="panel-motion-pitch">0°</output></label>
          <input id="panel-motion-pitch" type="range" min="-40" max="40" step="1" value="0">
        </div>
        <div>
          <label for="panel-motion-roll">Head tilt <output id="panel-motion-roll-angle" for="panel-motion-roll">0°</output></label>
          <input id="panel-motion-roll" type="range" min="-30" max="30" step="1" value="0">
        </div>
      </div>
      <div class="panel-motion-actions">
        <button type="button" data-motion-action="replay">Replay head movement</button>
        <button type="button" data-motion-action="reset">Reset preview</button>
      </div>
      <p class="panel-motion-note" hidden>Reduced motion is enabled. Use the sliders to inspect a fixed view.</p>
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
  const pitchSlider = required<HTMLInputElement>('#panel-motion-pitch');
  const pitchOutput = required<HTMLOutputElement>('#panel-motion-pitch-angle');
  const rollSlider = required<HTMLInputElement>('#panel-motion-roll');
  const rollOutput = required<HTMLOutputElement>('#panel-motion-roll-angle');
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
  let pitch = 0;
  let targetPitch = 0;
  let roll = 0;
  let targetRoll = 0;
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

  function setPitch(value: number): void {
    targetPitch = value;
    pitchSlider.value = String(Math.round(value));
    pitchOutput.value = `${Math.round(value)}°`;
  }

  function setRoll(value: number): void {
    targetRoll = value;
    rollSlider.value = String(Math.round(value));
    rollOutput.value = `${Math.round(value)}°`;
  }

  function reset(): void {
    stopReplay('Preview reset.');
    yaw = 0;
    pitch = 0;
    roll = 0;
    head.q = [0, 0, 0, 1];
    setDirection(0);
    setPitch(0);
    setRoll(0);
    scene.remove(presenter.object);
    presenter.dispose();
    presenter = new InstructionPanelPresenter(() => {});
    scene.add(presenter.object);
  }

  slider.addEventListener('input', () => {
    stopReplay();
    setDirection(slider.valueAsNumber);
  });
  pitchSlider.addEventListener('input', () => {
    stopReplay();
    setPitch(pitchSlider.valueAsNumber);
  });
  rollSlider.addEventListener('input', () => {
    stopReplay();
    setRoll(rollSlider.valueAsNumber);
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
      pitch = targetPitch;
      roll = targetRoll;
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
      const blend = reducedMotion.matches ? 1 : 1 - Math.exp(-dt / 90);
      yaw += (targetYaw - yaw) * blend;
      pitch += (targetPitch - pitch) * blend;
      roll += (targetRoll - roll) * blend;
      // The simulated camera and presenter share the complete yaw * pitch * roll head pose.
      // The task remains fixed in world space; the presenter owns its horizon alignment.
      head.q = quatMultiply(
        quatMultiply(
          quatFromAxisAngle([0, 1, 0], (yaw * Math.PI) / 180),
          quatFromAxisAngle([1, 0, 0], (pitch * Math.PI) / 180),
        ),
        quatFromAxisAngle([0, 0, 1], (roll * Math.PI) / 180),
      );
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

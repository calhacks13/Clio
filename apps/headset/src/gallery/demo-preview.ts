import type { Action } from '@clio/protocol';
import {
  Color,
  CylinderGeometry,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { PresentContext } from '../adapters/render/presenter';
import { GhostHandsPresenter } from '../adapters/render/presenters/ghost-hands';
import { GlyphsPresenter } from '../adapters/render/presenters/glyphs';
import type { Vec3 } from '../core/math';
import { ClipPlayer } from '../domain/demo/clip-player';
import { synthesizeDemo } from '../domain/demo/synthesizer';

/** A local, synthetic tabletop using the production demonstrations and presenters. */
export function mountDemoPreview(host: HTMLElement): void {
  host.classList.add('demo-preview');
  const controls = document.createElement('div');
  controls.className = 'demo-controls';
  const label = document.createElement('label');
  label.textContent = 'Action ';
  const select = document.createElement('select');
  for (const [value, text] of [
    ['place', 'Move and place'],
    ['lift', 'Lift'],
    ['twist', 'Turn'],
    ['press', 'Press'],
    ['wipe', 'Wipe'],
    ['fold', 'Fold'],
  ]) {
    const option = document.createElement('option');
    option.value = value ?? '';
    option.textContent = text ?? '';
    select.append(option);
  }
  const play = document.createElement('button');
  play.type = 'button';
  play.textContent = 'Pause';
  const handLabel = document.createElement('label');
  const showHands = document.createElement('input');
  showHands.type = 'checkbox';
  showHands.checked = true;
  handLabel.append(showHands, ' Show hand');
  label.append(select);
  controls.append(label, play, handLabel);
  const viewport = document.createElement('div');
  viewport.className = 'demo-viewport';
  host.append(controls, viewport);

  const renderer = new WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.domElement.setAttribute('role', 'img');
  renderer.domElement.setAttribute(
    'aria-label',
    'Synthetic tabletop demonstration. Drag to orbit.',
  );
  viewport.append(renderer.domElement);
  const scene = new Scene();
  scene.background = new Color(0x26333e);
  scene.add(new HemisphereLight(0xffffff, 0x444466, 1.2));
  const sun = new DirectionalLight(0xffffff, 1);
  sun.position.set(0.5, 2, 1);
  scene.add(sun);
  const camera = new PerspectiveCamera(40, 1, 0.01, 10);
  camera.position.set(0.3, 0.5, 0.64);
  const orbit = new OrbitControls(camera, renderer.domElement);
  orbit.target.set(0, 0.13, 0);
  orbit.minDistance = 0.35;
  orbit.maxDistance = 1.8;
  orbit.maxPolarAngle = Math.PI * 0.48;
  orbit.update();
  const table = new Mesh(
    new PlaneGeometry(2, 2),
    new MeshStandardMaterial({ color: 0x46515a, roughness: 1 }),
  );
  table.rotation.x = -Math.PI / 2;
  table.position.y = -0.025;
  scene.add(table);
  const positions: Record<string, Vec3> = { object: [-0.17, 0.025, 0], target: [0.17, 0.025, 0] };
  const source = new Mesh(
    new CylinderGeometry(0.032, 0.032, 0.06, 32),
    new MeshStandardMaterial({ color: 0x24d4ed, roughness: 0.5 }),
  );
  source.position.set(...(positions.object as Vec3));
  scene.add(source);
  const hands = new GhostHandsPresenter();
  const glyphs = new GlyphsPresenter();
  scene.add(hands.object, glyphs.object);
  const player = new ClipPlayer();
  let demo: PresentContext['demo'] = null;
  let time = 0;
  let running = true;
  const preference = matchMedia('(prefers-reduced-motion: reduce)');
  function choose(): void {
    const verb = select.value as Action['verb'];
    const action: Action = {
      verb,
      object: 'object',
      hand: 'right',
      ...(['place', 'fold'].includes(verb) ? { target: 'target' } : {}),
    };
    positions.object = [action.target ? -0.17 : 0, 0.025, 0];
    source.position.set(...positions.object);
    demo = synthesizeDemo({ stepId: 'preview', action, position: (id) => positions[id] });
    time = 0;
    if (demo) player.play(demo.clip, 0, { loop: true });
  }
  select.addEventListener('change', choose);
  play.addEventListener('click', () => {
    running = !running;
    play.textContent = running ? 'Pause' : 'Play';
  });
  choose();
  const resize = new ResizeObserver(() => {
    const width = viewport.clientWidth;
    const height = viewport.clientHeight;
    renderer.setSize(width, height);
    camera.aspect = width / Math.max(1, height);
    camera.updateProjectionMatrix();
  });
  resize.observe(viewport);
  let visible = true;
  const observer = new IntersectionObserver(([entry]) => {
    visible = entry?.isIntersecting ?? false;
  });
  observer.observe(viewport);
  let last = performance.now();
  renderer.setAnimationLoop((now) => {
    const dt = Math.min(now - last, 50);
    last = now;
    if (!visible || document.hidden) return;
    if (running) time += dt;
    const ctx: PresentContext = {
      t: time,
      dt,
      snapshot: {
        phase: 'idle',
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
      objects: [],
      demo,
      demoHands: showHands.checked ? player.sample(preference.matches ? 1800 : time) : null,
      hands: null,
      head: { p: [0, 0.56, 0.69], q: [0, 0, 0, 1] },
      worldFromWorkspace: { p: [0, 0, 0], q: [0, 0, 0, 1] },
      calibration: null,
      debug: false,
    };
    hands.update(ctx);
    glyphs.update(ctx);
    renderer.render(scene, camera);
  });
  window.addEventListener(
    'pagehide',
    () => {
      renderer.setAnimationLoop(null);
      resize.disconnect();
      observer.disconnect();
      orbit.dispose();
      hands.dispose();
      glyphs.dispose();
      for (const mesh of [source, table]) {
        mesh.geometry.dispose();
        mesh.material.dispose();
      }
      renderer.dispose();
    },
    { once: true },
  );
}

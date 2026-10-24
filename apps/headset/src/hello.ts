import * as THREE from 'three';
import { installEmulator } from './adapters/xr/emulator';

// A bare WebXR smoke test for the headset (/hello.html): a spinning cube in passthrough AR and a
// dot on every tracked hand joint. Pinch to recolor the cube. No server, coach, camera or lesson
// code is involved, so it isolates "does WebXR render on this device" from everything else.

const PINCH_M = 0.02;
const COLORS = [0x4fe3ff, 0xffb347, 0x7dff7a, 0xff6fae];

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const desktopBackground = new THREE.Color(0x0b1016);
scene.background = desktopBackground;
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 20);
camera.position.set(0, 1.6, 0);

scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 2));
const sun = new THREE.DirectionalLight(0xffffff, 2);
sun.position.set(1, 3, 2);
scene.add(sun);

const cubeMaterial = new THREE.MeshStandardMaterial({ color: COLORS[0], roughness: 0.4 });
const cube = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), cubeMaterial);
cube.position.set(0, 1.4, -0.8);
scene.add(cube);

const ring = new THREE.Mesh(
  new THREE.TorusGeometry(0.22, 0.008, 12, 96),
  new THREE.MeshStandardMaterial({ color: 0xffffff }),
);
ring.position.copy(cube.position);
scene.add(ring);

// Hand joints: three.js fills hand.joints as tracking reports them; give each one a dot.
const jointGeometry = new THREE.SphereGeometry(0.006, 10, 8);
const jointMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff });
const hands = [renderer.xr.getHand(0), renderer.xr.getHand(1)];
for (const hand of hands) scene.add(hand);
const pinching = [false, false];
let colorIndex = 0;

function updateHands(): void {
  hands.forEach((hand, i) => {
    for (const joint of Object.values(hand.joints)) {
      if (joint && joint.children.length === 0)
        joint.add(new THREE.Mesh(jointGeometry, jointMaterial));
    }
    const thumb = hand.joints['thumb-tip'];
    const index = hand.joints['index-finger-tip'];
    if (!thumb?.visible || !index?.visible) return;
    const now = thumb.position.distanceTo(index.position) < PINCH_M;
    if (now && !pinching[i]) {
      colorIndex = (colorIndex + 1) % COLORS.length;
      cubeMaterial.color.setHex(COLORS[colorIndex] ?? 0x4fe3ff);
    }
    pinching[i] = now;
  });
}

renderer.setAnimationLoop((time) => {
  cube.rotation.x = time / 1600;
  cube.rotation.y = time / 1100;
  ring.rotation.y = time / 2400;
  updateHands();
  renderer.render(scene, camera);
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const button = document.querySelector<HTMLButtonElement>('#enter');

async function enterAr(): Promise<void> {
  if (!navigator.xr || !button) return;
  const session = await navigator.xr.requestSession('immersive-ar', {
    requiredFeatures: ['local-floor'],
    optionalFeatures: ['hand-tracking'],
  });
  scene.background = null;
  button.hidden = true;
  session.addEventListener('end', () => {
    scene.background = desktopBackground;
    button.hidden = false;
  });
  await renderer.xr.setSession(session);
}

async function init(): Promise<void> {
  if (new URLSearchParams(location.search).get('emulate') === '1') await installEmulator();
  const supported = (await navigator.xr?.isSessionSupported('immersive-ar')) ?? false;
  if (!button) return;
  button.textContent = supported ? 'Enter AR' : 'AR not available';
  button.disabled = !supported;
  button.addEventListener('click', () => {
    enterAr().catch((err: unknown) => {
      button.textContent = `AR failed: ${String(err)}`;
    });
  });
}

void init();

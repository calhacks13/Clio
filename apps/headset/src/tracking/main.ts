import * as THREE from 'three';
import { frameGuard, installFrameDebug } from '../adapters/render/frame-guard';
import { HandsView } from './hands';
import { TrackingHud, type TrackingStats } from './hud';
import { SurfaceReticle } from './reticle';
import { RoomMeshView } from './room-mesh';
import { SurfacesView } from './surfaces';

// What the headset tracks (/tracking.html), drawn live in passthrough: both hands as skeletons
// with a pinch ring, every detected plane and room mesh colored by semantic label, a reticle where
// your gaze meets a real surface, and a panel of counts. No server, coach or lesson code. Each
// feature is optional; one the device lacks (no Space Setup, no hand tracking) is simply not drawn.
// On the desktop, ?emulate=1 runs it against IWER's synthetic room.

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const desktopBackground = new THREE.Color(0x0b1016);
scene.background = desktopBackground;
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 50);
camera.position.set(0, 1.6, 0);

scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 2));
const sun = new THREE.DirectionalLight(0xffffff, 2);
sun.position.set(1, 3, 2);
scene.add(sun);

const hands = new HandsView();
const surfaces = new SurfacesView();
const roomMesh = new RoomMeshView();
const reticle = new SurfaceReticle();
const hud = new TrackingHud();
scene.add(roomMesh.object, surfaces.object, reticle.object, hands.object, hud.object);

const head = new THREE.Vector3();
const orientation = new THREE.Quaternion();
const stats: TrackingStats = { fps: 0, left: false, right: false, surfaces: 0, meshes: 0 };
let lastTime = 0;

function track(frame: XRFrame, time: number): void {
  const space = renderer.xr.getReferenceSpace();
  const viewer = space && frame.getViewerPose(space);
  if (!space || !viewer) return;
  const { position, orientation: o } = viewer.transform;
  head.set(position.x, position.y, position.z);
  orientation.set(o.x, o.y, o.z, o.w);
  const dt = lastTime > 0 ? time - lastTime : 0;
  lastTime = time;
  if (dt > 0) stats.fps = stats.fps > 0 ? stats.fps * 0.95 + (1000 / dt) * 0.05 : 1000 / dt;

  hands.update(frame, space, time, orientation);
  surfaces.update(frame, space, head, orientation);
  roomMesh.update(frame, space);
  reticle.update(frame, space);

  stats.left = hands.tracked.left;
  stats.right = hands.tracked.right;
  stats.surfaces = surfaces.count;
  stats.meshes = roomMesh.count;
  hud.update(head, orientation, dt, time, stats);
}

// Each step guarded (frame-guard.ts): one that throws costs that frame, never the loop.
installFrameDebug();
renderer.setAnimationLoop(
  frameGuard.loop<XRFrame>(
    (time, frame) => {
      if (frame) track(frame, time);
    },
    () => renderer.render(scene, camera),
  ),
);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const button = document.querySelector<HTMLButtonElement>('#enter');

function endSession(): void {
  scene.background = desktopBackground;
  hands.hide();
  surfaces.clear();
  roomMesh.clear();
  reticle.stop();
  hud.hide();
  stats.fps = 0;
  lastTime = 0;
  if (button) button.hidden = false;
}

async function enterAr(): Promise<void> {
  if (!navigator.xr || !button) return;
  const session = await navigator.xr.requestSession('immersive-ar', {
    requiredFeatures: ['local-floor'],
    optionalFeatures: ['hand-tracking', 'plane-detection', 'mesh-detection', 'hit-test'],
  });
  // Runtimes that don't list enabled features get the benefit of the doubt; the views also stop
  // reading a set that throws.
  const enabled = (feature: string) => session.enabledFeatures?.includes(feature) ?? true;
  surfaces.enabled = enabled('plane-detection');
  roomMesh.enabled = enabled('mesh-detection');
  scene.background = null;
  button.hidden = true;
  session.addEventListener('end', endSession);
  await renderer.xr.setSession(session);
  if (enabled('hit-test')) await reticle.start(session);
}

async function init(): Promise<void> {
  if (new URLSearchParams(location.search).get('emulate') === '1') {
    const { installEmulator } = await import('../adapters/xr/emulator');
    (window as unknown as { clio: unknown }).clio = await installEmulator();
  }
  const supported = (await navigator.xr?.isSessionSupported('immersive-ar')) ?? false;
  if (!button) return;
  button.textContent = supported ? 'Enter AR' : 'AR not available';
  button.disabled = !supported;
  // A pinch on the Quest can land as two clicks; a second requestSession while one is pending fails.
  button.addEventListener('click', () => {
    if (button.disabled) return;
    button.disabled = true;
    button.textContent = 'Enter AR';
    enterAr()
      .catch((err: unknown) => {
        button.textContent = `AR failed: ${String(err)}`;
      })
      .finally(() => {
        button.disabled = false;
      });
  });
}

void init();

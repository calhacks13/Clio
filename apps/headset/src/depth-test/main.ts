import * as THREE from 'three';
import type { Vec3 } from '../core/math';
import type { Ray } from '../domain/world/camera-model';
import { createDepthProbe, type DepthHit, type XrDepthProbe } from '../primary/depth';
import {
  createDepthSampler,
  type DepthSampler,
  type DepthSamplerStats,
  depthSensingInit,
  disableXrDepthOcclusion,
  type WindowFar,
} from '../primary/depth-sensing';
import { Readout } from './panel';

// /depth.html: does Quest Browser serve WebXR depth sensing, and how good is it? In passthrough AR
// it reads the depth map along two rays, a few times a second:
//   center     straight ahead from the head. Hit-test (the room's planes and mesh) is measured
//              along the same ray, so the two can be compared on a real table or wall.
//   fingertip  from the head through the index fingertip. Hand tracking knows where the tip is,
//              so the sensed distance can be checked against it (the depth map sees the hand).
// A dot marks each measured point: on target in both eyes means the depth is right.
// ?usage=gpu asks for gpu-optimized depth first (the default asks for cpu-optimized first).
// ?aim=yaw,pitch (degrees) turns the center ray away from straight ahead, so an off-center part of
// the depth map can be compared with hit-test (e.g. ?aim=0,-30 for the table below).
// GPU window depth is decoded with no far plane (Quest Browser reports none; IWER reports one but
// encodes without it). The Reads row shows the sampler's readbacks, or its last error.
// Readings are also on window.clioDepth, for a DevTools session: the sampler's stats (maps asked
// for, reads started, completed and dropped, why an attempt read nothing, the last error) and any
// error thrown by the page's own frame loop.

const REFRESH_MS = 120;
const COLORS = { center: 0x4fe3ff, hitTest: 0xffb347, fingertip: 0x7dff7a } as const;
const params = new URLSearchParams(location.search);
const emulate = params.get('emulate') === '1';
/** IWER reports a far plane but encodes window depth without one (depth-sensing.ts). */
const WINDOW_FAR: WindowFar = emulate ? 'infinite' : 'reported';
const ROWS = [
  { label: 'Depth' },
  { label: 'Center', swatch: COLORS.center },
  { label: 'Reads' },
  { label: 'Hit test', swatch: COLORS.hitTest },
  { label: 'Fingertip', swatch: COLORS.fingertip },
  { label: 'Hand tracking' },
  { label: 'Difference' },
] as const;
enum R {
  Depth,
  Center,
  Reads,
  HitTest,
  Fingertip,
  Hand,
  Difference,
}

const DEG = Math.PI / 180;
const [aimYaw = 0, aimPitch = 0] = (params.get('aim') ?? '')
  .split(',')
  .map((v) => Number.parseFloat(v))
  .map((v) => (Number.isFinite(v) ? v : 0));
const aim = new THREE.Quaternion().setFromEuler(
  new THREE.Euler(aimPitch * DEG, aimYaw * DEG, 0, 'YXZ'),
);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
// The depth map is for measuring; three would otherwise hide the readout behind the hand.
disableXrDepthOcclusion(renderer);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const desktopBackground = new THREE.Color(0x0b1016);
scene.background = desktopBackground;
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 20);
camera.position.set(0, 1.6, 0);

const readout = new Readout(ROWS);
scene.add(readout.object);

function marker(color: number): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.008, 16, 12),
    new THREE.MeshBasicMaterial({ color, depthTest: false }),
  );
  mesh.renderOrder = 10;
  mesh.visible = false;
  scene.add(mesh);
  return mesh;
}
const markers = {
  center: marker(COLORS.center),
  hitTest: marker(COLORS.hitTest),
  fingertip: marker(COLORS.fingertip),
};

const hands = [renderer.xr.getHand(0), renderer.xr.getHand(1)];
for (const hand of hands) scene.add(hand);

export interface DepthReadings {
  supported: boolean;
  mode: string | null;
  info: DepthSampler['info'];
  /** The sampler's counters (live): see DepthSamplerStats. Null without a sampler. */
  stats: DepthSamplerStats | null;
  centerM: number | null;
  hitTestM: number | null;
  fingertipM: number | null;
  handM: number | null;
  /** Errors thrown by this page's frame loop, by step (the last of each), and how many. */
  loopErrors: Record<string, string>;
  loopErrorCount: number;
  /** Frames the loop ran with a session. */
  loopFrames: number;
}

const readings: DepthReadings = {
  supported: false,
  mode: null,
  info: null,
  stats: null,
  centerM: null,
  hitTestM: null,
  fingertipM: null,
  handM: null,
  loopErrors: {},
  loopErrorCount: 0,
  loopFrames: 0,
};
(window as unknown as { clioDepth: DepthReadings }).clioDepth = readings;

let session: XRSession | null = null;
let sampler: DepthSampler | null = null;
let probe: XrDepthProbe | null = null;
let hitTestBusy = false;
let nextRead = 0;
let lastTime = 0;

const meters = (m: number | null) => (m === null ? 'none' : `${m.toFixed(3)} m`);

function show(mesh: THREE.Mesh, hit: DepthHit | null): void {
  mesh.visible = hit !== null;
  if (hit) mesh.position.set(...hit.point);
}

const headPosition = new THREE.Vector3();
const headQuaternion = new THREE.Quaternion();
const forward = new THREE.Vector3();
const tip = new THREE.Vector3();
const aimed = new THREE.Quaternion();

/** The index fingertip of the right hand, else the left; null when neither is tracked. */
function fingertip(): THREE.Vector3 | null {
  for (const hand of [hands[1], hands[0]]) {
    const joint = hand?.joints['index-finger-tip'];
    if (joint?.visible) return tip.copy(joint.position);
  }
  return null;
}

function read(frame: XRFrame, space: XRReferenceSpace): void {
  const pose = frame.getViewerPose(space);
  if (!pose) return;
  const { position: p, orientation: q } = pose.transform;
  headPosition.set(p.x, p.y, p.z);
  headQuaternion.set(q.x, q.y, q.z, q.w);
  forward.set(0, 0, -1).applyQuaternion(aimed.copy(headQuaternion).multiply(aim));
  const origin: Vec3 = [p.x, p.y, p.z];
  const center: Ray = { origin, direction: [forward.x, forward.y, forward.z] };

  const sensed = sampler?.sample(frame, center) ?? null;
  readings.centerM = sensed?.distance ?? null;
  readings.info = sampler?.info ?? null;
  show(markers.center, sensed);

  if (probe && !hitTestBusy) {
    hitTestBusy = true;
    void probe.measure([center]).then(([hit]) => {
      hitTestBusy = false;
      readings.hitTestM = hit?.distance ?? null;
      show(markers.hitTest, hit ?? null);
    });
  }

  const tipNow = fingertip();
  let tipHit: DepthHit | null = null;
  if (tipNow) {
    const toTip = tipNow.clone().sub(headPosition);
    readings.handM = toTip.length();
    toTip.normalize();
    tipHit = sampler?.sample(frame, { origin, direction: [toTip.x, toTip.y, toTip.z] }) ?? null;
  } else {
    readings.handM = null;
  }
  readings.fingertipM = tipHit?.distance ?? null;
  show(markers.fingertip, tipHit);

  const info = readings.info;
  readout.set(
    R.Depth,
    !readings.supported
      ? 'Not supported'
      : info
        ? `${info.mode.toUpperCase()} ${info.format} ${info.width}x${info.height}`
        : 'No data yet',
  );
  readout.set(R.Center, meters(readings.centerM));
  readout.set(R.Reads, readsText(sampler?.stats ?? null));
  readout.set(R.HitTest, probe ? meters(readings.hitTestM) : 'Not supported');
  readout.set(R.Fingertip, meters(readings.fingertipM));
  readout.set(R.Hand, meters(readings.handM));
  const diff =
    readings.fingertipM !== null && readings.handM !== null
      ? `${((readings.fingertipM - readings.handM) * 100).toFixed(1)} cm`
      : 'none';
  readout.set(R.Difference, diff);
}

/** The Reads row: readbacks completed of started, else why there are none. */
function readsText(stats: DepthSamplerStats | null): string {
  if (!stats) return 'none';
  if (stats.lastError && stats.readsCompleted === 0) return stats.lastError.slice(0, 40);
  if (stats.readsStarted > 0) return `${stats.readsCompleted} of ${stats.readsStarted}`;
  return stats.lastSkip ?? (stats.infoCalls === 0 ? 'not asked' : 'none');
}

/** One step of the frame loop: an error is recorded and does not stop the others. */
function step(name: string, run: () => void): void {
  try {
    run();
  } catch (err) {
    readings.loopErrorCount++;
    if (!(name in readings.loopErrors)) console.error(`[depth] ${name} failed`, err);
    readings.loopErrors[name] = String(err);
  }
}

renderer.setAnimationLoop((time, frame) => {
  const space = renderer.xr.getReferenceSpace();
  if (frame && space && session) {
    readings.loopFrames++;
    step('hit-test update', () => probe?.update(frame));
    step('depth update', () => sampler?.update(frame));
    if (time >= nextRead) {
      nextRead = time + REFRESH_MS;
      step('read', () => read(frame, space));
    }
    readout.follow(headPosition, headQuaternion, lastTime ? time - lastTime : 0);
  }
  lastTime = time;
  renderer.render(scene, camera);
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const button = document.querySelector<HTMLButtonElement>('#enter');

function endSession(): void {
  sampler?.close();
  probe?.close();
  sampler = null;
  probe = null;
  session = null;
  hitTestBusy = false;
  scene.background = desktopBackground;
  readout.hide();
  for (const m of Object.values(markers)) m.visible = false;
  if (button) button.hidden = false;
}

async function enterAr(): Promise<void> {
  if (!navigator.xr || !button) return;
  const usage: XRDepthUsage[] =
    params.get('usage') === 'gpu'
      ? ['gpu-optimized', 'cpu-optimized']
      : ['cpu-optimized', 'gpu-optimized'];
  const depth = depthSensingInit(usage);
  const started = await navigator.xr.requestSession('immersive-ar', {
    requiredFeatures: ['local-floor'],
    optionalFeatures: ['hand-tracking', 'hit-test', ...depth.optionalFeatures],
    depthSensing: depth.depthSensing,
  });
  scene.background = null;
  button.hidden = true;
  started.addEventListener('end', endSession);
  await renderer.xr.setSession(started);
  const space = renderer.xr.getReferenceSpace();
  if (!space) throw new Error('No local-floor reference space.');
  const gpu = started.depthUsage === 'gpu-optimized';
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const binding = gpu ? renderer.xr.getBinding() : null;
  sampler = createDepthSampler(started, { space, gl, binding, windowFar: WINDOW_FAR });
  readings.supported = sampler !== null;
  readings.stats = sampler?.stats ?? null;
  // Set before anything else that could throw, so the frame loop runs regardless.
  session = started;
  probe = createDepthProbe(started, space);
  readings.mode = started.depthUsage ?? null;
  console.info(
    `[depth] features ${JSON.stringify(started.enabledFeatures ?? [])}, usage ${started.depthUsage}, format ${started.depthDataFormat}, binding ${binding ? 'three' : 'none'}`,
  );
}

async function init(): Promise<void> {
  if (emulate) {
    const { installEmulator } = await import('../adapters/xr/emulator');
    (window as unknown as { clio: unknown }).clio = await installEmulator();
  }
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

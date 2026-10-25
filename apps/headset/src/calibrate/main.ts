import * as THREE from 'three';
import { defaultQuestCameraModel } from '../adapters/camera/calibration';
import { PassthroughCamera } from '../adapters/camera/passthrough-camera';
import {
  type CalibrationBase,
  calibrationBase,
  clearStoredCalibration,
  loadStoredCalibration,
  type StoredCalibration,
  saveStoredCalibration,
} from '../adapters/camera/stored-calibration';
import {
  createDepthProbe,
  type DepthHit,
  type DepthSource,
  type XrDepthProbe,
} from '../adapters/xr/depth';
import {
  createDepthSampler,
  type DepthSampler,
  depthSensingInit,
  depthUsageOf,
  disableXrDepthOcclusion,
  preferDepthSensing,
} from '../adapters/xr/depth-sensing';
import { poseFromMatrix } from '../adapters/xr/frame-sampler';
import { createLogger } from '../core/log';
import {
  add,
  cross,
  dot,
  invertPose,
  length,
  madd,
  normalize,
  type Pose,
  type Quat,
  quatFromAxisAngle,
  quatMultiply,
  quatNormalize,
  rotateVec,
  sub,
  transformPoint,
  type Vec3,
} from '../core/math';
import type { CameraModel } from '../domain/world/camera-model';
import { PinchLatch } from '../tracking/pinch-latch';
import { type EmulatedHands, installCalibrationEmulator, SimulatedCamera } from './emulator';
import { CalibrationFlow, type CaptureResult, type FlowProgress } from './flow';
import { CalibrationPanel, type PanelVideo, type PanelView } from './panel';
import { correctedRotation, projectToUv, uvToNormalized } from './solver';
import { DEFAULT_STEADY, SteadyPoint } from './steady';
import type { AimStep } from './targets';

// Camera calibration (/calibrate.html). Quest Browser reports no lens calibration, so where the
// passthrough camera sits on the headset, how it is turned and its focal length are a guess
// (adapters/camera/calibration.ts). This page measures them. The camera feed is shown on a panel
// with a crosshair, and every sample pairs a point the headset knows in 3D with the crosshair it
// appears under in that picture:
//   - the right index fingertip (hand tracking), close and at arm's length, nine times;
//   - two marks on real surfaces 1 to 3 m away: the user looks at a sharp corner and pinches, which
//     places the mark with hit-test, then turns the head so that corner sits under the crosshair in
//     the picture, three times each. Far points tell a turn of the camera from a shift.
// The left hand pinches to confirm. The hand skeletons are not drawn: the panel would hide the
// real hand behind it and a virtual fingertip in front of it invites lining up by eye, not in the
// picture. The fit (solver.ts) is judged by its predicted miss 1 m out and saved to localStorage
// (stored-calibration.ts) only if that is small. Yellow dots then mark where the solved camera
// sees the fingertip and the marks: on them in the picture means it worked, near and far.
//
// ?emulate=1 runs in the IWER emulator with a simulated camera that sees the fingertip and marks
// from a hidden true camera (pose and focal length); window.__calibrate.aim() moves the emulated
// hand, or turns the emulated head, onto the current crosshair and clio.pinch('left') confirms.

const log = createLogger('calibrate');
const params = new URLSearchParams(location.search);
const EMULATE = params.get('emulate') === '1';
/** Where the hand goes for each reach (m from the camera), for the emulator's aim(). */
const REACH_DEPTH = { near: 0.3, far: 0.6 } as const;
const FLASH_MS = 1600;
const DEG = Math.PI / 180;

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
// With gpu-optimized depth, three.js would hide the panel and marks behind real surfaces.
disableXrDepthOcclusion(renderer);
renderer.xr.setReferenceSpaceType('local-floor');
renderer.domElement.id = 'xr-canvas';
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const desktopBackground = new THREE.Color(0x0b1016);
scene.background = desktopBackground;
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 50);
camera.position.set(0, 1.6, 0);

const ACCENT = 0x4fe3ff;
const panel = new CalibrationPanel();
/** Where the gaze meets a surface while placing a mark. */
const reticle = new THREE.Mesh(
  new THREE.RingGeometry(0.012, 0.02, 40),
  new THREE.MeshBasicMaterial({ color: ACCENT, side: THREE.DoubleSide }),
);
reticle.visible = false;
const markDots = new THREE.Group();
scene.add(panel.object, reticle, markDots);

let model: CameraModel | null = null;
let base: CalibrationBase = 'default';
let video: PanelVideo | null = null;
let sim: SimulatedCamera | null = null;
let emulated: EmulatedHands | null = null;
let flow: CalibrationFlow | null = null;
let session: XRSession | null = null;
let probe: XrDepthProbe | null = null;
/** Depth sensing, which works without a room scan; hit-test only needs Space Setup. */
let sensing: DepthSampler | null = null;
/** Where marks land: depth sensing first, hit-test for the rays it misses. */
let gazeSource: DepthSource | null = null;

/** The fingertip held still, and the head held still on a mark (about 0.4 deg at 1.5 m). */
const fingerSteady = new SteadyPoint();
const markSteady = new SteadyPoint({ ...DEFAULT_STEADY, maxSpread: 0.012 });
let steady = fingerSteady;
let steadyStep: unknown = null;
const leftPinch = new PinchLatch();
let wasPinching = false;
let flash: { text: string; until: number } | null = null;
/** This frame's head pose, fingertip (head frame) and fingertip (world). */
let headPose: Pose | null = null;
let tipHead: Vec3 | null = null;
let tipWorld: Vec3 | null = null;
/** The latest gaze hit, and whether one is being measured. */
let gaze: DepthHit | null = null;
let gazeInFlight = false;
/** Placed marks (world). */
const marks: Vec3[] = [];
let saved: StoredCalibration | null = loadStoredCalibration();
let lastTime = 0;
/** XR frames seen, for checking a run from the console. */
let xrFrames = 0;

const head = new THREE.Vector3();
const orientation = new THREE.Quaternion();

function jointPosition(
  frame: XRFrame,
  space: XRReferenceSpace,
  hand: XRHand,
  name: XRHandJoint,
): Vec3 | null {
  const joint = hand.get(name);
  const pose = joint && frame.getJointPose?.(joint, space);
  if (!pose) return null;
  const { x, y, z } = pose.transform.position;
  return [x, y, z];
}

/** The right index tip (world) and the left thumb-to-index gap, when tracked. */
function readHands(
  frame: XRFrame,
  space: XRReferenceSpace,
): { tip: Vec3 | null; gap: number | null } {
  let tip: Vec3 | null = null;
  let gap: number | null = null;
  for (const source of frame.session.inputSources) {
    if (!source.hand) continue;
    if (source.handedness === 'right') {
      tip = jointPosition(frame, space, source.hand, 'index-finger-tip');
    } else if (source.handedness === 'left') {
      const a = jointPosition(frame, space, source.hand, 'thumb-tip');
      const b = jointPosition(frame, space, source.hand, 'index-finger-tip');
      if (a && b) gap = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    }
  }
  return { tip, gap };
}

function say(text: string, t: number): void {
  flash = { text, until: t + FLASH_MS };
}

const toDeg = (rad: number) => rad / DEG;

function saveFit(result: Extract<CaptureResult, { kind: 'done' }>): void {
  if (!model || !result.usable) return;
  const { fit } = result;
  const record: StoredCalibration = {
    base,
    width: model.intrinsics.width,
    height: model.intrinsics.height,
    baseFx: model.intrinsics.fx,
    headFromCamera: fit.headFromCamera,
    fx: fit.intrinsics.fx,
    fy: fit.intrinsics.fy,
    missMm: fit.predictedMiss * 1000,
    heldOutDeg: toDeg(fit.heldOutAngle ?? 0),
    errorDeg: toDeg(fit.rmsAngle),
    inliers: fit.inliers,
    samples: fit.samples.length,
    savedAt: Date.now(),
  };
  if (saveStoredCalibration(record)) saved = record;
  else log.warn('could not save the calibration (storage unavailable)');
}

function logFit(result: Extract<CaptureResult, { kind: 'done' }>): void {
  const { fit } = result;
  const p = fit.headFromCamera.p.map((v) => (v * 1000).toFixed(1)).join(', ');
  const turn = [fit.yaw, fit.pitch, fit.roll].map((v) => toDeg(v).toFixed(2)).join(', ');
  log.info(
    `camera at [${p}] mm, turned [${turn}] deg, focal x${fit.focalScale.toFixed(3)}, miss at 1 m ${(fit.predictedMiss * 1000).toFixed(1)} mm, held out ${toDeg(fit.heldOutAngle ?? Number.NaN).toFixed(2)} deg, rms ${toDeg(fit.rmsAngle).toFixed(2)} deg, ${fit.inliers}/${fit.samples.length} kept, ${result.usable ? 'saved' : 'not saved'}`,
  );
}

// The run is stored after every step, so a reload or a new AR session picks up where it stopped.
const PROGRESS_KEY = 'clio.calibration.progress.v1';

function saveProgress(): void {
  try {
    const progress = flow?.progress() ?? null;
    if (progress) localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress));
    else localStorage.removeItem(PROGRESS_KEY);
  } catch {
    // Storage unavailable: the run just isn't resumable.
  }
}

function loadProgress(): FlowProgress | null {
  try {
    const raw = localStorage.getItem(PROGRESS_KEY);
    return raw ? (JSON.parse(raw) as FlowProgress) : null;
  } catch {
    return null;
  }
}

/** Resume the stored run (back to placing a mark the run was in the middle of), else start one. */
function resumeOrRestart(): void {
  if (!flow) return;
  const progress = flow.progress() ?? loadProgress();
  if (progress && flow.restore(progress)) {
    log.info(`calibration resumed at step ${flow.taken + 1} of ${flow.total}`);
  } else {
    flow.restart();
  }
  saveProgress();
}

function clearMarks(): void {
  marks.length = 0;
  markDots.clear();
}

/** Marks are indexed by the step's mark number: a resumed run may place mark 1 before mark 0. */
function addMark(point: Vec3, index: number): void {
  marks[index] = point;
  const dotMesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.008, 16, 12),
    new THREE.MeshBasicMaterial({ color: ACCENT }),
  );
  dotMesh.position.set(...point);
  markDots.add(dotMesh);
}

/** The point the current step aims with, in the head frame. */
function aimPoint(step: AimStep): Vec3 | null {
  if (step.kind === 'finger') return tipHead;
  const mark = marks[step.mark];
  return mark && headPose ? transformPoint(invertPose(headPose), mark) : null;
}

/** The left hand pinched: take a sample or place a mark (nothing once the run is done). */
function confirm(t: number): void {
  if (!flow) return;
  // A finished run stays on screen: a stray pinch must not throw it away and start over. Leaving
  // AR and pressing Calibrate again starts a new run.
  if (flow.fit) return;
  const step = flow.step;
  if (!step) return;
  if (step.kind === 'place') {
    const hit = gaze;
    const result = flow.place(hit ? hit.distance : null);
    if (result.kind === 'placed' && hit) addMark(hit.point, step.mark);
    else if (result.kind === 'too-close') say('Too close', t);
    else if (result.kind === 'no-surface') say(gazeSource ? 'No surface there' : 'No depth', t);
    saveProgress();
    return;
  }
  const result = flow.capture(steady.steady(t));
  saveProgress();
  switch (result.kind) {
    case 'unsteady':
      say(step.kind === 'mark' || tipHead ? 'Hold still' : 'Right hand not tracked', t);
      break;
    case 'off-target':
      say('Not on the cross', t);
      break;
    case 'more':
      say(`${result.added} more`, t);
      break;
    case 'done':
      flash = null;
      logFit(result);
      saveFit(result);
      break;
    default:
      flash = null;
  }
}

const fmt = (v: number, digits = 1) => v.toFixed(digits);

function panelView(t: number): PanelView {
  const view: PanelView = {
    video,
    crosshair: null,
    dots: [],
    mode: 'feed',
    title: '',
    detail: '',
    warn: false,
    progress: '',
    hint: '',
  };
  if (!flow || !model) return { ...view, title: 'No camera' };
  const fit = flow.fit;
  if (fit) {
    const mm = fmt(fit.predictedMiss * 1000);
    const usable = flow.usable(fit);
    view.title = usable ? `Saved    ${mm} mm at 1 m` : `Not saved    ${mm} mm at 1 m`;
    view.detail = 'Pinch left to redo';
    view.warn = !usable;
    view.progress = `${fit.inliers} of ${fit.samples.length}`;
    const inv = headPose && invertPose(headPose);
    const points = [tipHead, ...marks.map((m) => (inv ? transformPoint(inv, m) : null))];
    for (const point of points) {
      const uv = point && projectToUv(fit.intrinsics, fit.headFromCamera, point);
      if (uv) view.dots.push(uv);
    }
    return view;
  }
  const step = flow.step;
  const flashing = flash && t < flash.until ? flash.text : null;
  view.progress = `${flow.taken + 1} / ${flow.total}`;
  if (step?.kind === 'place') {
    view.mode = 'strip';
    view.title = 'Look at a sharp corner 1 to 3 m away';
    view.detail = flashing ?? (gaze ? 'Pinch left to mark it' : 'No surface there');
    view.warn = flashing !== null || !gaze;
    return view;
  }
  view.crosshair = step?.uv ?? null;
  if (step?.kind === 'mark') {
    view.title = 'Put that corner on the cross in the picture';
    view.detail = flashing ?? 'Turn your head, hold still, pinch left';
    view.warn = flashing !== null;
    return view;
  }
  view.title = 'Right fingertip on the cross in the picture';
  view.detail = flashing ?? (tipHead ? 'Hold still, pinch left' : 'Right hand not tracked');
  view.warn = flashing !== null || !tipHead;
  view.hint = step?.reach === 'far' ? 'Arm out' : 'Close';
  return view;
}

/** Keeps a depth reading running along the gaze while a mark is being placed. */
function updateGaze(frame: XRFrame, pose: Pose, placing: boolean): void {
  sensing?.update(frame);
  probe?.update(frame);
  if (!placing || !gazeSource) {
    gaze = null;
    reticle.visible = false;
    return;
  }
  if (!gazeInFlight) {
    gazeInFlight = true;
    const ray = { origin: pose.p, direction: rotateVec(pose.q, [0, 0, -1]) };
    gazeSource
      .measure([ray])
      .then(([hit]) => {
        gaze = hit ?? null;
      })
      .catch(() => {
        gaze = null;
      })
      .finally(() => {
        gazeInFlight = false;
      });
  }
  reticle.visible = gaze !== null;
  if (gaze) {
    reticle.position.set(...gaze.point);
    reticle.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 0, 1),
      new THREE.Vector3(...gaze.normal),
    );
  }
}

function track(frame: XRFrame, time: number): void {
  const space = renderer.xr.getReferenceSpace();
  const viewer = space && frame.getViewerPose(space);
  if (!space || !viewer) return;
  xrFrames++;
  const pose = poseFromMatrix(viewer.transform.matrix);
  headPose = pose;
  head.set(...pose.p);
  orientation.set(...pose.q);
  const dt = lastTime > 0 ? time - lastTime : 0;
  lastTime = time;

  const { tip, gap } = readHands(frame, space);
  tipWorld = tip;
  const toHead = invertPose(pose);
  tipHead = tip ? transformPoint(toHead, tip) : null;
  const step = flow?.step ?? null;
  updateGaze(frame, pose, step?.kind === 'place');

  if (step !== steadyStep) {
    steady.clear();
    steady = step?.kind === 'mark' ? markSteady : fingerSteady;
    steady.clear();
    steadyStep = step;
  }
  const point = step && step.kind !== 'place' ? aimPoint(step) : null;
  if (point) steady.push(time, point);
  else steady.clear();
  sim?.update([...(tipHead ? [tipHead] : []), ...marks.map((m) => transformPoint(toHead, m))]);

  const pinching = leftPinch.update(gap, time);
  if (pinching && !wasPinching) confirm(time);
  wasPinching = pinching;

  panel.follow(head, orientation, dt);
  panel.draw(panelView(time), time);
}

renderer.setAnimationLoop((time, frame) => {
  if (frame) track(frame, time);
  renderer.render(scene, camera);
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---- the 2D page -------------------------------------------------------------------------------

const home = document.querySelector<HTMLElement>('#home');
const button = document.querySelector<HTMLButtonElement>('#enter');
const savedBox = document.querySelector<HTMLElement>('#saved');
const savedOffset = document.querySelector<HTMLElement>('#saved-offset');
const savedError = document.querySelector<HTMLElement>('#saved-error');
const clearButton = document.querySelector<HTMLButtonElement>('#clear');

function showSaved(): void {
  if (!savedBox || !savedOffset || !savedError) return;
  savedBox.hidden = saved === null;
  if (!saved) return;
  const [x, y, z] = saved.headFromCamera.p.map((v) => fmt(v * 1000));
  const spans = (parts: string[]) =>
    parts.map((text) => Object.assign(document.createElement('span'), { textContent: text }));
  savedOffset.replaceChildren(...spans([`x ${x}`, `y ${y}`, `z ${z} mm`]));
  savedError.replaceChildren(...spans([`${fmt(saved.missMm)} mm at 1 m`]));
}

clearButton?.addEventListener('click', () => {
  clearStoredCalibration();
  saved = null;
  // Clear also drops a run in progress, so the next Calibrate starts fresh.
  flow?.restart();
  saveProgress();
  showSaved();
});

function endSession(): void {
  session = null;
  sensing?.close();
  sensing = null;
  probe = null;
  gazeSource = null;
  gaze = null;
  scene.background = desktopBackground;
  panel.hide();
  reticle.visible = false;
  clearMarks();
  steady.clear();
  wasPinching = false;
  lastTime = 0;
  if (home) home.hidden = false;
  showSaved();
}

async function enterAr(): Promise<void> {
  if (!navigator.xr) return;
  const depth = depthSensingInit();
  const started = await navigator.xr.requestSession('immersive-ar', {
    requiredFeatures: ['local-floor'],
    optionalFeatures: ['hand-tracking', 'hit-test', ...depth.optionalFeatures],
    depthSensing: depth.depthSensing,
  });
  scene.background = null;
  if (home) home.hidden = true;
  started.addEventListener('end', endSession);
  await renderer.xr.setSession(started);
  const space = renderer.xr.getReferenceSpace();
  probe = space ? createDepthProbe(started, space) : null;
  sensing = space
    ? createDepthSampler(started, {
        space,
        gl: renderer.getContext() as WebGL2RenderingContext,
        binding: depthUsageOf(started) === 'gpu-optimized' ? renderer.xr.getBinding() : null,
        windowFar: EMULATE ? 'infinite' : 'reported',
      })
    : null;
  gazeSource = preferDepthSensing(sensing, probe);
  // Marks of the last session are gone with its world frame; finished samples carry over.
  clearMarks();
  resumeOrRestart();
  flash = null;
  session = started;
}

/** PassthroughCamera keeps its video private; the panel draws straight from it. */
function cameraVideo(source: PassthroughCamera): HTMLVideoElement | null {
  const { video: element } = source as unknown as { video?: unknown };
  return element instanceof HTMLVideoElement ? element : null;
}

/** The rotation taking unit vector `from` onto unit vector `to`. */
function rotationBetween(from: Readonly<Vec3>, to: Readonly<Vec3>): Quat {
  const axis = cross(from, to);
  const s = length(axis);
  const angle = Math.atan2(s, dot(from, to));
  return s < 1e-12 ? [0, 0, 0, 1] : quatFromAxisAngle(normalize(axis), angle);
}

const nextFrame = () => new Promise((r) => requestAnimationFrame(r));

/**
 * Emulator only: moves the right hand (fingertip steps) or turns the head (mark steps) so the
 * hidden true camera sees the point on the crosshair.
 */
async function aim(): Promise<void> {
  const step = flow?.step;
  if (!emulated || !sim || !step || step.kind === 'place') return;
  const k = sim.intrinsics;
  const [x, y] = uvToNormalized(k, step.uv);
  const want = rotateVec(sim.truth.q, normalize([x, y, -1]));
  for (let i = 0; i < 6; i++) {
    if (!headPose) return;
    if (step.kind === 'finger') {
      if (!tipWorld) return;
      const inHead = madd(sim.truth.p, want, REACH_DEPTH[step.reach]);
      emulated.nudgeRightTip(sub(transformPoint(headPose, inHead), tipWorld), tipWorld);
    } else {
      const mark = marks[step.mark];
      if (!mark) return;
      const inHead = transformPoint(invertPose(headPose), mark);
      const seen = normalize(sub(inHead, sim.truth.p));
      // Turning the head by want-to-seen brings the mark onto the wanted ray (the camera is near
      // the head's center, so a few rounds settle it).
      const turn = rotationBetween(want, seen);
      emulated.turnHead(quatNormalize(quatMultiply(headPose.q, turn)));
    }
    for (let f = 0; f < 4; f++) await nextFrame();
  }
}

Object.defineProperty(window, '__calibrate', {
  configurable: true,
  value: {
    aim,
    get state() {
      return {
        session: session !== null,
        xrFrames,
        taken: flow?.taken ?? 0,
        total: flow?.total ?? 0,
        step: flow?.step ?? null,
        head: headPose,
        gaze,
        marks,
        tipHead,
        fit: flow?.fit ?? null,
        usable: flow?.fit ? flow.usable(flow.fit) : null,
        truth: sim ? { pose: sim.truth, fx: sim.intrinsics.fx } : null,
        saved,
      };
    },
  },
});

async function init(): Promise<void> {
  showSaved();
  if (EMULATE) {
    emulated = await installCalibrationEmulator();
    (window as unknown as { clio: unknown }).clio = emulated;
  }
  const opened = EMULATE ? null : await PassthroughCamera.open();
  const supported = (await navigator.xr?.isSessionSupported('immersive-ar')) ?? false;
  if (opened) {
    // The raw model, never one with a stored calibration applied: each run starts from the guess
    // (or the lens metadata), not from the last run's result.
    model = opened.model();
    base = calibrationBase(opened.settings);
    const element = cameraVideo(opened);
    if (element)
      video = { source: element, width: model.intrinsics.width, height: model.intrinsics.height };
  } else if (EMULATE) {
    model = defaultQuestCameraModel(1280, 960);
    // A hidden true camera off the guess in position, orientation and focal length.
    const truth: Pose = {
      p: add(model.headFromCamera.p, [0.009, -0.006, 0.012]),
      q: correctedRotation(model.headFromCamera.q, 1.5 * DEG, 2 * DEG, 0.5 * DEG),
    };
    const k = model.intrinsics;
    sim = new SimulatedCamera({ ...k, fx: k.fx * 1.06, fy: k.fy * 1.06 }, truth);
    video = { source: sim.canvas, width: sim.canvas.width, height: sim.canvas.height };
  }
  if (model) {
    flow = new CalibrationFlow({ intrinsics: model.intrinsics, initial: model.headFromCamera });
    resumeOrRestart();
  }
  if (!button) return;
  const label = 'Calibrate';
  button.textContent = !supported ? 'AR not available' : model ? label : 'No camera';
  button.disabled = !supported || !model;
  // A pinch on the Quest can land as two clicks; a second requestSession while one is pending fails.
  button.addEventListener('click', () => {
    if (button.disabled) return;
    button.disabled = true;
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

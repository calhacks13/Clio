import type { PrimaryResponse } from '@clio/protocol';
import * as THREE from 'three';
import { PassthroughCamera } from '../adapters/camera/passthrough-camera';
import { poseFromMatrix } from '../adapters/xr/frame-sampler';
import { XrPlaneSurfaces } from '../adapters/xr/planes';
import { createLogger } from '../core/log';
import type { Pose } from '../core/math';
import type { CameraModel } from '../domain/world/camera-model';
import type { CameraFrameSource } from '../domain/world/grounding';
import { PoseHistory } from '../domain/world/pose-history';
import { HandsView } from '../tracking/hands';
import { readAnswer } from './answer';
import { PrimaryClient } from './client';
import { createDepthProbe, type XrDepthProbe } from './depth';
import { type FrameImage, FrameStream, jpegBase64, videoFrames } from './frame-stream';
import { PrimaryHud } from './hud';
import { LatestOnly } from './latest-only';
import { PrimaryLoop, trackerUpdate } from './loop';
import { PrimaryOutlineView } from './outline-view';
import { PhotoView } from './photo-view';
import {
  measureDepth,
  type ObjectMask,
  type Placement,
  placeOutline,
  surfaceOrTable,
} from './placement';
import { StillImageCamera } from './still-image';
import { TrackerClient, type TrackerMask, trackerUrl } from './tracker-client';

// The primary-object demo (/primary.html): about once a second the server names the main object
// in the passthrough camera's view (Gemini picks it, jev boxes it), and in between the tracker on
// the Mac (YOLOE-26 + ByteTrack) outlines it on every camera frame streamed to it
// (tracker/TRACK.md). Its outline is drawn around the real object with the name above it; both
// hands are drawn as skeletons. Without the tracker, each answer's own outline is drawn instead.
// Either way the outline is placed at the object's measured distance (hit-test along its camera
// rays, see placement.ts), so it lines up for both eyes, not just the one next to the camera.
// ?image=/demo/<file>.jpg replaces the camera with a photo, ?emulate=1 runs against IWER's
// synthetic room, and ?debug=1 shows the last name, the tracker's rate and the look time.
//
// The Quest runs hot, so the page stays light: 72 Hz when the runtime offers it, the stream's
// limits (frame-stream.ts), the looks reusing streamed frames, and the room's planes read once per
// answer rather than every frame.

const log = createLogger('primary');
const params = new URLSearchParams(location.search);
/** Quest 3's lowest refresh rate; the demo draws little and doesn't need more. */
const TARGET_FRAME_RATE = 72;
/**
 * A camera frame stamped further back than this is taken as captured now (ms). The frame clock
 * (requestVideoFrameCallback) may stop during an immersive session, leaving a time from before
 * it, and the pose history would then answer with its oldest pose.
 */
const MAX_FRAME_AGE_MS = 200;
/** A look reuses the last streamed frame if it went out at most this long ago (ms). */
const STREAMED_FRAME_MAX_AGE_MS = 1000;

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
const outline = new PrimaryOutlineView();
const hud = params.get('debug') === '1' ? new PrimaryHud() : null;
scene.add(hands.object, outline.object);
if (hud) scene.add(hud.object);

/** Head poses, so a camera frame is lifted from where the head was when it was captured. */
const poses = new PoseHistory(128);
const surfaces = new XrPlaneSurfaces();
let planesEnabled = false;
/** Hit-test along camera rays, for the session; null without hit-test (planes are used then). */
let probe: XrDepthProbe | null = null;
let source: CameraFrameSource | null = null;
/** The camera's newest frame for the tracker. */
let frames: (() => FrameImage | null) | null = null;
/** ?image= only: the photo behind the outline. */
let photo: PhotoView | null = null;

interface Look {
  response: PrimaryResponse;
  model: CameraModel;
  head: Pose;
  /** The streamed frame it was measured on; null when the frame was captured just for it. */
  seq: number | null;
}

/** The latest answer, handled on the next XR frame (planes can only be read inside one). */
let pending: { look: Look; cycleMs: number } | null = null;
/** The tracker's latest mask, drawn on the next XR frame. */
let pendingMask: TrackerMask | null = null;
/** The name of the object the latest answer named: the outline's label. */
let label: string | null = null;
/** The object the tracker was told to follow, if any. */
let tracking: string | null = null;
let staleFrameLogged = false;

/** When the frame was captured, unless its stamp is clearly stale (see MAX_FRAME_AGE_MS). */
function captureTime(frameT: number): number {
  const now = performance.now();
  const age = now - frameT;
  if (age <= MAX_FRAME_AGE_MS) return frameT;
  if (!staleFrameLogged) {
    staleFrameLogged = true;
    log.warn(`camera frame stamped ${Math.round(age)} ms ago; using the current head pose`);
  }
  return now;
}

const tracker = new TrackerClient({
  url: trackerUrl(location),
  mask(mask) {
    stream.received(mask.seq);
    pendingMask = mask;
  },
  connection(open) {
    // A new connection starts without a target.
    if (!open) tracking = null;
  },
});

const stream = new FrameStream({
  now: () => performance.now(),
  ready: () => tracker.connected,
  grab() {
    const image = frames?.();
    return image ? { ...image, t: captureTime(image.t) } : null;
  },
  send: ({ jpeg, ...header }) => tracker.sendFrame(header, jpeg),
  failed(err) {
    log.warn(`frame encoding failed: ${String(err)}`);
  },
});

/**
 * The frame for a look: the last one streamed if it is recent (its seq tells the tracker which
 * frame jev's box is from), else a fresh capture.
 */
async function lookFrame(): Promise<{ t: number; jpegBase64: string; seq: number | null } | null> {
  const streamed = tracker.connected ? stream.latest(STREAMED_FRAME_MAX_AGE_MS) : null;
  if (streamed) {
    return { t: streamed.t, jpegBase64: await jpegBase64(streamed.jpeg), seq: streamed.seq };
  }
  const frame = await source?.capture();
  return frame ? { t: captureTime(frame.t), jpegBase64: frame.jpegBase64, seq: null } : null;
}

const client = new PrimaryClient();
const loop = new PrimaryLoop<Look>({
  now: () => performance.now(),
  async ask(previous, signal) {
    const frame = await lookFrame();
    const model = source?.model();
    const head = frame && poses.at(frame.t);
    if (!frame || !model || !head) return null;
    const response = await client.ask(
      {
        image: { mimeType: 'image/jpeg', data: frame.jpegBase64 },
        ...(previous ? { previous: { name: previous } } : {}),
      },
      signal,
    );
    return { response, model, head, seq: frame.seq };
  },
  answer(look, cycleMs) {
    pending = { look, cycleMs };
  },
  failed(err) {
    log.warn(`look failed: ${err instanceof Error ? err.message : String(err)}`);
  },
});

/**
 * Where an object seen in a frame captured from `head` is in the room, at its measured distance.
 * Every tracker mask and every answer is placed here.
 */
async function place(mask: ObjectMask, model: CameraModel, head: Pose): Promise<Placement | null> {
  const surface = surfaceOrTable(planesEnabled ? surfaces : null, head);
  const depth = await measureDepth(mask, model, head, probe, surface);
  return depth && placeOutline(mask, head, model, depth);
}

/** Bumped by every outline update. */
let outlineSeq = 0;
/** The newest update drawn, so a placement measured after a newer update is dropped. */
let shownSeq = 0;
/** One placement at a time, so every one gets its hit-test rays (latest-only.ts). */
const placements = new LatestOnly();

/** Outline the object in `mask` once it is placed, or fade the last outline when there is none. */
function outlineAt(mask: ObjectMask | null, name: string, model: CameraModel, head: Pose): void {
  const seq = ++outlineSeq;
  if (!mask) {
    shownSeq = seq;
    placements.clear();
    outline.fade();
    return;
  }
  placements.run(async () => {
    try {
      const placement = await place(mask, model, head);
      if (seq <= shownSeq) return;
      shownSeq = seq;
      if (!placement) {
        outline.fade();
        return;
      }
      outline.show(placement, name);
      photo?.place(placement.center, model, head);
    } catch (err) {
      log.warn(`placement failed: ${String(err)}`);
    }
  });
}

/**
 * A new answer: its name labels the outline and tells the tracker what to follow. While the
 * tracker follows the frames, its masks draw the outline; otherwise the answer's own outline is.
 */
function showAnswer({ response, model, head, seq }: Look, cycleMs: number): void {
  const answer = readAnswer(response);
  label = answer.name;
  hud?.show(answer.name, cycleMs);
  const update = trackerUpdate(answer, seq, tracking);
  if (update && tracker.send(update)) tracking = update.type === 'target' ? update.name : null;
  if (seq !== null && tracker.connected) return;
  outlineAt(answer.found ? answer.detection : null, answer.name ?? '', model, head);
}

/** Outline the tracked object where it was in the mask's frame, or fade when it was lost. */
function showMask(mask: TrackerMask): void {
  const model = source?.model();
  const head = poses.at(mask.t);
  if (!model || !head) return;
  outlineAt(mask.found ? mask : null, label ?? mask.name ?? '', model, head);
}

const head = new THREE.Vector3();
const orientation = new THREE.Quaternion();
let lastTime = 0;
/** When the HUD's tracker rate was last shown (it changes too often to re-lay out every frame). */
let lastRateT = Number.NEGATIVE_INFINITY;
const RATE_EVERY_MS = 500;

function track(frame: XRFrame, time: number): void {
  const space = renderer.xr.getReferenceSpace();
  const viewer = space && frame.getViewerPose(space);
  if (!space || !viewer) return;
  const pose = poseFromMatrix(viewer.transform.matrix);
  poses.push(time, pose);
  head.set(...pose.p);
  orientation.set(...pose.q);
  const dt = lastTime > 0 ? time - lastTime : 0;
  lastTime = time;

  probe?.update(frame);
  if (pending) {
    if (planesEnabled) surfaces.update(frame, space);
    showAnswer(pending.look, pending.cycleMs);
    pending = null;
  }
  if (pendingMask) {
    showMask(pendingMask);
    pendingMask = null;
  }
  hands.update(frame, space, time, orientation);
  stream.tick();
  loop.tick();
  outline.update(head, dt, time);
  if (hud && time - lastRateT >= RATE_EVERY_MS) {
    hud.showRate(stream.fps);
    lastRateT = time;
  }
  hud?.update(head, orientation, dt);
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

const button = document.querySelector<HTMLButtonElement>('#enter');

let session: XRSession | null = null;

/**
 * Stream frames and look (paid) only while the session is shown: not after it ends, while the
 * system menu covers it, or while the page is hidden. (IWER's emulated session has no
 * visibilityState.)
 */
function updateStreaming(): void {
  const covered =
    session?.visibilityState === 'hidden' || session?.visibilityState === 'visible-blurred';
  const shown = session !== null && !covered && document.visibilityState === 'visible';
  if (shown && !stream.streaming) {
    stream.start();
    loop.start();
  } else if (!shown && stream.streaming) {
    stream.stop();
    loop.stop();
  }
}

document.addEventListener('visibilitychange', updateStreaming);

function endSession(): void {
  session = null;
  updateStreaming();
  tracker.close();
  loop.stop();
  probe?.close();
  probe = null;
  pending = null;
  pendingMask = null;
  placements.clear();
  shownSeq = ++outlineSeq;
  label = null;
  tracking = null;
  scene.background = desktopBackground;
  hands.hide();
  outline.clear();
  photo?.hide();
  hud?.hide();
  lastTime = 0;
  lastRateT = Number.NEGATIVE_INFINITY;
  if (button) button.hidden = false;
}

async function enterAr(): Promise<void> {
  if (!navigator.xr || !button) return;
  const started = await navigator.xr.requestSession('immersive-ar', {
    requiredFeatures: ['local-floor'],
    optionalFeatures: ['hand-tracking', 'plane-detection', 'hit-test'],
  });
  // Runtimes that don't list enabled features get the benefit of the doubt.
  planesEnabled = started.enabledFeatures?.includes('plane-detection') ?? true;
  scene.background = null;
  button.hidden = true;
  started.addEventListener('end', endSession);
  started.addEventListener('visibilitychange', updateStreaming);
  await renderer.xr.setSession(started);
  const space = renderer.xr.getReferenceSpace();
  probe = space && createDepthProbe(started, space);
  await lowerFrameRate(started);
  session = started;
  tracker.open();
  updateStreaming();
}

async function lowerFrameRate(session: XRSession): Promise<void> {
  if (!session.supportedFrameRates?.includes(TARGET_FRAME_RATE)) return;
  try {
    await session.updateTargetFrameRate(TARGET_FRAME_RATE);
  } catch (err) {
    log.warn(`could not switch to ${TARGET_FRAME_RATE} Hz: ${String(err)}`);
  }
}

/** PassthroughCamera keeps its video private; the stream draws its frames straight from it. */
function cameraVideo(camera: PassthroughCamera): HTMLVideoElement | null {
  const { video } = camera as unknown as { video?: unknown };
  return video instanceof HTMLVideoElement ? video : null;
}

/** The photo from ?image=, else the passthrough camera (opened here: a prompt in XR ends it). */
async function openCamera(): Promise<CameraFrameSource | null> {
  const image = params.get('image');
  if (!image) return PassthroughCamera.open();
  try {
    return await StillImageCamera.load(image);
  } catch (err) {
    log.warn(`could not load ${image}: ${String(err)}`);
    return null;
  }
}

async function init(): Promise<void> {
  if (params.get('emulate') === '1') {
    const { installEmulator } = await import('../adapters/xr/emulator');
    (window as unknown as { clio: unknown }).clio = await installEmulator();
  }
  const [supported, opened] = await Promise.all([
    navigator.xr?.isSessionSupported('immersive-ar') ?? false,
    openCamera(),
  ]);
  source = opened;
  if (opened instanceof StillImageCamera) {
    photo = new PhotoView(opened.image);
    scene.add(photo.object);
    frames = () => opened.grab();
  } else if (opened instanceof PassthroughCamera) {
    const video = cameraVideo(opened);
    frames = video ? videoFrames(video) : null;
  }
  if (!button) return;
  const label = source ? 'Enter AR' : 'Enter AR without camera';
  button.textContent = supported ? label : 'AR not available';
  button.disabled = !supported;
  // A pinch on the Quest can land as two clicks; a second requestSession while one is pending fails.
  button.addEventListener('click', () => {
    if (button.disabled) return;
    button.disabled = true;
    button.textContent = label;
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

import type { PrimaryResponse } from '@clio/protocol';
import * as THREE from 'three';
import { PassthroughCamera } from '../adapters/camera/passthrough-camera';
import {
  applyStoredCalibration,
  type CalibrationBase,
  calibrationBase,
  cameraOffsetFromParams,
  loadStoredCalibration,
  storedCalibrationFits,
} from '../adapters/camera/stored-calibration';
import { ApiClient } from '../adapters/net/api-client';
import { HttpEpisodeSink } from '../adapters/net/http-episode-sink';
import { depthOverlay } from '../adapters/render/glow/depth-occlusion';
import { poseFromMatrix } from '../adapters/xr/frame-sampler';
import { XrPlaneSurfaces } from '../adapters/xr/planes';
import { createLogger } from '../core/log';
import { composePose, type Pose } from '../core/math';
import type { CameraModel } from '../domain/world/camera-model';
import type { CameraFrameSource } from '../domain/world/grounding';
import { PoseHistory } from '../domain/world/pose-history';
import { HandOccluders } from '../tracking/hand-occluders';
import { HandsView } from '../tracking/hands';
import { readAnswer } from './answer';
import { PrimaryClient } from './client';
import { boxMask, DebugBoxes, debugFlags } from './debug-boxes';
import { createDepthProbe, type DepthSource, type XrDepthProbe } from './depth';
import { DepthMemory } from './depth-memory';
import {
  createDepthSampler,
  type DepthSampler,
  depthSensingInit,
  disableXrDepthOcclusion,
  preferDepthSensing,
} from './depth-sensing';
import {
  type FrameImage,
  FrameStream,
  frameSize,
  RecentSamples,
  videoFrames,
} from './frame-stream';
import { PrimaryHud } from './hud';
import { LatestOnly } from './latest-only';
import { PrimaryLoop, trackerUpdate } from './loop';
import { motionOptionsFromParams, OutlineMotion } from './motion-smoothing';
import { PrimaryOutlineView } from './outline-view';
import { PhotoView } from './photo-view';
import {
  maskRays,
  measureDepth,
  type ObjectDepth,
  type ObjectMask,
  placeOutline,
  surfaceOrTable,
} from './placement';
import { PrimaryRecording } from './recording';
import { StillImageCamera } from './still-image';
import { TrackerClient, type TrackerMask, trackerUrl } from './tracker-client';

// The primary-object demo (/primary.html): about once a second the server names the main object
// in the passthrough camera's view (Gemini picks it, jev boxes it), and in between the tracker on
// the Mac (YOLOE-26 + ByteTrack) outlines it on every camera frame streamed to it
// (tracker/TRACK.md). Its outline is drawn around the real object with the name above it; both
// hands are drawn as skeletons. Without the tracker, each answer's own outline is drawn instead.
// Either way the outline is placed at the object's measured distance (the runtime's depth map
// along its camera rays, depth-sensing.ts, else hit-test; see placement.ts), so it lines up for
// both eyes, not just the one next to the camera. The camera's pose is calibrate.html's, when one
// was saved (stored-calibration.ts).
// A tracker mask is placed at once at its target's last measured distance (depth-memory.ts), so
// it is drawn on the frame it arrives. Each session is recorded as an episode (recording.ts): head,
// hands and the target's placed outlines. ?image=/demo/<file>.jpg replaces the camera with a photo,
// ?emulate=1 runs against IWER's synthetic room, ?frame=640|512|480|320 sets the streamed frames'
// width (frame-stream.ts), and ?debug=1 shows the last name, the tracker's rate, how long a frame
// takes from capture to its answer and to its outline being drawn, and the look time (the same
// numbers are on window.__primaryStats). ?debug=boxes shows jev's box and the tracker's mask on
// the frame they were measured on, and jev's box in the room (debug-boxes.ts;
// window.__primaryDebug). Both show by default; ?debug=0 hides them.
// The placed outline is steadied in the room and drawn where the object is now, its frame's
// latency predicted away, and held a moment through short losses (motion-smoothing.ts: ?smooth=0
// turns that off; ?minCutoff=, ?beta=, ?predictMs=, ?holdMs= and the rest tune it).
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
/**
 * Between namings (a Gemini pick takes 1.5 s or so), jev boxes the named object again this often
 * (ms): a request with `known` skips Gemini and costs only a jev call. ?refindMs= tunes it; 0 turns
 * it off.
 */
const REFIND_MS = Number(params.get('refindMs') ?? 333);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
// three's default is full fixed foveation, which renders the edges of the view at a fraction of
// the resolution and makes the glow look blocky away from the centre; the demo draws little, so
// render all of it sharp, and above the browser's default resolution (?fbScale= tunes it).
renderer.xr.setFoveation(0);
renderer.xr.setFramebufferScaleFactor(Number(params.get('fbScale') ?? 1.25));
// The depth map measures objects; it must not hide the outline behind them.
disableXrDepthOcclusion(renderer);
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
/** The real hands in the depth buffer, so the glow behind a hand stays behind it. */
const handOccluders = new HandOccluders();
// The glow fades where the depth map sees a real surface in front of it (IWER: see windowFar).
const outline = new PrimaryOutlineView({
  windowFar: params.get('emulate') === '1' ? 'infinite' : 'reported',
});
/** Steadies the outline and draws it where the object is now (motion-smoothing.ts); ?smooth=0: off. */
const MOTION_OPTIONS = motionOptionsFromParams(params);
const motion = MOTION_OPTIONS && new OutlineMotion(MOTION_OPTIONS);
/** The smoothed shape last handed to the outline view, and the name drawn with it. */
let shownShape = -1;
let motionName = '';
const DEBUG = debugFlags(params);
const hud = DEBUG.has('1') ? new PrimaryHud() : null;
/** ?debug=boxes: jev's box and the tracker's mask on the frame they belong to (debug-boxes.ts). */
const debugBoxes = DEBUG.has('boxes') ? new DebugBoxes() : null;
/** ?focus=part: one part of the main object is highlighted, not all of it. */
const FOCUS_PART = params.get('focus') === 'part';
// depthOverlay: window.__occlusion.setViz('depth') shows the depth map over the view.
scene.add(hands.object, handOccluders.object, outline.object, depthOverlay.object);
if (hud) scene.add(hud.object);
if (debugBoxes) {
  scene.add(debugBoxes.panel, debugBoxes.box);
  Object.defineProperty(window, '__primaryDebug', {
    get: () => debugBoxes.snapshot(),
    configurable: true,
  });
}

/** Head poses, so a camera frame is lifted from where the head was when it was captured. */
const poses = new PoseHistory(128);
const surfaces = new XrPlaneSurfaces();
let planesEnabled = false;
/** Hit-test along camera rays, for the session; null without hit-test (planes are used then). */
let probe: XrDepthProbe | null = null;
/** The session's depth maps along camera rays; null without depth sensing. */
let sensing: DepthSampler | null = null;
/** Depth sensing first, hit-test for the rays it misses; null with neither (planes then). */
let depthSource: DepthSource | null = null;
/** Rays each answered (window.__primaryStats). */
const depthRays = { sensing: 0, hitTest: 0 };
let source: CameraFrameSource | null = null;
/** What the camera model is (the browser's lens metadata or the default guess). */
let cameraBase: CalibrationBase = 'default';
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
  /** When that frame was captured. */
  t: number;
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

/** Capture to the tracker's answer, and to its outline being drawn (ms). */
const answerMs = new RecentSamples();
const drawnMs = new RecentSamples();
/** 1 for a mask placed at once at a remembered distance, 0 for one that waited for hit-test. */
const placedAtOnce = new RecentSamples();
const frameMs = new RecentSamples();
/** The capture time of the mask whose outline the next render draws. */
let drawnMaskT: number | null = null;

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

/**
 * ?tracker=<port> connects straight to a tracker on that port (adb reverse it too) instead of the
 * one Vite proxies, to compare models; window.__setTracker(port | null) switches live, in AR.
 */
function trackerUrlFor(port: string | null): string {
  return port && /^\d+$/.test(port) ? `ws://localhost:${port}/track` : trackerUrl(location);
}

const tracker = new TrackerClient({
  url: trackerUrlFor(params.get('tracker')),
  mask(mask) {
    answerMs.add(performance.now() - mask.t);
    stream.received(mask.seq);
    debugBoxes?.mask(mask);
    pendingMask = mask;
  },
  connection(open) {
    // A new connection starts without a target.
    if (open) return;
    tracking = null;
    depths.forget();
  },
});
(window as unknown as { __setTracker: (port: string | null) => void }).__setTracker = (port) =>
  tracker.setUrl(trackerUrlFor(port));

const FRAME_SIZE = frameSize(params.get('frame'));
const stream = new FrameStream({
  now: () => performance.now(),
  options: FRAME_SIZE,
  ready: () => tracker.connected,
  grab() {
    const image = frames?.();
    return image ? { ...image, t: captureTime(image.t) } : null;
  },
  send(frame) {
    const { jpeg, ...header } = frame;
    const sent = tracker.sendFrame(header, jpeg.bytes);
    if (sent) debugBoxes?.frameSent(frame);
    return sent;
  },
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
    return { t: streamed.t, jpegBase64: streamed.jpeg.base64, seq: streamed.seq };
  }
  const frame = await source?.capture();
  if (frame) debugBoxes?.lookFrame(captureTime(frame.t), frame.jpegBase64);
  return frame ? { t: captureTime(frame.t), jpegBase64: frame.jpegBase64, seq: null } : null;
}

const client = new PrimaryClient();
/** The object the latest naming answered with: what the refind loop asks jev for again. */
let known: { name: string; description: string } | null = null;
/** The capture time of the newest answer taken, so an older refind can't replace it. */
let takenT = Number.NEGATIVE_INFINITY;

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
        // ?focus=part highlights one part of the main object (a label, button, wheel).
        ...(params.get('focus') === 'part' ? { focus: 'part' as const } : {}),
      },
      signal,
    );
    return { response, model, head, seq: frame.seq, t: frame.t };
  },
  answer(look, cycleMs) {
    // A naming always wins: it is the authority on which object it is.
    const { name, description } = look.response;
    known = name && description ? { name, description } : null;
    takenT = look.t;
    pending = { look, cycleMs };
  },
  failed(err) {
    log.warn(`look failed: ${err instanceof Error ? err.message : String(err)}`);
  },
});

/** jev alone, on the named object, between namings (REFIND_MS). */
const refind = new PrimaryLoop<Look & { asked: string }>({
  now: () => performance.now(),
  options: { periodMs: REFIND_MS },
  async ask(_previous, signal) {
    const asked = known;
    if (!asked) return null;
    const frame = await lookFrame();
    const model = source?.model();
    const head = frame && poses.at(frame.t);
    if (!frame || !model || !head) return null;
    const response = await client.ask(
      { image: { mimeType: 'image/jpeg', data: frame.jpegBase64 }, known: asked },
      signal,
    );
    return { response, model, head, seq: frame.seq, t: frame.t, asked: asked.name };
  },
  answer(look, cycleMs) {
    // Dropped once a naming moved on to another object, or a newer answer was taken.
    if (look.asked !== known?.name || look.t <= takenT) return;
    takenT = look.t;
    pending = { look, cycleMs };
  },
  failed(err) {
    log.warn(`refind failed: ${err instanceof Error ? err.message : String(err)}`);
  },
});

/**
 * How far an object seen in a frame captured from `head` is: depth sensing, else hit-test, along
 * its camera rays, answered a few XR frames later. `model` is already tuned (withCameraOffset).
 */
function measure(mask: ObjectMask, model: CameraModel, head: Pose): Promise<ObjectDepth | null> {
  const surface = surfaceOrTable(planesEnabled ? surfaces : null, head);
  return measureDepth(mask, model, head, depthSource, surface);
}

/** `source`, counting the rays it answers into depthRays[key]. */
function counted(source: DepthSource | null, key: keyof typeof depthRays): DepthSource | null {
  if (!source) return null;
  return {
    async measure(rays) {
      const hits = await source.measure(rays);
      depthRays[key] += hits.filter((hit) => hit !== null).length;
      return hits;
    },
  };
}

/**
 * Quest Browser 154 reports no lens calibration, so the camera's pose on the headset is a guess
 * (calibration.ts) unless calibrate.html saved one. ?camX=, ?camY=, ?camZ= (meters, head frame:
 * +x right, +y up, -z forward) replace either's position, to line outlines up with the real camera.
 */
const STORED_CAMERA = loadStoredCalibration();
const CAMERA_OFFSET = cameraOffsetFromParams(params);
function withCameraOffset(model: CameraModel): CameraModel {
  return applyStoredCalibration(model, cameraBase, STORED_CAMERA, CAMERA_OFFSET);
}

/** Bumped by every outline update. */
let outlineSeq = 0;
/** The newest update drawn, so a placement measured after a newer update is dropped. */
let shownSeq = 0;
/** One measurement at a time, so every one gets its hit-test rays (latest-only.ts). */
const placements = new LatestOnly();
/** The tracked target's last measured distance. */
const depths = new DepthMemory();

const recording = new PrimaryRecording({
  sink: new HttpEpisodeSink(new ApiClient()),
  onDrop: (why) => log.warn(`recording: dropped ${why}`),
});

/** What a drawn outline is recorded as: its target, when its frame was captured, and the score. */
interface Sighting {
  name: string;
  t: number;
  score: number | null;
}

/** Nothing to outline now: the smoothed outline is held a moment before it fades. */
function hideOutline(): void {
  if (motion) motion.lose(performance.now());
  else outline.fade();
}

/**
 * The smoothed outline, every XR frame, where the object is now: a new shape when one came (the
 * glow is rebuilt only then), else just moved.
 */
function presentMotion(): void {
  const frame = motion?.at(performance.now());
  if (!frame) {
    outline.fade();
    return;
  }
  if (frame.shapeVersion !== shownShape) {
    shownShape = frame.shapeVersion;
    outline.show(frame.placement, motionName);
  } else {
    outline.object.position.set(...frame.placement.center);
  }
}

/**
 * Draw the outline of `mask` at `depth` (seen from `head` in a frame captured at `t`), or fade it
 * when it can't be placed. A placed outline is recorded as `seen`, if given.
 */
function draw(
  mask: ObjectMask,
  name: string,
  model: CameraModel,
  head: Pose,
  depth: ObjectDepth | null,
  seen: Sighting | null,
  t: number,
): void {
  const placement = depth && placeOutline(mask, head, model, depth);
  if (!placement) {
    hideOutline();
    return;
  }
  if (motion) {
    const eye = composePose(head, model.headFromCamera).p;
    motion.add({ key: name, placement, t, eye });
    motionName = name;
  } else {
    outline.show(placement, name);
  }
  photo?.place(placement.center, model, head);
  if (seen) recording.placed(seen.name, placement.center, seen.t, seen.score);
}

/**
 * Outline the object in `mask` once its distance is measured, or fade the last outline when there
 * is none. A tracker mask (`target`: what the tracker follows) leaves its distance for the next.
 * The placed outline is recorded as `seen`, if given.
 */
function outlineAt(
  mask: ObjectMask | null,
  name: string,
  model: CameraModel,
  head: Pose,
  target: string | null = null,
  maskT: number | null = null,
  seen: Sighting | null = null,
): void {
  const seq = ++outlineSeq;
  if (!mask) {
    shownSeq = seq;
    placements.clear();
    hideOutline();
    return;
  }
  const tuned = withCameraOffset(model);
  const epoch = depths.epoch;
  placements.run(async () => {
    try {
      const depth = await measure(mask, tuned, head);
      const rays = target !== null && depth && maskRays(mask, tuned, head);
      if (rays && target !== null && depth) {
        depths.remember(target, mask, rays.point, depth, performance.now(), epoch);
      }
      if (seq <= shownSeq) return;
      shownSeq = seq;
      draw(mask, name, tuned, head, depth, seen, maskT ?? seen?.t ?? performance.now());
      if (maskT !== null) drawnMaskT = maskT;
    } catch (err) {
      log.warn(`placement failed: ${String(err)}`);
    }
  });
}

/**
 * Outline a tracker mask on this frame, at its target's last measured distance along the mask's
 * own ray, and measure that distance again in the background when it is due; once measured, the
 * outline is redrawn at it if no newer mask was drawn meanwhile. False when the target has no
 * measured distance yet (the caller measures it first).
 */
function outlineAtOnce(
  mask: TrackerMask,
  name: string,
  model: CameraModel,
  head: Pose,
  target: string,
  seen: Sighting | null,
): boolean {
  const tuned = withCameraOffset(model);
  const rays = maskRays(mask, tuned, head);
  const now = performance.now();
  const reused = rays && depths.reuse(target, mask, rays.point, now);
  if (!rays || !reused) return false;
  const seq = ++outlineSeq;
  shownSeq = seq;
  draw(mask, name, tuned, head, reused, seen, mask.t);
  drawnMaskT = mask.t;
  if (!depths.shouldMeasure(target, mask, now)) return true;
  const epoch = depths.epoch;
  placements.run(async () => {
    try {
      const depth = await measure(mask, tuned, head);
      if (!depth) return;
      depths.remember(target, mask, rays.point, depth, performance.now(), epoch);
      if (seq !== shownSeq) return;
      draw(mask, name, tuned, head, depth, seen, mask.t);
    } catch (err) {
      log.warn(`placement failed: ${String(err)}`);
    }
  });
  return true;
}

/** ?debug=boxes: jev's box on the panel, and in the room placed the way the outline would be. */
function showDebugBox(
  answer: ReturnType<typeof readAnswer>,
  model: CameraModel,
  head: Pose,
  seq: number | null,
  t: number,
): void {
  const box = answer.found ? answer.detection.box : null;
  debugBoxes?.answer({ name: answer.name, box, seq, t });
  if (!box) {
    debugBoxes?.place(null);
    return;
  }
  const mask = boxMask(box);
  const tuned = withCameraOffset(model);
  const eye = composePose(head, tuned.headFromCamera).p;
  measure(mask, tuned, head)
    .then((depth) => debugBoxes?.place(depth && placeOutline(mask, head, tuned, depth), eye))
    .catch((err: unknown) => log.warn(`debug box placement failed: ${String(err)}`));
}

/**
 * A new answer: its name labels the outline and tells the tracker what to follow. While the
 * tracker follows the frames, its masks draw the outline; otherwise the answer's own outline is.
 */
function showAnswer({ response, model, head, seq, t }: Look, cycleMs: number): void {
  const answer = readAnswer(response);
  label = answer.name;
  // Before this frame's mask, so a mask still in flight for the last target isn't recorded.
  recording.answer(response, t);
  hud?.show(answer.name, cycleMs);
  if (debugBoxes) showDebugBox(answer, model, head, seq, t);
  const found = trackerUpdate(answer, seq, tracking);
  // The tracker ignores fields it doesn't know (TRACK.md); `part` says jev boxed a part.
  const update = found?.type === 'target' && FOCUS_PART ? { ...found, part: true } : found;
  if (update && tracker.send(update)) {
    if (update.type === 'target') debugBoxes?.target(update);
    const next = update.type === 'target' ? update.name : null;
    if (next !== tracking) depths.forget();
    tracking = next;
  }
  if (seq !== null && tracker.connected) return;
  if (!answer.found && answer.name) recording.lost(answer.name, t);
  const seen = answer.found ? { name: answer.name, t, score: null } : null;
  outlineAt(
    answer.found ? answer.detection : null,
    answer.name ?? '',
    model,
    head,
    null,
    null,
    seen,
  );
}

/**
 * Outline the tracked object where it was in the mask's frame, at once when its distance is known,
 * or fade when it was lost (it is measured again once found). It is recorded under the tracker's
 * own target, and only while that is still the one followed: `label` may already name the next.
 */
function showMask(mask: TrackerMask): void {
  const model = source?.model();
  const head = poses.at(mask.t);
  if (!model || !head) return;
  const name = label ?? mask.name ?? '';
  const target = mask.name ?? name;
  const recordable = target !== '' && (mask.name === null || mask.name === tracking);
  const seen = recordable ? { name: target, t: mask.t, score: mask.score } : null;
  if (!mask.found) {
    if (seen) recording.lost(seen.name, mask.t);
    depths.forget();
    outlineAt(null, name, model, head);
    return;
  }
  const atOnce = outlineAtOnce(mask, name, model, head, target, seen);
  placedAtOnce.add(atOnce ? 1 : 0);
  if (atOnce) return;
  depths.shouldMeasure(target, mask, performance.now());
  outlineAt(mask, name, model, head, target, mask.t, seen);
}

const head = new THREE.Vector3();
const orientation = new THREE.Quaternion();
let lastTime = 0;
/** When the HUD's stats were last shown (they change too often to re-lay out every frame). */
let lastStatsT = Number.NEGATIVE_INFINITY;
const STATS_EVERY_MS = 500;

/** What the HUD shows, and more, for reading over CDP (window.__primaryStats). */
function primaryStats() {
  return {
    ...stream.stats,
    answerMs: answerMs.p50,
    drawnMs: drawnMs.p50,
    placedAtOnceShare: placedAtOnce.mean,
    xrFrameMs: frameMs.p50,
    frameWidth: FRAME_SIZE.maxWidth,
    model: tracker.model,
    depthSensing: sensing?.info ?? null,
    depthRays: { ...depthRays },
    smoothing: motion ? { ...motion.stats, options: MOTION_OPTIONS } : null,
    episodeId: recording.episodeId,
  };
}
Object.defineProperty(window, '__primaryStats', { get: primaryStats, configurable: true });

function track(frame: XRFrame, time: number): void {
  const space = renderer.xr.getReferenceSpace();
  const viewer = space && frame.getViewerPose(space);
  if (!space || !viewer) return;
  recording.xrFrame(frame, space, time);
  const pose = poseFromMatrix(viewer.transform.matrix);
  poses.push(time, pose);
  head.set(...pose.p);
  orientation.set(...pose.q);
  const dt = lastTime > 0 ? time - lastTime : 0;
  lastTime = time;
  if (dt > 0) frameMs.add(dt);

  probe?.update(frame);
  sensing?.update(frame);
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
  handOccluders.update(frame, space);
  stream.tick();
  loop.tick();
  if (REFIND_MS > 0) refind.tick();
  if (motion) presentMotion();
  outline.update(head, dt, time);
  if (hud && time - lastStatsT >= STATS_EVERY_MS) {
    hud.showStats(stream.fps, answerMs.p50, drawnMs.p50);
    lastStatsT = time;
  }
  hud?.update(head, orientation, dt);
  debugBoxes?.update(head, orientation, dt, time);
}

renderer.setAnimationLoop((time, frame) => {
  if (frame) track(frame, time);
  renderer.render(scene, camera);
  if (drawnMaskT !== null) {
    drawnMs.add(performance.now() - drawnMaskT);
    drawnMaskT = null;
  }
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
    refind.start();
  } else if (!shown && stream.streaming) {
    stream.stop();
    loop.stop();
    refind.stop();
  }
}

document.addEventListener('visibilitychange', updateStreaming);

function endSession(): void {
  const episode = recording.episodeId;
  void recording.end().then(() => {
    if (episode) log.info(`recorded episode ${episode}`);
  });
  session = null;
  updateStreaming();
  tracker.close();
  loop.stop();
  refind.stop();
  known = null;
  takenT = Number.NEGATIVE_INFINITY;
  probe?.close();
  probe = null;
  sensing?.close();
  sensing = null;
  depthSource = null;
  pending = null;
  pendingMask = null;
  placements.clear();
  depths.forget();
  shownSeq = ++outlineSeq;
  drawnMaskT = null;
  label = null;
  tracking = null;
  scene.background = desktopBackground;
  hands.hide();
  handOccluders.hide();
  motion?.reset();
  shownShape = -1;
  outline.clear();
  debugBoxes?.hide();
  photo?.hide();
  hud?.hide();
  lastTime = 0;
  lastStatsT = Number.NEGATIVE_INFINITY;
  if (button) button.hidden = false;
}

async function enterAr(): Promise<void> {
  if (!navigator.xr || !button) return;
  const depth = depthSensingInit();
  const started = await navigator.xr.requestSession('immersive-ar', {
    requiredFeatures: ['local-floor'],
    optionalFeatures: ['hand-tracking', 'plane-detection', 'hit-test', ...depth.optionalFeatures],
    depthSensing: depth.depthSensing,
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
  sensing =
    space &&
    createDepthSampler(started, {
      space,
      gl: renderer.getContext() as WebGL2RenderingContext,
      binding: started.depthUsage === 'gpu-optimized' ? renderer.xr.getBinding() : null,
      // IWER encodes window depth without a far plane (depth-sensing.ts, decodeFarPlane).
      windowFar: params.get('emulate') === '1' ? 'infinite' : 'reported',
    });
  depthSource = preferDepthSensing(counted(sensing, 'sensing'), counted(probe, 'hitTest'));
  log.info(
    sensing
      ? `depth sensing: ${started.depthUsage}, ${started.depthDataFormat}`
      : 'no depth sensing: hit-test only',
  );
  await lowerFrameRate(started);
  session = started;
  recording.begin({
    userAgent: navigator.userAgent,
    emulated: params.get('emulate') === '1',
    xrFeatures: [...(started.enabledFeatures ?? [])],
    version: __CLIO_VERSION__,
  });
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
  if (opened instanceof PassthroughCamera) cameraBase = calibrationBase(opened.settings);
  const model = opened?.model();
  if (STORED_CAMERA && model) {
    const used = storedCalibrationFits(model, cameraBase, STORED_CAMERA);
    const miss = `${STORED_CAMERA.missMm.toFixed(1)} mm at 1 m`;
    log.info(
      `stored camera calibration (${miss}) ${used ? 'used' : 'made for another camera model'}`,
    );
  }
  if (opened instanceof StillImageCamera) {
    photo = new PhotoView(opened.image);
    // The photo stands in for passthrough, which never hides virtual content: no depth.
    photo.object.material.depthWrite = false;
    photo.object.renderOrder = -1;
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

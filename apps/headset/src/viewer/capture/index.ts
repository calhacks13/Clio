// The viewer's Quest Capture v1 model and what reads it: build one from a Clio episode or a Capture
// package, query it by time, and draw its objects as time series. This barrel includes the three.js
// view; pages without three.js import the pure modules (model, from-clio, clio-events) directly.

export {
  clioEvents,
  type Detection,
  type DetectionMark,
  detectionsAt,
  detectionsFor,
  headWAt,
  type StepEntered,
  stepAt,
} from './clio-events';
export {
  buildCaptureFromClio,
  ClioCaptureBuilder,
  type ClioEpisode,
  GRIP_SOURCE,
  HAND_ENTITY,
  HEADSET,
  rosFromW,
  rosQuatFromW,
  WORKSPACE,
  wFromRos,
  wQuatFromRos,
} from './from-clio';
export { loadCapturePackage, packageFiles } from './from-package';
export {
  Capture,
  Capture as CaptureModel,
  type CaptureEvent,
  type CaptureSpace,
  type Entity,
  type EntityAt,
  entityAt,
  graspMarks,
  HAND_BONES,
  HAND_JOINTS,
  type HandSample,
  type HeldSpan,
  handAt,
  heldAt,
  heldSpanAt,
  type Lane,
  type Location,
  type ObjectKind,
  ORIENTATION_TRACKED,
  ORIENTATION_VALID,
  POSITION_TRACKED,
  POSITION_VALID,
  type PoseSample,
  type Quat,
  Series,
  trail,
  type Vec3,
  validSpans,
} from './model';
export { type ObjectTracksOptions, ObjectTracksView } from './object-tracks-view';

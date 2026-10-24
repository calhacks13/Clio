import {
  Capture,
  type CaptureEvent,
  type Entity,
  HAND_JOINTS,
  type HandSample,
  type Location,
  POSITION_VALID,
  type PoseSample,
} from './model';

// Loads a Quest Capture v1 package (recording.json, scene.json, streams/*.jsonl) into a Capture.
// It checks what the viewer relies on (document kinds, stream record kinds) and leaves the rest of
// validation (hashes, schema, ordering) to the format's own validator. Video is not loaded.

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function document(files: ReadonlyMap<string, string>, path: string, kind: string): Json {
  const text = files.get(path);
  if (text === undefined) throw new Error(`The package has no ${path}`);
  const value: unknown = JSON.parse(text);
  if (!isObject(value) || value.kind !== kind) throw new Error(`${path} is not a ${kind} document`);
  return value;
}

/** File texts by path inside the package (relative to the folder holding recording.json). */
export function loadCapturePackage(files: ReadonlyMap<string, string>): Capture {
  const recording = document(files, 'recording.json', 'recording');
  if (recording.format !== 'quest-capture' || recording.schema_version !== 1) {
    throw new Error('recording.json is not Quest Capture v1');
  }
  const capture = new Capture(typeof recording.task === 'string' ? recording.task : 'Recording');
  if (typeof recording.duration_us === 'number') capture.durationUs = recording.duration_us;

  const scene = document(files, String(recording.scene), 'scene');
  for (const entity of Array.isArray(scene.entities) ? scene.entities : []) {
    if (isObject(entity) && typeof entity.id === 'string')
      capture.addEntity(entity as unknown as Entity);
  }

  for (const stream of Array.isArray(recording.streams) ? recording.streams : []) {
    if (!isObject(stream) || stream.type === 'video_index') continue;
    const path = String(stream.path);
    const text = files.get(path);
    if (text === undefined) throw new Error(`The package has no ${path}`);
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      const record: unknown = JSON.parse(line);
      if (!isObject(record)) continue;
      if (record.kind === 'pose') capture.addPose(record as unknown as PoseSample);
      else if (record.kind === 'hand') capture.addHand(packHand(record));
      else if (record.kind === 'event') capture.addEvent(record as unknown as CaptureEvent);
    }
  }
  return capture;
}

/** A `hand` record with its 26 joint objects packed into arrays (see HandSample). */
export function packHand(record: Json): HandSample {
  const positions = new Float32Array(HAND_JOINTS * 3).fill(Number.NaN);
  const radii = new Float32Array(HAND_JOINTS).fill(Number.NaN);
  const flags = new Uint8Array(HAND_JOINTS);
  const joints = Array.isArray(record.joints) ? record.joints : [];
  joints
    .slice(0, HAND_JOINTS)
    .forEach((joint: { location?: Location; radius_m?: number | null }, i) => {
      const location = joint.location;
      if (!location) return;
      flags[i] = location.location_flags;
      if (location.location_flags & POSITION_VALID && location.translation) {
        positions.set(location.translation, i * 3);
      }
      if (typeof joint.radius_m === 'number') radii[i] = joint.radius_m;
    });
  const { joints: _, ...rest } = record;
  return {
    ...(rest as unknown as Omit<HandSample, 'positions' | 'radii' | 'flags'>),
    positions,
    radii,
    flags,
  };
}

/**
 * Files picked as a folder (paths like "my-recording/streams/hands.jsonl") re-rooted at the folder
 * that holds recording.json, as loadCapturePackage expects.
 */
export function packageFiles(entries: Iterable<readonly [string, string]>): Map<string, string> {
  const all = [...entries];
  const manifest = all
    .map(([path]) => path)
    .filter((path) => path === 'recording.json' || path.endsWith('/recording.json'))
    .sort((a, b) => a.length - b.length)[0];
  if (manifest === undefined) throw new Error('The folder has no recording.json');
  const root = manifest.slice(0, -'recording.json'.length);
  return new Map(
    all
      .filter(([path]) => path.startsWith(root))
      .map(([path, text]) => [path.slice(root.length), text]),
  );
}

/* Run with Bun. Structural JSON Schema + cross-file capture-contract checks. */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Ajv = require("ajv");
const schema = require("./capture.schema.json");

const ajv = new Ajv({ allErrors: true, strict: false });
ajv.addSchema(schema, "capture");
const definitions = {
  recording: "recording",
  scene: "scene",
  calibration: "calibration",
  pose: "poseSample",
  hand: "handSample",
  event: "eventSample",
  video_frame: "videoIndexSample",
};
function check(condition, message) {
  if (!condition) throw new Error(message);
}
function finite(value, label) {
  if (typeof value === "number")
    check(Number.isFinite(value), `${label}: non-finite number`);
  else if (Array.isArray(value)) value.forEach((item) => finite(item, label));
  else if (value && typeof value === "object")
    Object.values(value).forEach((item) => finite(item, label));
}
function structural(value, label) {
  finite(value, label);
  const definition = definitions[value?.kind];
  check(definition, `${label}: unknown document kind`);
  const validate = ajv.getSchema(`capture#/definitions/${definition}`);
  check(validate(value), `${label}: ${ajv.errorsText(validate.errors)}`);
}
function quat(q, label) {
  check(
    Math.abs(Math.hypot(...q) - 1) <= 0.001,
    `${label}: quaternion must be unit length`,
  );
}
function location(value, label) {
  const f = value.location_flags;
  check(!(f & 4) || !!(f & 1), `${label}: tracked orientation must be valid`);
  check(!(f & 8) || !!(f & 2), `${label}: tracked position must be valid`);
  check(
    !!(f & 1) === (value.rotation !== null),
    `${label}: orientation validity/null mismatch`,
  );
  check(
    !!(f & 2) === (value.translation !== null),
    `${label}: position validity/null mismatch`,
  );
  if (value.rotation) quat(value.rotation, label);
}
function unique(items, key, label) {
  const result = new Map();
  for (const item of items) {
    check(!result.has(item[key]), `${label}: duplicate ${item[key]}`);
    result.set(item[key], item);
  }
  return result;
}
function validatePackage(manifestPath) {
  const root = fs.realpathSync(path.dirname(manifestPath));
  function local(name) {
    check(
      name.split("/").every((part) => part && part !== "." && part !== ".."),
      `Noncanonical path ${name}`,
    );
    const resolved = path.resolve(root, name);
    check(
      resolved.startsWith(root + path.sep),
      `Path outside package: ${name}`,
    );
    let current = root;
    for (const component of name.split("/")) {
      current = path.join(current, component);
      check(
        !fs.lstatSync(current).isSymbolicLink(),
        `Symlink forbidden: ${name}`,
      );
    }
    check(fs.statSync(resolved).isFile(), `Not a file: ${name}`);
    return resolved;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  structural(manifest, "manifest");
  check(manifest.kind === "recording", "Entry point must be a recording");
  const inventory = unique(manifest.files, "path", "inventory");
  check(
    !inventory.has(path.basename(manifestPath)),
    "Manifest must not inventory itself",
  );
  for (const file of inventory.values()) {
    const bytes = fs.readFileSync(local(file.path));
    check(
      bytes.byteLength === file.bytes,
      `${file.path}: byte length mismatch`,
    );
    check(
      crypto.createHash("sha256").update(bytes).digest("hex") === file.sha256,
      `${file.path}: SHA-256 mismatch`,
    );
  }
  function payload(name) {
    check(inventory.has(name), `${name}: not in file inventory`);
    return fs.readFileSync(local(name), "utf8");
  }
  function document(name, kind) {
    const value = JSON.parse(payload(name));
    structural(value, name);
    check(value.kind === kind, `${name}: expected ${kind}`);
    return value;
  }
  const scene = document(manifest.scene, "scene");
  const calibration = document(manifest.calibration, "calibration");
  const entities = unique(scene.entities, "id", "entities");
  for (const entity of entities.values()) {
    check(
      (entity.motion === "static") === (entity.pose !== null),
      `${entity.id}: static pose / tracked null required`,
    );
    if (entity.pose) quat(entity.pose.rotation, entity.id);
    if (entity.geometry.type === "box")
      check(
        entity.geometry.size.every((n) => n > 0),
        `${entity.id}: dimensions must be positive`,
      );
    if (entity.geometry.type === "glb")
      check(
        inventory.has(entity.geometry.path),
        `${entity.id}: asset not in inventory`,
      );
  }
  quat(calibration.T_world_source.rotation, "calibration");
  const basis = calibration.basis_conversion.matrix_row_major;
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) {
      const dot = [0, 1, 2].reduce(
        (sum, k) => sum + basis[i * 3 + k] * basis[j * 3 + k],
        0,
      );
      check(
        Math.abs(dot - (i === j ? 1 : 0)) <= 0.001,
        "Basis conversion must be orthonormal",
      );
    }
  const cameras = unique(calibration.cameras, "id", "cameras");
  for (const camera of cameras.values())
    quat(camera.T_parent_camera.rotation, camera.id);
  const sources = unique(manifest.sources, "id", "sources");
  const clocks = unique(manifest.clocks, "id", "clocks");
  const streams = unique(manifest.streams, "id", "streams");
  unique(manifest.streams, "path", "stream paths");
  const videos = unique(manifest.videos, "path", "video paths");
  for (const video of videos.values()) {
    const camera = cameras.get(video.camera_id);
    check(camera, `${video.path}: missing camera calibration`);
    check(
      video.width === camera.resolution[0] &&
        video.height === camera.resolution[1],
      `${video.path}: calibration resolution mismatch`,
    );
    check(inventory.has(video.path), `${video.path}: not inventoried`);
    check(
      streams.get(video.index_stream_id)?.type === "video_index",
      `${video.path}: missing index stream`,
    );
  }
  const tracks = new Map(),
    videoFrames = new Map(),
    inputFrames = [],
    indexedFrames = new Map();
  let records = 0;
  const kinds = {
    poses: "pose",
    hands: "hand",
    events: "event",
    video_index: "video_frame",
  };
  for (const stream of streams.values()) {
    const body = payload(stream.path);
    check(!body || body.endsWith("\n"), `${stream.path}: truncated final line`);
    const rows = body ? body.slice(0, -1).split("\n") : [];
    check(
      rows.length === stream.sample_count,
      `${stream.id}: sample_count mismatch`,
    );
    for (let i = 0; i < rows.length; i++) {
      const row = JSON.parse(rows[i]),
        label = `${stream.path}:${i + 1}`;
      structural(row, label);
      check(row.kind === kinds[stream.type], `${label}: wrong record kind`);
      check(sources.has(row.source_id), `${label}: unknown source`);
      check(
        row.t_us < manifest.duration_us,
        `${label}: outside recording duration`,
      );
      const trackKey = `${stream.id}/${row.entity_id || row.camera_id || "events"}`;
      const previous = tracks.get(trackKey);
      if (previous)
        check(
          row.t_us > previous.t_us && row.sequence > previous.sequence,
          `${label}: track time/sequence must strictly increase`,
        );
      tracks.set(trackKey, row);
      if (row.source_time) {
        const clock = clocks.get(row.source_time.clock_id);
        check(clock, `${label}: undeclared clock`);
        const delta =
          BigInt(row.source_time.ticks_ns) - BigInt(clock.source_origin_ns);
        check(
          delta >= BigInt(-Number.MAX_SAFE_INTEGER) &&
            delta <= BigInt(Number.MAX_SAFE_INTEGER),
          `${label}: clock delta cannot be represented safely`,
        );
        const mapped = Math.round(
          (clock.scale * Number(delta)) / 1000 + clock.offset_us,
        );
        check(
          Math.abs(mapped - row.t_us) <= 1,
          `${label}: clock mapping mismatch`,
        );
        if (row.estimate_type !== "predicted")
          check(
            row.available_t_us >= row.t_us,
            `${label}: availability precedes nonpredicted observation`,
          );
      }
      if (row.entity_id) {
        const entity = entities.get(row.entity_id);
        check(
          entity?.motion === "tracked",
          `${label}: unknown or static entity`,
        );
        if (row.kind === "hand") {
          check(entity.role === "hand", `${label}: hand role required`);
          for (const joint of row.joints) {
            location(joint.location, label);
            if (!row.active)
              check(
                joint.location.location_flags === 0,
                `${label}: inactive hand must have invalid joints`,
              );
          }
        } else {
          check(
            entity.role === "headset" || entity.role === "object",
            `${label}: pose role must be object or headset`,
          );
          location(row.location, label);
          if (row.input_camera_frame) {
            check(
              cameras.has(row.input_camera_frame.camera_id),
              `${label}: unknown input camera`,
            );
            inputFrames.push({
              ...row.input_camera_frame,
              t_us: row.t_us,
              label,
            });
          }
        }
      }
      if (row.kind === "event")
        for (const id of row.entity_ids)
          check(entities.has(id), `${label}: unknown event entity ${id}`);
      if (row.kind === "video_frame") {
        const video = videos.get(row.video_path);
        check(
          video?.camera_id === row.camera_id &&
            video.index_stream_id === stream.id,
          `${label}: video reference mismatch`,
        );
        const previousFrame = videoFrames.get(row.video_path);
        check(
          row.frame_index ===
            (previousFrame ? previousFrame.frame_index + 1 : 0),
          `${label}: noncontiguous encoded frame index`,
        );
        if (previousFrame)
          check(
            row.pts_us > previousFrame.pts_us,
            `${label}: video PTS must increase`,
          );
        videoFrames.set(row.video_path, row);
        indexedFrames.set(`${row.video_path}/${row.frame_index}`, row);
        if (row.T_world_camera) quat(row.T_world_camera.rotation, label);
      }
      records++;
    }
  }
  for (const video of videos.values())
    check(videoFrames.has(video.path), `${video.path}: empty video index`);
  for (const input of inputFrames) {
    const frame = indexedFrames.get(`${input.video_path}/${input.frame_index}`);
    check(
      frame?.camera_id === input.camera_id,
      `${input.label}: input frame missing from video index`,
    );
    check(
      frame.t_us === input.t_us,
      `${input.label}: vision pose time must match input frame time`,
    );
  }
  return { files: inventory.size, records, synthetic: manifest.synthetic };
}
module.exports = { validatePackage };
if (require.main === module) {
  try {
    const filename = path.resolve(
      process.argv[2] || path.join(__dirname, "example/recording.json"),
    );
    console.log(JSON.stringify({ valid: true, ...validatePackage(filename) }));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

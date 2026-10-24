const { test, expect } = require("bun:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { validatePackage } = require("./validate.cjs");

function modified(change, rehash = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "capture-contract-"));
  fs.cpSync(path.join(__dirname, "example"), dir, { recursive: true });
  const filename = path.join(dir, "recording.json");
  const manifest = JSON.parse(fs.readFileSync(filename, "utf8"));
  function edit(name, fn) {
    const file = path.join(dir, name);
    if (name.endsWith("jsonl")) {
      const rows = fs
        .readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map(JSON.parse);
      fn(rows);
      fs.writeFileSync(
        file,
        rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
      );
    } else {
      const value = JSON.parse(fs.readFileSync(file, "utf8"));
      fn(value);
      fs.writeFileSync(file, JSON.stringify(value));
    }
  }
  try {
    change(manifest, edit, dir);
    if (rehash)
      for (const file of manifest.files) {
        const bytes = fs.readFileSync(path.join(dir, file.path));
        file.bytes = bytes.length;
        file.sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
      }
    fs.writeFileSync(filename, JSON.stringify(manifest));
    return validatePackage(filename);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("synthetic package including tracking loss validates", () => {
  expect(
    validatePackage(path.join(__dirname, "example/recording.json")),
  ).toEqual({ files: 6, records: 25, synthetic: true });
});
test("modified payload cannot bypass its inventory hash", () => {
  expect(() =>
    modified(
      (_, edit) =>
        edit("scene.json", (scene) => {
          scene.world.origin_description = "changed";
        }),
      false,
    ),
  ).toThrow("mismatch");
});
test("unknown moving entity is rejected after correct rehash", () => {
  expect(() =>
    modified((_, edit) =>
      edit("streams/objects.jsonl", (rows) => {
        rows[0].entity_id = "missing";
      }),
    ),
  ).toThrow("unknown or static entity");
});
test("invalid orientation cannot masquerade as an identity pose", () => {
  expect(() =>
    modified((_, edit) =>
      edit("streams/objects.jsonl", (rows) => {
        rows[3].location.rotation = [0, 0, 0, 1];
      }),
    ),
  ).toThrow("validity/null mismatch");
});
test("unit quaternion is a semantic requirement", () => {
  expect(() =>
    modified((_, edit) =>
      edit("streams/objects.jsonl", (rows) => {
        rows[0].location.rotation = [0, 0, 0, 2];
      }),
    ),
  ).toThrow("unit length");
});
test("clock alignment is checked rather than assumed", () => {
  expect(() =>
    modified((_, edit) =>
      edit("streams/objects.jsonl", (rows) => {
        rows[0].source_time.ticks_ns = "1000000";
      }),
    ),
  ).toThrow("clock mapping mismatch");
});
test("nonmonotonic sequence is rejected", () => {
  expect(() =>
    modified((_, edit) =>
      edit("streams/objects.jsonl", (rows) => {
        rows[1].sequence = 0;
      }),
    ),
  ).toThrow("strictly increase");
});
test("fixed hand skeleton cannot silently lose joints", () => {
  expect(() =>
    modified((_, edit) =>
      edit("streams/hands.jsonl", (rows) => {
        rows[0].joints.pop();
      }),
    ),
  ).toThrow("26");
});
test("inactive hand cannot remain marked tracked", () => {
  expect(() =>
    modified((_, edit) =>
      edit("streams/hands.jsonl", (rows) => {
        rows[0].active = false;
      }),
    ),
  ).toThrow("inactive hand");
});
test("basis conversion must be orthonormal", () => {
  expect(() =>
    modified((_, edit) =>
      edit("calibration.json", (value) => {
        value.basis_conversion.matrix_row_major[0] = 2;
      }),
    ),
  ).toThrow("orthonormal");
});
test("static geometry requires a pose", () => {
  expect(() =>
    modified((_, edit) =>
      edit("scene.json", (scene) => {
        scene.entities.find((entity) => entity.id === "table").pose = null;
      }),
    ),
  ).toThrow("static pose");
});
test("duplicate identities are rejected", () => {
  expect(() =>
    modified((manifest) => {
      manifest.sources.push(manifest.sources[0]);
    }),
  ).toThrow("duplicate");
});
test("path traversal is rejected structurally", () => {
  expect(() =>
    modified((manifest) => {
      manifest.scene = "../scene.json";
    }),
  ).toThrow("pattern");
});

// Placeholder bytes test index relationships only; the validator does not decode MP4.
function withVideo(manifest, edit, dir) {
  const identity = { translation: [0, 0, 0], rotation: [0, 0, 0, 1] };
  edit("calibration.json", (value) => {
    value.cameras.push({
      id: "left",
      frame_convention: "optical-x-right-y-down-z-forward",
      parent: "headset",
      T_parent_camera: identity,
      resolution: [1280, 960],
      intrinsics: { fx: 600, fy: 600, cx: 640, cy: 480 },
      distortion_model: "synthetic",
      distortion_coefficients: [],
      calibration_source: "test",
    });
  });
  manifest.videos.push({
    camera_id: "left",
    path: "left.mp4",
    index_stream_id: "left_index",
    codec: "h264",
    width: 1280,
    height: 960,
    nominal_fps: 60,
    image_rotation_cw_deg: 0,
    mirrored: false,
  });
  manifest.streams.push({
    id: "left_index",
    type: "video_index",
    path: "streams/left.jsonl",
    requested_hz: 60,
    observed_hz: 60,
    sample_count: 2,
  });
  fs.writeFileSync(
    path.join(dir, "left.mp4"),
    "test placeholder; not encoded video",
  );
  const rows = [0, 16667].map((t, i) => ({
    kind: "video_frame",
    t_us: t,
    sequence: i,
    source_id: "synthetic",
    source_time: { clock_id: "synthetic_clock", ticks_ns: String(t * 1000) },
    available_t_us: t,
    camera_id: "left",
    video_path: "left.mp4",
    frame_index: i,
    pts_us: t,
    T_world_camera: identity,
    exposure_us: null,
  }));
  fs.writeFileSync(
    path.join(dir, "streams/left.jsonl"),
    rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
  );
  for (const filename of ["left.mp4", "streams/left.jsonl"])
    manifest.files.push({ path: filename, bytes: 0, sha256: "0".repeat(64) });
  edit("streams/objects.jsonl", (values) => {
    values[0].input_camera_frame = {
      camera_id: "left",
      video_path: "left.mp4",
      frame_index: 0,
    };
  });
}
test("video index and tracker source frame resolve together", () => {
  expect(modified(withVideo)).toEqual({
    files: 8,
    records: 27,
    synthetic: true,
  });
});
test("object estimate cannot refer to a nonexistent encoded frame", () => {
  expect(() =>
    modified((...args) => {
      withVideo(...args);
      args[1]("streams/objects.jsonl", (rows) => {
        rows[0].input_camera_frame.frame_index = 999;
      });
    }),
  ).toThrow("input frame missing");
});
test("object estimate time follows source frame rather than processing completion", () => {
  expect(() =>
    modified((...args) => {
      withVideo(...args);
      args[1]("streams/objects.jsonl", (rows) => {
        rows[0].input_camera_frame.frame_index = 1;
      });
    }),
  ).toThrow("pose time must match");
});

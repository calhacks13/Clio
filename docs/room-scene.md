# Rebuilt room and objects

What a lesson leaves behind to look at, beside the measurements: the room the learner stood in
and a model of every object they worked with, in the episode's workspace frame W. The room is what
the Quest already knows; nothing is reconstructed from photos and nothing heavy runs on the laptop.

| Part          | Comes from                                                                                                                                  | What it is        |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| Room          | The Quest room scan (Space Setup), read by WebXR mesh detection: the room's global mesh and labelled furniture volumes                      | Measured, earlier |
| Object models | A generator (primitive, Gemini CAD, or a command), scaled and placed by the measured size and track, from a few camera stills of the object | Generated         |

Nothing here is an object measurement. Tracks, extents and fused shapes stay what
[data-pipeline.md](data-pipeline.md) describes; a model is drawn where the track says and as big as
the measurements say, and its look is labelled generated.

## Flow

```
 headset (live)                         server (files)                      pipeline (after finish)
 ──────────────                         ──────────────                      ───────────────────────
 frame.detectedMeshes ─► room-scan-<n>.glb + environment.meshes event ─┐
 passthrough camera   ─► keyframe-<nnnn>.jpg + scene.keyframe event ───┼─► data/episodes/<id>/
                         (PUT /api/episodes/:id/media/:name, in order)  │       media/
                                                                        │
                                   clio compile (auto, on finish) ◄─────┘
                                   └─► data/derived/<id>/room.glb, environment.json `room`
                                   clio scene (auto after a compile, CLIO_SCENE=auto)
                                   └─► data/scenes/<id>/ scene.json, model-<id>.glb,
                                       cad-<id>.json, crop-<id>-<n>.jpg
 visualizer /clio/<id> ◄── GET /api/episodes/:id/derived/room.glb, /scene/<name>
```

## Raw episode additions (`clio.episode/1`, optional)

Contracts: `packages/protocol/src/episode.ts`.
- Feature `environment.meshes`: `environment.meshes` events `{media, meshes[]}`. Each is a full
  snapshot of `frame.detectedMeshes`: the room's global mesh and the furniture volumes, with id,
  kind (`SurfaceKind` from the semantic label), raw label, `global`, vertex and triangle counts.
  The geometry is `media/room-scan-<n>.glb`: one root node per mesh named by its id, its
  translation and rotation the mesh pose in W, POSITION in mesh-local meters, uint32 indices,
  `extras: {kind, label, global}`. The headset records one at the start of the recording and again
  when the meshes change, at most every 10 s and at most 8 per episode.
- Feature `scene.keyframes`: `scene.keyframe` events `{media, capturedT, pose, width, height,
  intrinsics}` and `media/keyframe-<nnnn>.jpg`. They exist only so an object's model can be made
  from a picture of it. `pose` is the camera in W at `capturedT` (the head pose at the camera
  frame's capture time composed with `meta.camera.headFromCamera`), camera axes as WebXR: x right,
  y up, looking down -z. `intrinsics` are `meta.camera`'s scaled to the stored image. The headset
  keeps a frame when the camera moved to a new viewpoint, the head is still enough not to blur it,
  and at most one every couple of seconds, up to a small cap per episode.
- Both media kinds go through the episode's upload queue, after the create and before the finish,
  so a compile that starts on finish sees them. A dropped upload leaves an event without its file;
  readers skip it.
- `?scan=0` on the headset turns keyframes off. Camera stills are stored on the laptop only, like
  the rest of the episode.

## Compiled (`clio.derived/1`)

Contracts: `packages/protocol/src/derived.ts`. `clio compile` keeps the last room scan snapshot
whose GLB arrived and rewrites it to `data/derived/<id>/room.glb` (the same node layout, in W), and
`environment.json` gains `room` (`RoomScanSchema`): the file, the snapshot it came from, its time,
the number of snapshots, and every mesh with its bounds in W. Derived file names may now end in
`.json` or `.glb`. The raw room scan GLBs are compile inputs (they are fingerprinted), keyframes are
not.

## Object models (`clio.scene/1`)

Contracts: `packages/protocol/src/scene.ts`. `clio scene <episode dir>` reads the episode and its
compile and writes `data/scenes/<id>/`:
- `model-<id>.glb` per drawable object, origin at the bottom center of its bounds, +y up, meters;
  `crop-<id>-<n>.jpg` are the keyframe crops it was made from (the tracker's box on the same camera
  frame when there is one, otherwise the compiled position and size projected through the
  keyframe's pose). `placement.offset` goes from the tracked position to the model origin,
  `placement.rotation` is a yaw from the fused shape box when there is one.
- `scene.json` (`SceneDocSchema`): the compile it was built from (`compiledAt`), inputs with
  hashes, options, stages with their status and detail, and how each model was made.

Backends (`--models`, server `CLIO_SCENE_MODELS`):
- `primitive` (default): a box or a cylinder from the measured size and the crops' color. Offline.
- `gemini-cad`: Gemini (`$CLIO_CAD_MODEL`, default `gemini-pro-latest`, key `GEMINI_API_KEY`)
  receives the crops, the object's label and detector words and its measured size, and answers a
  CAD program: named parts (box, cylinder, cone, sphere, torus, capsule, lathe profile, extruded
  outline) with dimensions in meters, positions, rotations and colors. The pipeline builds the
  mesh from the program and keeps the program as `cad-<id>.json`. This sends the crops to Google,
  so it runs only when asked for.
- `command`: `$CLIO_MODEL_COMMAND`, a command template with `{image}`, `{out}` and `{label}`, that
  writes a GLB (an image-to-3D model on another machine, for example). The pipeline scales it to
  the measured size and places it like the others.

An object whose backend fails gets a primitive with a note saying why.

The server runs `clio scene --if-stale` after each successful compile when `CLIO_SCENE=auto` (the
default; `off` disables it), one episode at a time, and reports `scene: {state, scene, error}` on
the episode detail. `GET /api/episodes/:id/scene/:name` serves the files (`SCENE_FILE_NAME`).
Settings: `CLIO_SCENE_MODELS` (`primitive`, `gemini-cad`, `command`), `CLIO_MODEL_COMMAND`,
`CLIO_CAD_MODEL`.

## Viewer

`/clio/<id>` draws, under its own toggles: the room scan, shaded by kind (the global mesh as a
quiet surface, furniture volumes by their label), and each object's model riding on its compiled
track with the "Generated" look and the backend in the inspector. The measured dot, extent box and
shape points stay available beside the model.

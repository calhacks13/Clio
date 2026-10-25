# Rebuilt room and objects

What a lesson leaves behind to look at, beside the measurements: the room the learner stood in
and a model of every object they worked with, in the episode's workspace frame W. The room is what
the Quest already knows; nothing is reconstructed from photos and nothing heavy runs on the laptop.

To set it up and try it, see [room-scene-setup.md](room-scene-setup.md).

| Part          | Comes from                                                                                                                    | What it is        |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| Room          | The Quest room scan (Space Setup), read by WebXR mesh detection: the room's global mesh and labelled furniture volumes        | Measured, earlier |
| Object models | TripoSR (or a primitive, or a command), from a camera still of the object, scaled to its measured box and placed on its track | Generated         |

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
                                   clio scene (auto after a scanned compile, CLIO_SCENE=auto)
                                   └─► data/scenes/<id>/ scene.json, model-<id>.glb,
                                       crop-<id>-<n>.jpg
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
- The headset records both only with `?scan=1`. Camera stills are stored on the laptop only, like
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
- `triposr` (the default): [TripoSR](https://github.com/VAST-AI-Research/TripoSR) (MIT; weights
  `stabilityai/TripoSR`) makes a mesh from the object's best crop, on this machine. The object is
  cut out by the tracker's outline on that crop when the crop came from an observation, otherwise
  by rembg, and the surface comes from marching cubes on a 128 grid (`CLIO_TRIPOSR_RESOLUTION`):
  a few seconds an object on a laptop's GPU, the model loaded once per build. It runs in its own
  environment, `pipeline/tools/triposr/` (set up once with `pipeline/tools/triposr/setup.sh`,
  which fetches TripoSR at a pinned commit and downloads its weights, about 1.7 GB, and rembg's,
  about 170 MB), so the pipeline itself stays numpy-only. Settings: `CLIO_TRIPOSR_RESOLUTION`
  (default 128), `CLIO_TRIPOSR_DEVICE` (`auto`: CUDA, else Apple's MPS, else the CPU),
  `CLIO_TRIPOSR_TIMEOUT` (seconds an object, default 300), `CLIO_TRIPOSR_DIR`.
- `primitive`: a box or a cylinder from the measured size and the crops' color. Instant.
- `command`: `$CLIO_MODEL_COMMAND`, a command template with `{image}`, `{out}` and `{label}`, that
  writes a GLB (an image-to-3D model on another machine, for example).

TripoSR's and the command's meshes are fitted to the measured box: each axis on its own when the
box was measured (a shape box or an extent), since one photo says least about depth, else
uniformly to the height; the note says when an axis was stretched or squeezed by more than a
quarter. An object whose backend fails, or cannot run (TripoSR not set up, no crop), gets a
primitive with a note saying why.

The server runs `clio scene --if-stale` after each successful compile of an episode recorded with
`?scan=1` (a room scan or keyframes in its media) when `CLIO_SCENE=auto` (the default; `off`
disables it), one episode at a time; `POST /api/episodes/:id/scene` builds any episode by hand.
The episode detail reports `scene: {state, scene, error}`, and `GET /api/episodes/:id/scene/:name`
serves the files (`SCENE_FILE_NAME`).
Settings: `CLIO_SCENE_MODELS` (`triposr`, `primitive`, `command`), the TripoSR settings above,
`CLIO_MODEL_COMMAND`. The startup log says whether TripoSR is set up.

## Viewer

`/clio/<id>` draws, under its own toggles: the room scan, shaded by kind (the global mesh as a
quiet surface, furniture volumes by their label), and each object's model riding on its compiled
track with the "Generated" look and the backend in the inspector. The measured dot, extent box and
shape points stay available beside the model.

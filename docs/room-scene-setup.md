# Testing the rebuilt room and objects

How to set up and try branch `feat/room-scene`. The design is in [room-scene.md](room-scene.md).

What it adds:
- **Room**: each recording keeps the Quest's own room scan (Space Setup): the room's mesh and its
  labelled furniture. The viewer draws it shaded by kind, near walls cut away.
- **Object models**: after a lesson, each object the lesson declared gets a 3D model made by
  TripoSR from a camera still of it, sized to what was measured and riding on its track. The
  viewer draws them see-through, labelled "Generated".
- **G1 robot**: the whole Unitree G1, posed from the head and hands on every compile, drawn as a
  solid model under the Robot toggle.

## 1. Get the branch

```bash
git fetch origin
git switch feat/room-scene            # or: git worktree add ../Clio-scene feat/room-scene
pnpm install
pnpm visualizer:install
```

You need Node 24 (`.nvmrc`), pnpm, Bun and [uv](https://docs.astral.sh/uv/). On Node 25 the
visualizer's dev server answers 500 ("localStorage.getItem is not a function"); start it with
`NODE_OPTIONS=--no-experimental-webstorage` until you are on Node 24.

## 2. Set up TripoSR (once, about 2 GB)

```bash
pipeline/tools/triposr/setup.sh
```

This fetches TripoSR at a pinned commit, creates its own Python environment in
`pipeline/tools/triposr/.venv` (PyTorch included), and loads the model once, which downloads its
weights (about 1.7 GB, into the Hugging Face cache) and the background remover (about 170 MB, into
`~/.rembg`). It takes a few minutes. It ends with `{"ok": true, "device": "mps"}` on an Apple
silicon Mac (`cuda:0` with an NVIDIA GPU, `cpu` otherwise).

Without it everything still works: objects get plain boxes and cylinders, and their notes say
TripoSR is not set up.

## 3. Start the server and the viewer

```bash
pnpm dev                 # the server on 8787 and the headset app; restart it after pulling
pnpm visualizer:dev      # the viewer on http://127.0.0.1:3001/clio
```

The server's startup lines should say:

```
  Compile: on (.../pipeline)
  Scene builds: on (object models: TripoSR, on this machine)
```

"but TripoSR is not set up, so primitives" means step 2 has not run (or failed).

## 4. Record on the Quest

1. **Space Setup**: on the headset, Settings > Physical space > Space setup. Scan the room, mark
   the table. The recording keeps this scan; if furniture moved since, scan again.
2. Open Clio as usual ([dev-setup.md](dev-setup.md)), with `?scan=1` added to the URL: without it
   nothing of this is recorded. When Quest Browser asks for **spatial data**, allow it: that is how
   the room scan is read. The **camera** permission is needed too, as before.
3. Run a lesson. At the start, look around the table at each object for a moment with your head
   still: the headset keeps a still when the camera reaches a new viewpoint (up to 40 a lesson, at
   least 2 s apart). Quest Browser encodes stills slowly (about 4 s each), so linger a little.
4. Finish the lesson. The server log shows `Compile of <id> finished`, then
   `Scene build of <id> finished` a few seconds an object later.

## 5. Look at it

Open http://127.0.0.1:3001/clio and pick the episode.
- **Room**, **Models** and **Robot** in the header show and hide each part.
- Click an object (its label or its lane): the inspector's "Model (generated)" rows say TripoSR
  made it, what sized and turned it, and show the crop it was made from. Its note says when the
  model was stretched to the measured size (one photo says little about depth).
- With a posed G1 the view starts from the side, so the robot does not hide the table. Drag to
  orbit, scroll to zoom.

## Without a Quest

Two synthetic episodes show everything. Use a scratch data directory, never the real `data/`:

```bash
mkdir -p /tmp/clio-test/episodes
cp -R fixtures/episodes/synthetic-room-scan /tmp/clio-test/episodes/ep-synthetic-room-scan
cp -R fixtures/episodes/synthetic-ph-syringe /tmp/clio-test/episodes/ep-synthetic-ph-syringe
CLIO_SERVER_PORT=8788 CLIO_DATA_DIR=/tmp/clio-test pnpm --filter @clio/server start
CLIO_SERVER_URL=http://127.0.0.1:8788 pnpm visualizer:dev
```

The server compiles and builds both at startup. `ep-synthetic-room-scan` has a room scan, a red cup
and a blue box with camera stills; `ep-synthetic-ph-syringe` has tracked hands, so the G1's arms
reach for the objects. The synthetic stills are flat-colored shapes, so TripoSR's models of them
are rough; real photos do much better.

## Settings

| Where            | Setting                   | Default                  | What it does                                                      |
| ---------------- | ------------------------- | ------------------------ | ----------------------------------------------------------------- |
| server           | `CLIO_SCENE`              | `auto`                   | `off`: no scene builds after compiles of scanned episodes         |
| server           | `CLIO_SCENE_MODELS`       | `triposr`                | `primitive`: boxes and cylinders; `command`: `CLIO_MODEL_COMMAND` |
| server           | `CLIO_SCENE_TIMEOUT_MS`   | 10 min                   | most one scene build may take                                     |
| server, pipeline | `CLIO_TRIPOSR_RESOLUTION` | `128`                    | TripoSR's marching cubes grid (32 to 512; higher is slower)       |
| server, pipeline | `CLIO_TRIPOSR_DEVICE`     | `auto`                   | `cuda:0`, `mps` or `cpu`                                          |
| server, pipeline | `CLIO_TRIPOSR_TIMEOUT`    | `300`                    | seconds TripoSR may take for one object                           |
| server, pipeline | `CLIO_TRIPOSR_DIR`        | `pipeline/tools/triposr` | where the TripoSR tool lives                                      |
| headset URL      | `scan=1`                  | off                      | record the room scan and camera stills                            |

Rebuild one episode by hand:

```bash
cd pipeline
uv run clio compile ../data/episodes/<id>
uv run clio scene ../data/episodes/<id>            # object models into ../data/scenes/<id>/
```

## When something is missing

| You see                                    | Why, and what to do                                                                                                                                  |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| No Room toggle                             | No room scan arrived. Check `data/episodes/<id>/media/room-scan-1.glb`. Run Space Setup, allow spatial data, restart the server after pulling.       |
| Objects are boxes or cylinders             | Read the object's note in the inspector: "TripoSR is not set up" (step 2), "no keyframe showed it" (look at it longer, check the camera permission). |
| "Building scene" stays in the playback bar | The first build after setup also loads TripoSR (about 10 s). Check the server log for `Scene build of <id> failed`.                                  |
| No robot                                   | The G1 needs a compile with head poses; turn on the Robot toggle.                                                                                    |
| The visualizer answers 500 on every page   | Node 25: use Node 24, or `NODE_OPTIONS=--no-experimental-webstorage`.                                                                                |

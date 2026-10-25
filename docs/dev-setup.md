# Development setup

## 1. Prerequisites (laptop)

| Tool                         | Install                                             |
| ---------------------------- | --------------------------------------------------- |
| Node 22+ and pnpm 10         | `brew install node pnpm` (or nvm; `.nvmrc` pins 24) |
| uv (for the Python pipeline) | `brew install uv`; it downloads Python 3.12 itself  |
| adb (USB to the Quest)       | `brew install android-platform-tools`               |
| scrcpy (mirror the headset)  | `brew install scrcpy`                               |

```bash
pnpm install
cp .env.example .env          # add GEMINI_API_KEY (https://aistudio.google.com/apikey)
pnpm dev                      # server on :8787 + headset app on :5173 (proxies /api and /gemini)
```

Without a `GEMINI_API_KEY` everything still runs. The coach falls back to the scripted (offline)
coach, planning returns 503, and so does finding objects unless an external finder is set.

**Object finder.** Clio finds and outlines what each step shows with Gemini by default (boxes,
drawn as corner brackets). To use jev or another segmenter instead (real contours), set
`CLIO_VISION_URL` (and `CLIO_VISION_TOKEN` if it needs one) in `.env`. The contract and a
minimal adapter are in [object-finder.md](object-finder.md). The server's startup log names the
finder in use.

## 2. Desktop development (no headset)

Open `http://localhost:5173/?emulate=1&debug=1` in Chrome.

[IWER](https://github.com/meta-quest/immersive-web-emulation-runtime) installs an emulated Quest 3
with hand tracking and a synthetic room. The control panel moves the head and hands. From the
console, `clio.pinch('right')` and `clio.pinch('right', 0)` pinch and release. Your laptop webcam
stands in for the passthrough camera, which is handy for testing object grounding.

To see outlines, open `?emulate=1&debug=1&procedure=ph-indicator` (its steps show cups and
bottles) or plan a lesson, and point the webcam at the objects. Outlines appear around what the
finder reports. `?showRefresh=1000` makes them follow faster while you test.

To test the planner alone on hard scenes, open `http://localhost:5173/bench.html`
([planner-bench.md](planner-bench.md)).

To see every UI in its states and iterate on it with hot reload, open
`http://localhost:5173/gallery.html` (states are data in `apps/headset/src/gallery/states.ts`).

### Desk lab

The desk lab runs a whole lesson on the laptop's camera and microphone, without the headset: the
voice coach, the planner, the step watcher, the tracker and Robotics-ER's action focus, with what
the tracker follows drawn over the webcam picture.

```bash
pnpm dev                                   # server on :8787, page on :5173
pnpm tracker                               # the tracker on :8790 (without it, nothing is followed)
open http://localhost:5173/desk.html       # Chrome; allow the camera and the microphone
```

Press **Start**: a browser lets a page play sound only after a click. Then talk to it as you would
on the headset ("I want to water the basil"), type the same into the text box, or write a goal and
press **Start lesson**. Wear headphones: the coach's voice on the speakers reaches the microphone.

**What runs.** `apps/headset/src/desk/desk-lab.ts` composes the headset's own lesson: Gemini Live
over the relay with the server's live model (the scripted coach without a key), the planner and the
curated lessons, the step watcher, the closer look, the tracker in objects mode and the action
focus, whose boxes anchor the tracker. What needs the room is stood in for or left out. An object
the finder or the tracker sees gets a stand-in position on a flat table, so the lesson knows it was
found and `highlight` shows it. There are no hands, so hand checks never pass: Done or the coach
completes a step. There are no ghost-hand demos, and nothing is recorded.

**The picture.** The webcam is not mirrored, so the boxes line up. Each object the tracker follows
has its outline, its bounding box and a tag (label, tracking state, who placed it last, `jev` or
`er`, and the score). A lit object (the step shows it, the coach highlights it, or ER named it as the
next thing to touch) glows in its role color; one followed only for the data is a thin white line.
ER's boxes are dashed and fade over 1.5 s, and the next thing to touch has a dot and a "next:" tag.

**The panel.**
- **Lesson**: the phase, the goal, the steps (✓ done, – skipped, ● the focused one), what is lit and
  the step watcher's last answer.
- **Conversation**: the learner and the coach as transcribed, typed turns, and the `[app]` messages
  the voice was sent.
- **Coach tool calls**: every call with its arguments and result, and a count per tool. A yellow
  `highlight 0` stays until the voice calls `highlight`.
- **Robotics-ER focus**: each look, with its latency, how old its frame was, the next thing to touch
  (marked when the lesson declared it from ER's words) and ER's words for each object.
- **Tracker**: the connection, frames per second, the time to an answer, the objects followed, lit
  and found, who placed them, and the object finder's last one-shot look.

**Controls.** **Coach** switches between Gemini Live and the scripted coach and restarts the voice.
**Camera** picks any camera Chrome sees: an iPhone (Continuity Camera) or a USB camera looking down
at the table gets closer to the headset's view. **Mute mic** sends the voice silence. The text box
sends a typed turn to the voice as the learner's own words. **Start lesson** starts the goal as
`start_lesson` would, and **Done** is the learner's Done button.

| Option                              | Default  | Meaning                                                 |
| ----------------------------------- | -------- | ------------------------------------------------------- |
| `coach=gemini\|scripted`            | `gemini` | voice coach (falls back to scripted without a key)      |
| `goal=…`                            |          | plan this lesson on Start                               |
| `procedure=<id>`                    |          | run a curated lesson on Start                           |
| `focus=0`                           | on       | no action focus (Robotics-ER is never asked)            |
| `mic=0`                             | on       | start with the microphone muted                         |
| `frame=640\|512\|480\|320`          | `640`    | width of the frames streamed to the tracker             |
| `tracker=<port>`                    |          | a tracker on this local port instead of the proxied one |
| `transport`, `voice`, `showRefresh` |          | as on the headset (§4)                                  |

From the console, `window.desk` drives it: `desk.say('…')`, `desk.goal('…')`, `desk.done()`,
`desk.coach('scripted')`, `desk.mute()`, and reads it: `desk.plan()`, `desk.objects()`,
`desk.stats()`, `desk.tools.entries`, `desk.bus`, `desk.lesson`.

To run it beside another Clio on the default ports, give each part its own:
`CLIO_SERVER_PORT=8797 CLIO_VISION_URL=http://127.0.0.1:8794/locate pnpm dev:server`,
`uv run --project tracker --extra coreml clio-tracker --port 8794`, and
`CLIO_SERVER_URL=http://127.0.0.1:8797 CLIO_TRACKER_URL=http://127.0.0.1:8794 pnpm --filter @clio/headset exec vite --port 5177`.

## 3. Quest 3

1. **Developer mode:** in the Meta Horizon phone app, go to your headset → Developer Mode. This
   needs a (free) developer organization.
2. **USB:** connect the cable, put the headset on, and accept "Allow USB debugging" (Always).
   `adb devices` should list it as `device`.
3. **Tunnel the app:** `pnpm quest:reverse` (`adb reverse tcp:5173 tcp:5173`), then open
   **`http://localhost:5173`** in Quest Browser. Over `adb reverse`, `localhost` counts as a
   secure context, so no certificate is needed. The coach's WebSocket relay rides the same
   tunnel, so the headset needs no internet of its own.
4. **Wi-Fi alternative:** run `CLIO_HTTPS=1 pnpm dev`, open `https://<laptop-ip>:5173`, and accept
   the self-signed certificate once. This exposes the dev server, and with it the Gemini relay
   (your key's quota), to the LAN. Use your own hotspot, not open venue Wi-Fi. By default both the
   dev server and the API server listen on loopback only.
5. **Mirror for judges:** `scrcpy` (USB, works offline). Use `--crop` to show one eye.

### Camera permission workaround

Quest Browser 150–154 has a known issue: the headset-camera permission prompt never appears, and
only the avatar camera enumerates. Meta's investigation
([link](https://developers.meta.com/vr/support/investigations/1557993751977106/)) says granting the
permission over ADB fixes it. Meta doesn't publish the command. These commands are assembled from
Meta's permission docs and standard `pm grant` syntax, so **verify them with the `dumpsys` line**:

```bash
adb shell pm grant com.oculus.browser horizonos.permission.HEADSET_CAMERA
adb shell pm grant com.oculus.browser android.permission.CAMERA
adb shell am force-stop com.oculus.browser
adb shell dumpsys package com.oculus.browser | grep -E "HEADSET_CAMERA|android.permission.CAMERA"
#   expect granted=true
```

Re-check after every Browser or OS update. Then, in the page, allow the site's camera prompt on the
boot screen **before** pressing _Enter AR_: a prompt inside an immersive session ends the session.
On the headset, Clio only requests `facingMode: environment`. The "facing front" device is the
avatar camera, and opening it can wedge the media stack until a reboot.

### Camera calibration

With `?debug=1`, the boot step logs `camera settings: {…}`. That's `track.getSettings()`, which may
include Quest's experimental lens fields (`lensIntrinsicCalibration` / `lensCalibration`,
`lensTranslation`, `lensRotation`). `adapters/camera/calibration.ts` uses those fields when present,
and Quest 3 defaults from Google's XR Blocks otherwise. To check alignment, run a lesson with
`?debug=1`: each located object shows a dot where Clio thinks it is. If the dots are consistently
offset, adjust `DEFAULT_HEAD_FROM_CAMERA`, or better, implement marker self-calibration
(ARCHITECTURE §8).

## 4. URL options

| Option                        | Default             | Meaning                                                                                 |
| ----------------------------- | ------------------- | --------------------------------------------------------------------------------------- |
| `coach=gemini\|scripted\|off` | `gemini`            | voice coach (falls back to scripted without a key)                                      |
| `transport=relay\|direct`     | `relay`             | Gemini through the laptop, or with an ephemeral token                                   |
| `goal=…`                      |                     | plan this lesson right away                                                             |
| `procedure=<id>`              |                     | run a saved lesson (e.g. `shirt-fold`, `ph-indicator`)                                  |
| `mode=learn\|record_demo`     | `learn`             | `record_demo`: an expert records ghost-hand demos                                       |
| `calibrate=1`                 | off                 | pinch two table corners first                                                           |
| `camera=0`                    | on                  | disable the passthrough camera (pinch to register objects)                              |
| `autoDemo=0`                  | on                  | don't auto-play each step's demo                                                        |
| `emulate=1`                   | auto on desktop dev | IWER Quest 3 emulator                                                                   |
| `debug=1`                     | off                 | HUD, tracked-hand overlay, hidden zones, workspace outline                              |
| `live=0`                      | on                  | don't follow the lesson's objects with the tracker's `/track` (Spotlight looks instead) |
| `focus=0`                     | on                  | no Robotics-ER 2 action focus (it needs the camera, the tracker and a Gemini key)       |
| `voice=<name>`                |                     | Gemini prebuilt voice (e.g. `Kore`)                                                     |
| `showRefresh=<ms>`            | `3000`              | how often to look again at what the step shows (0: only when the step starts)           |

## 5. Data

Episodes land in `data/episodes/<id>/` (gitignored; see [data-format.md](data-format.md)).

```bash
cd pipeline
uv sync --all-extras                         # numpy, jsonschema, rerun-sdk, lerobot
uv run clio info ../data/episodes            # every episode: steps, mistakes, coach calls
uv run clio validate ../data/episodes/<id>
uv run clio view ../data/episodes/<id>       # Rerun viewer (or --save out.rrd)
uv run clio export-lerobot ../data/episodes --out ../data/lerobot --repo-id clio/demo
```

`pnpm synth` regenerates `fixtures/episodes/synthetic-shirt-fold` from the real domain code. That's
useful for pipeline work without a headset.

Turn an expert episode into ghost-hand clips:
`curl -X POST localhost:8787/api/clips/from-episode -H 'content-type: application/json' -d '{"episodeId":"<id>"}'`.

## 6. Checks

```bash
pnpm check          # biome lint, TypeScript (all packages), vitest (protocol, headset, server)
pnpm gen:schema     # after changing anything in packages/protocol
cd pipeline && uv run pytest -q
```

## 7. Demo day

- Charge the headset, and pack a USB-C **data** cable (plus a spare), a power bank and a phone
  hotspot.
- Run `pnpm dev` on the laptop, tethered to the hotspot, and `pnpm quest:reverse` over USB.
- Check the camera grant (`dumpsys`, above).
- **Fallback ladder:** Gemini fails → `?coach=scripted`. Camera fails → `?camera=0` (pinch to
  register). Planning fails → `?procedure=shirt-fold`. The object finder lags or hits a rate limit →
  `?showRefresh=0` (look only when a step starts), or unset `CLIO_VISION_URL` to fall back to
  Gemini.
- Record a backup video the night before, and keep a recorded episode open in Rerun.

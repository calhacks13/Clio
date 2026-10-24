> Written 2026-10-24 from the three Codex chats and ~/Desktop/Jev fun. Since then: the server gained incremental reads (`?from=` with `x-next-from`), and the forked viewer now lives in `serializer/` (port 3001).

# Highlighting pipeline: the three Codex chats and how they fit into Clio

**How sure the numbers are.**
- **Measured:** all measured timings come from this Mac (Apple M5 Pro, 48 GB, PyTorch on MPS) on 1280 px still photos.
- **Estimated:** the Quest and USB-cable figures come from desk research.
- **Other hardware:** the sam2-mlx speedup was measured by a third party on an M2 Max.
- **Quest:** nothing has run on a Quest 3.
- **Conflicts:** where a summary and its checker disagreed, this report uses the checker's version.

## 1. What each chat did

### Chat 1: "Build obscure object detection test" (the Obscura benchmark)

- **Where and when:** `/Users/peter/Desktop/Jev fun`, which is not a git repo. It ran Oct 23 from 18:55 to 23:43 PDT, but sat idle from 21:25 to 23:39. The final mask-quality answer, the Large parity check and a browser run with Large all came in the last 4 minutes.
- **Goal:** measure how well jev finds obscure objects compared with text-prompted Meta SAM 3.1. Then use SAM 2.1 to tighten jev's boxes, then improve the masks.
- **What got built (the `jevbench/` package):**
  - `providers.py`: the jev client. Each request carries a Box question and a Noul question, and there is no automatic retry.
  - `sam2.py`: `BoxSegmenter`. It takes a box prompt and caches the image encoding per image. It keeps the best of 3 candidate masks using the model's own predicted IoU, and it decodes one box per call. Also `mask_box()` and `padded_box()`.
  - `hybrid.py`: `refine()` replays saved jev answers through SAM, so it makes no API calls.
  - `core.py` (`iou`, `valid_box`, scoring), `sam31.py`, `runner.py`, `server.py` (a review UI on 127.0.0.1:8765), `web/`, and 12 tests in `tests/test_experiment.py`.
- **Test data:** `data/benchmark.json` has 6 Wikimedia photos (1280 px) and 36 queries: 24 objects present and 12 absent, across chemistry, electronics and metrology. Codex drew the reference boxes itself. There are no reference masks.
- **Models (`models/`):**
  - SAM 3.1 was not cached as you thought. Codex used your existing Hugging Face login to download the gated checkpoint (3.5 GB), and the converted weights add 3.36 GB more.
  - SAM 2.1 Small is 154 MB and Large is 868 MB.
  - Meta's own `sam3` package won't import on a Mac because it needs triton (CUDA only). Codex used a Hugging Face conversion instead and tried no other route.

**Results.** Scores are box IoU against Codex's reference boxes. A hit means IoU of at least 0.5 (or 0.75). False positives (FP) are counted on the 12 absent queries.

| Method                                      | Run                                                   | Mean IoU | Hit@0.5 | Hit@0.75 | FP   |
| ------------------------------------------- | ----------------------------------------------------- | -------- | ------- | -------- | ---- |
| jev + SAM 2.1 Large, full photo             | `cbff21` / `6ad9e7`                                   | 0.796    | 21/24   | 16/24    | 0/12 |
| jev + SAM 2.1 Small, full photo             | `f0072d`                                              | 0.790    | 22/24   | 15/24    | 0/12 |
| jev + EdgeTAM (later, from another session) | `experiments/edgetam/results/20261024T064843Z-25f6f9` | 0.790    | 22/24   | 16/24    | 0/12 |
| jev + SAM 2.1 Small, 5% box padding         | `704f36`                                              | 0.782    | 22/24   | 16/24    | 0/12 |
| jev + SAM 2.1 Small, crop with 50% context  | `2b8d7d`                                              | 0.771    | 22/24   | 14/24    | 0/12 |
| jev + SAM 2.1 Large, crop                   | `a3a035`                                              | 0.768    | 20/24   | 15/24    | 0/12 |
| jev alone                                   | `20261024T040515Z-aa320a`                             | 0.724    | 22/24   | 12/24    | 0/12 |
| SAM 3.1, text prompt                        | `aa320a`                                              | 0.280    | 7/24    | 7/24     | 2/12 |
| SAM 3 LiteText                              | `13fa16`                                              | 0.122    | 3/24    | 3/24     | 1/12 |
- **Crops:** worse than the full-photo hybrid, but still better than jev alone.
- **5% padding:** 16 objects improved and 8 got worse. With no padding it was 19 and 5.

**What we know about jev:**
- **Request shape:** one request can carry several named questions that share one image. Every benchmark request carried two: a Box question and a Noul (yes/no presence) question.
- **Latency:** median 3.90 s per request, with single attempts from 1.72 to 5.72 s. The 7.42 s figure in the summary added a failed attempt to its retry. One request out of 36 failed with HTTP 529.
- **Tokens:**
  - Two-question requests used 3,193 to 3,579 input tokens (mean 3,338) and 36 output tokens.
  - The only request with several boxes had 4 Box questions and no Noul, and ran once. It used 3,288 input and 78 output tokens, so output doubled, and took 2.19 s.
  - Dollar cost was never estimated.
- **By category:** electronics is weakest, with mean IoU 0.633 and hit@0.75 of 0.125. Chemistry scored 0.785 and 0.625, metrology 0.756 and 0.75.
- **Box never says "not here":** it always returns one box, so the Noul answer has to decide presence.
  - Absent objects scored 0.02 to 0.10 on Noul.
  - Present objects scored 0.54 to 0.97. The lowest, components-03, was a hit at IoU 0.718 but nearly fell under the 0.5 gate.
- **Box confidence can't be used as a gate:** a miss scored 0.11, a hit scored 0.23, and absent objects still got boxes with confidence up to 0.50.
- **A scoring rule worth keeping:** count a false positive whenever Noul passes, even if the box is invalid. That way a broken box can't hide a presence mistake.
- **Image rules (TypeSafe docs):**
  - PNG or JPEG only.
  - Each side 256 to 1568 px, and at least 78,400 px in area. The "at least 280 px per side" rule comes from third-party notes, not the official docs.
  - At most 16 MiB per image and 32 MiB per request. Oversize images are rejected, not resized.
  - EXIF data is ignored.
  - Box coordinates come back rounded to 0.01.
  - The benchmark photos were sent unmodified. `prepare_image` is only used by the `add` importer.
- **Access:**
  - Calls go to `POST https://api.typesafe.ai/v1/systemone` with a Bearer key and the required header `TypeSafe-Danger-Zone-Images: true`.
  - Box needs `jev-1.14.0` or the preview alias. `jev-1.13` accepts images but has no Box.
  - TypeSafe says Box and image input don't yet meet its production standard, and that API keys belong on your server.
  - Third-party notes say Box can return zero-width boxes, and that `jev-preview` returned HTTP 400 for Box at launch.

**Asking for parts by name (one case only):**
- **The original query:** "vernier scale on the sliding jaw" scored 0.344 against one band. Against both bands together it scored 0.640, so the reference box was partly ambiguous.
- **Rewordings:** these came from one 4-question request (`experiments/vernier-prompts/results.json`):
  - upper band only: 0.894
  - lower band only: 0.659
  - both bands together: 0.561 (against the union)
  - the original wording without "one object": 0.444
- **Takeaway:** this suggests naming parts helps, but it isn't proven.

**Adding SAM 2.1 after jev:**
- **Cost on the Mac:**
  - Encoding a new image: median 0.13 to 0.20 s with Small (max 0.415 s), and 0.44 to 0.86 s with Large.
  - Each box then adds a median of 23 to 40 ms as built. Decoding is only 5 to 10.5 ms of that; the rest is the image being preprocessed again for every box, even though the encoding is cached.
- **Gains:** 19 boxes got better and 5 got worse with Small. The biggest gains:
  - tubes-04 screw cap: 0.726 to 0.942
  - micrometer-03 spindle: 0.766 to 0.955
  - glassware-04 stopcock: 0.699 to 0.901
- **Why the 5 got worse (tools-04, pcb-01, micrometer-04, components-03, tubes-02):**
  - tools-04, "inside jaws", is the only clear case of SAM taking the whole object instead of the named part. It went from 0.790 to 0.646 with Small and 0.496 with Large, and its mask box was 1.48 times the reference area.
  - pcb-01 asks for a whole transistor, not a part. Its mask spilled past the target, to 1.39 times the reference.
  - micrometer-04, components-03 and tubes-02 got mask boxes smaller than the reference (0.64, 0.85 and 0.81 times). Either SAM under-segmented, or Codex drew the reference boxes too loose.
- **Misses that stayed misses:**
  - pcb-03 (blue diode) is a real jev error: its box ran to the top edge (y 0.02 to 0.68, against a reference of 0.394 to 0.729). SAM moved it from 0.309 to 0.349, still a miss.
  - SAM 2.1 Small lifted tools-02 to 0.499, just under the cut.
- **SAM 3.1 is tight when it finds something:** all 7 of its hits had IoU 0.82 to 0.98, so its hit@0.75 equals its hit@0.5. jev reached only 12/24 at 0.75. This supports "jev decides what, SAM decides the exact extent".
- **Large** barely helped (0.796 vs 0.790) and lost one hit at 0.5.
- **Matches Meta's own code:** the Hugging Face SAM 2.1 versions agree with native Meta code at mask IoU 0.992 to 0.999.

**Where it ended:**
- **Untested suggestions:** the last answer suggested HQ-SAM 2, foreground and background point prompts, and BiRefNet matting for transparent glass. None were tested, and SAM still misses glass fittings.
- **Still running:** the review server (pid 52288, `.venv/bin/python -m jevbench serve`, on 127.0.0.1:8765) was still running when checked.

**Earlier work and leads:**
- **Your earlier work:** Codex's first look around found your earlier experiments:
  - SAM tests in `/Users/peter/Desktop/DSH`: `sam31_test.py`, `sam21_small.py`, `sa2va_test.py`, `locateanything_test.py`, and a native sam2 environment.
  - FastSAM running on device in Core ML and Swift, in `~/Documents/ChatGPT/sightsense`: `FastSAMDetector.swift`, `FastSAMMaskEngine.swift`, and mask_clip experiments.
- **EdgeTAM:** Codex's mask-quality search turned up EdgeTAM, Meta's on-device version of SAM 2, but Codex never tested it or mentioned it to you. `experiments/edgetam/` was created 3 minutes after the chat ended, by another session:
  - 42 ms on a new image (encode plus decode), 15 ms with the encoding cached, 56 MB.
  - The Core ML export scripts in `vendor/EdgeTAM/coreml/` were never run.
  - `preview/glow-preview.png` draws a glow around the mask with SVG filters. It is display only and produces no polygon.
- **Unrelated:** `experiments/ar3d/` (image to 3D) also came from another session and has nothing to do with highlighting.

### Chat 2: "Explain LeRobotDataset structure"

- **Where and when:** `~/Documents/Codex/2026-10-23/is-t`, 19:05 to 21:23 PDT.
  - The code lives in your fork `github.com/peterjzhao/lerobot-dataset-visualizer` (`main` at `afd2823`).
  - The local copy is `.../is-t/work/lerobot-dataset-visualizer`; macOS blocks reading it from this session.
- **Context:** you described "a tool im making on the meta quest 3 to like do object and hand tracking", before you had the headset. Clio was never named or opened.
- **The forked viewer:** Hugging Face's LeRobot viewer (Next.js and React Three Fiber, run with bun on 127.0.0.1:3000).
  - Codex added a static scene editor in ROS coordinates (Z up, meters): `src/lib/scene.ts` and `scene-workspace.tsx`.
  - The default view is a Unitree G1 humanoid with props placed by hand. There is no physics.
  - It reads only LeRobot datasets and its own static `.scene.json`.
  - For seeing recorded interactions, Codex recommended object tracking plus replay over adding physics.
- **The recording format, "Quest Capture v1",** in `docs/capture-v1/`:
  - It is a folder, not one JSON file: a `recording.json` manifest, `scene.json`, `calibration.json`, `streams/*.jsonl`, and `video/*.mp4` with a frame index, plus a SHA-256 list of every file.
  - Docs and tools: `FORMAT.md`, `TRANSFER.md`, `capture.schema.json` (1,081 lines), and `validate.cjs` with 16 tests (part of the fork's 178 total).
  - A synthetic example, and a starter kit at `.../is-t/outputs/quest-capture-v1-starter.zip`.
- **LeRobot is a separate, lossy export, not built in:**
  - It uses the official LeRobot writer with the profile `human-observations-v1` at 30 Hz.
  - It holds hand and headset observations and has **no `action` column**.
  - FORMAT.md leaves a robot-specific profile for later. That profile has to define the URDF, joint order, retargeting version and what actions mean. **So no robot schema exists yet.**
- **Export rules:**
  - Positions are interpolated linearly and rotations with SLERP.
  - Never interpolate across a gap over 50 ms, a tracking-loss record or a recenter.
  - Validity flags are ANDed between neighboring samples.
  - Each output frame takes the nearest image within 20 ms.
  - Strict mode needs both hands, the headset and all selected cameras valid. A masked profile is also allowed.
  - No forward-fill and no smoothing.
  - An export report keeps the mapping from source frames to exported frames.
- **Capture targets (planned, never measured):**
  - Meta hand tracking runs at 30 Hz by default and 60 Hz in Fast Motion Mode. The format logs hands at 60 Hz, with a 30 Hz fallback.
  - Headset at 90 Hz.
  - Color video at 60 FPS and 1280×960 (the Passthrough Camera API runs at 60 Hz).
  - Objects at 30 to 60 Hz.
  - Video takes about 240 MB per minute for two cameras at 16 Mbit/s.
- **Transfer (designed, not built):**
  - A receiver on port 8787, reached through `adb reverse tcp:8787`.
  - Resumable uploads in 4 MiB chunks; data stays on the Quest until the receiver confirms it.
  - `TRANSFER.md` sets a build order:
    1. synthetic packages, local import and motion replay
    2. a native recorder with a shared clock and calibration
    3. the receiver and the USB tunnel
    4. QR pairing and Wi-Fi
    5. a pinned LeRobot exporter
- **Where it ended:** only the spec exists. There is no recorder, receiver, replay or exporter.
  - It was designed for a native Quest app (OpenXR or Unity, with Android camera access). Clio is a web app (WebXR).
  - Whether the `bun start` server on port 3000 is still running is unknown.

### Chat 3: "Find natural AR object highlighting"

- **Where and when:** `~/Documents/Codex/2026-10-23/in-x20`, 20:45 to 21:22 PDT: 7 requests, research only, no code. jev, SAM, Gemini and Clio never came up.
- **What it found:**
  - Apple RealityKit's spotlight hover effect, which lights only virtual objects, and MRTK3's proximity light.
  - Meta's Passthrough Relighting. The idea is an invisible shape lined up with the real object, plus a shader that draws only the light over passthrough. Meta's sample is Unity and won't run in a browser.
  - Real Figmin XR footage that lights walls and floors, not small parts.
- **Codex's suggested look:** a small, soft, feathered patch of light on the part. Codex called it a "starting choice"; you never agreed to it. It came with five rules:
  1. The light hugs the surface.
  2. Brighter in the center, with a soft falloff.
  3. The object's texture stays visible.
  4. A hand in front hides the patch.
  5. Fade in with one pulse, then hold steady.
- **The mockup:**
  - Codex generated an image: `/Users/peter/.codex/generated_images/01a16c03-54c2-7340-b65d-0c0701921443/exec-7ab60bf4-e732-4a4a-bfe5-f38181dfb874.png`.
  - You said matching it "would be awesome but im doubtful... across angles".
  - Codex agreed it had overstated what's possible. A soft highlight on a known object that stays still is a reasonable first goal. A physically correct look on small, shiny parts that move is "much more demanding": metal reflections and real shadows can't be reproduced, and any misalignment shows from other angles as floating or spill.
- **The WebXR answer:**
  - It can be done without Unity, but the shader has to be written by hand.
  - Room-scan geometry is too coarse for small parts, so line up a model or a small surface patch instead.
  - First test: one stationary object, lined up by hand.
  - Not checked:
    - Whether the browser's blending (alpha vs additive) can match Figmin's look.
    - Whether Quest Browser supports mesh detection and depth sensing. The sources disagree.

## 2. How the three fit together, and where your description differs

- **What each chat covers:** chat 1 covers detection and segmentation, chat 3 covers how the highlight looks, and chat 2 covers recording and viewing.
- **Clio already has most of the connections:**
  - The planner picks `show` items for each step.
  - `Spotlight` calls `/api/vision/locate`, and `OutlinesPresenter` draws the outlines.
  - The recorder and uploader send episodes to the laptop over `adb reverse`.
  - `clio view` replays an episode in Rerun.

| Your description                                                              | What the chats show                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Three chats worked on the highlighting workflow                               | Only chat 1 touched detection. Chat 3 covered only the look. Chat 2 was a general Quest tracking format and never named Clio.                                                                                                                                                                                                           |
| Gemini decides what matters and prompts jev                                   | No chat combined Gemini and jev. Chat 1's prompts were written by hand. In Clio, the planner's `phrase` and `description` already become the finder's query.                                                                                                                                                                            |
| jev boxes feed SAM 2.1 to make outlines                                       | This was tested offline on 6 still photos. It produces mask images; no code turns masks into polygons yet.                                                                                                                                                                                                                              |
| Outlines                                                                      | Chat 3 leaned toward a soft glow. Clio already draws outlines (commit `a56aace`, 23:18 PDT, about 2 hours after chat 3 ended).                                                                                                                                                                                                          |
| Benchmarks decide Quest vs laptop                                             | Nothing was measured on a Quest.                                                                                                                                                                                                                                                                                                        |
| The last chat produced one custom JSON with a robot (LeRobot) schema built in | Chat 1 actually finished last (23:43); chats 2 and 3 ended at 21:23 and 21:22. Capture v1 is a folder, not one JSON. Codex rejected building LeRobot in: it is a separate export of human observations with no robot actions, and the robot profile is left for later.                                                                  |
| Session output goes over the cable to a localhost visualizer                  | Clio already does the transfer: `adb reverse tcp:5173`, then Vite forwards to the server on 127.0.0.1:8787. Capture v1's planned receiver also wants port 8787. The forked viewer reads neither format.                                                                                                                                 |
| One session format                                                            | There are two. Clio's `clio.episode/1` (commit `4d01886`, 21:21:11 PDT) came before the finished Capture v1 commit (`afd2823`, about 21:22). So Clio's format can't have drawn on the final spec, at most on Codex's 21:08 draft. All 33 Clio commits are by owengregson, which suggests a separate line of work; that is an inference. |

## 3. The combined pipeline in Clio

**How it works today:**
- **The ask:** `Spotlight.enterStep`/`tick` (`apps/headset/src/domain/session/spotlight.ts:45-90`) calls `ObjectGrounder.ground` (`domain/world/grounding.ts:113-165`). That captures a JPEG of about 960×720 at quality 0.8 (`adapters/camera/passthrough-camera.ts:79-113`).
- **The request:** it sends `POST /api/vision/locate` with `{image, objects[{id, query, phrase}]}`, 1 to 16 objects (`packages/protocol/src/api.ts:92-108`).
- **The server's choice:** at `apps/server/src/index.ts:48-50`, if `CLIO_VISION_URL` is set it uses that HTTP finder, otherwise Gemini.
- **What Gemini returns:** a point on the "graspable part" plus a box (`box_2d`) (`services/gemini-vision.ts:18-56`), and no outline.

**Two ways to add jev and SAM:**

|                                     | Combined locator in the server (recommended goal)                                                                                                                                                                                                                            | `CLIO_VISION_URL` only (quick start; the integration map's "simplest variant")                                                                                                                           |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What changes                        | A new `VisionLocator` (interface at `services/vision.ts:22-24`). It runs Gemini's locator and a Python jev+SAM service, merges the results per object, and returns `model: "gemini+jev+sam2.1"`. Wired in at `index.ts:48-50`, with a new setting next to `config.ts:53-54`. | No Clio change: point the variable at the Python service.                                                                                                                                                |
| Gemini while the lesson runs        | Kept: its point on the graspable part and its box survive, and the box can be passed to jev or SAM as a hint.                                                                                                                                                                | **Replaced.** Gemini still picks the targets in the plan, but its live point and box are gone. The 3D placement then uses the box center (`http-vision.ts:83`) unless the service returns its own point. |
| Matches "jev in addition to Gemini" | Yes                                                                                                                                                                                                                                                                          | Only at the planning stage                                                                                                                                                                               |

Either way, the coach's `highlight` and missing-object lookups also go through `spotlight.find` (`lesson-controller.ts:286`, `:440`), so they would wait on jev's roughly 4 s calls too.

**The stages:**
1. **Gemini decides what matters (already built).** Each step has a list of `show[] {object, phrase, description}` items.
   - Prompt: `apps/server/src/services/plan-prompt.ts:53-69`
   - Gemini schema: `plan-schema.ts:160-173`
   - Validation: `packages/protocol/src/procedure.ts:76-93`
   - `show[].object` must be an object declared in the plan (`procedure.ts:78`, `:220`), so each part has to be declared as its own object.
   - Asking the planner to name parts explicitly is worth testing, but the evidence is the single vernier case.
2. **jev returns boxes (new service).** One request carries two questions per object: a Noul question `present_<id>` and a Box question `target_<id>`.
   - Fill in `found` when Noul is at least 0.5, set `confidence` to the Noul value, and send `box` as [left, top, right, bottom].
   - Rules the service must enforce:
     - **JPEG or PNG only.** Clio's request format also allows `webp` (`api.ts:92-108`), so convert it or reject it. The headset sends JPEG today.
     - **Check sizes before sending:** each side 256 to 1568 px, at most 16 MiB, because jev rejects instead of resizing. 960×720 fits.
     - **Header and model:** send `TypeSafe-Danger-Zone-Images: true` and pin `jev-1.14.0`, which has Box.
     - **Validate every box** with `valid_box` (zero-width boxes have been reported), and decide presence from Noul alone.
     - **Rounding:** boxes are rounded to 0.01, about 10 px on a 960 px frame. That matters for small parts, and SAM's refinement helps.
     - **Key and retries:** keep the key on the laptop, and don't retry automatically, because a request that timed out may still be billed.
3. **SAM 2.1 returns masks (new service).** Start from `BoxSegmenter` in `jevbench/sam2.py`, or EdgeTAM's `Segmenter`.
   - Encoding each frame once and decoding all its boxes in one call (`set_image` once, then `predict(box=Nx4)`) might remove the 10 to 19 ms of repeated preprocessing per box.
   - That is untested: `BoxSegmenter` decodes one box per call.
4. **Mask to outline (new code).** Take the largest outer contour and scale it to 0..1, as the example adapter does at `docs/object-finder.md:105-147`. OpenCV isn't installed in Jev fun, so add it or use a scikit-image/scipy equivalent.
   - **One shape per object:** each detection takes a single closed outer polygon, with no holes and no multiple pieces. Only the most confident detection per object is kept (`services/vision.ts:98-107`), so a part that segments into separate pieces keeps only its largest piece.
   - **What the server does with it:**
     - clamps coordinates (`http-vision.ts:116-125`)
     - fills the box from the outline and the point from the box center (`:83`)
     - simplifies the outline to at most 64 points (`services/vision.ts:112`, `:121-139`)
   - **Return a point taken from the mask** (its center, or the point deepest inside it) instead of relying on the box center.
5. **The headset draws (unchanged).** The outline is lifted onto a world-anchored flat panel (`domain/world/outline.ts:65-85`) and drawn as a stroke (`adapters/render/presenters/outlines.ts:43-67`, `:106-115`). Every sighting is recorded as an `object.detected` event (`packages/protocol/src/episode.ts:141-157`).

**Changes to the request format, only if needed:**
- **Gemini's box as a hint for jev or SAM:** needs a per-object `hint` field in the request and finder schemas in `api.ts`. Today the schemas silently drop unknown fields.
- **Which stage produced what, and how long it took:** `Detection` (`api.ts:109-118`) and `object.detected` (`episode.ts:141-157`) hold only one `source` and one `latencyMs`. Add a source for the box and for the outline, plus the time each stage took, then run `pnpm gen:schema`.
- **Doc fix:** `docs/object-finder.md:47` says frames are about 1280×960; they are about 960×720.

**Latency (estimates; nobody has timed a live jev+SAM loop).** Chat 1's hybrid timings add old jev times to new local times, so they don't measure a real loop.
- **One locate call:**
  - jev: median 3.9 s (1.72 to 5.72 s).
  - SAM, which has to encode a new frame on every call:
    - Small: 0.13 to 0.20 s plus 23 to 40 ms per box, about 0.22 to 0.36 s for 4 boxes.
    - Large: 0.44 to 0.86 s plus the boxes.
    - EdgeTAM: 42 ms plus 15 ms per extra box, about 87 ms for 4.
  - Cable plus JPEG encoding: estimated at 15 to 40 ms.
  - In the combined route, Gemini's time adds on top unless it runs alongside jev. Its latency isn't measured anywhere in this material.
  - Clio gives up after 15 s (`http-vision.ts:28`).
- **Refresh cycle:** Spotlight asks again about 3 s after each answer and never has two requests out at once (`spotlight.ts:28`, `:74`, `:84`). One cycle is about 3 s of waiting plus 3.9 s for jev plus SAM: roughly 7 s.
- **What you'd see:**
  - The first outline appears about 4 s after a step starts.
  - Head movement is fine, because outlines are anchored in the world.
  - If an object moves just after a frame is captured, its old outline stays until a later frame shows the new position. At median jev speed that can take up to about 11 s.

**Call volume:**
- **How many:** at one call every 7 s or so per active step, that's about 500 paid jev calls an hour.
- **How big:** each call uses at least 3.2k input tokens, about 1.7 million input tokens an hour.
- **Price:** jev's pricing isn't in the material.
- **Ways to cut it:**
  - Ask jev less often.
  - Call it only when a step starts, when a target goes missing, or when tracking suggests something moved.
  - In the combined route, let Gemini's locator handle routine refreshes.

**What can be reused from Jev fun:**
- **jev client:** `Jev` in `jevbench/providers.py`, with the exact request and response format and the no-retry policy.
- **Segmenters:** `BoxSegmenter`, `mask_box()` and `padded_box()` in `jevbench/sam2.py`, and the `Segmenter` class in `experiments/edgetam/run_eval.py`.
- **Helpers:** `core.valid_box`, `core.iou`, and `core.prepare_image` (fits images within 1568 px and pads them). The last one is useful for converting webp or oversize frames.
- **Test patterns from `tests/test_experiment.py`:**
  - The jev request format tested against a fake network.
  - A fixture that blocks real network calls in every test.
- **Scoring:** the false-positive rule from section 1.
- **Look:** the SVG glow recipe in `experiments/edgetam/preview/`.
- **Version pin:** `transformers` is pinned to 5.20.2 because of the copied weight converters in `jevbench/vendor/`.

## 4. Where SAM 2.1 should run: Quest or laptop

**Recommendation: run it on the laptop, inside the jev+SAM service.**
- **No extra transfer:** the laptop already receives every frame and every jev answer, and the jev key has to live there anyway.
- **SAM speed matters less than it seems:** Clio redraws world-anchored outlines every XR frame, so SAM's speed only affects how soon an outline appears and how stale it gets after something moves. With jev taking 3.9 s, SAM is a small part of each cycle.
- **The Quest's GPU is busy:** on the Quest, SAM would compete with drawing the XR scene on the same GPU.
- **The headset option:** running it on the Quest would mean a local `VisionLocator` swapped in at `apps/headset/src/app/clio-app.ts:113` (described at `docs/ARCHITECTURE.md:291`).

**Speed, and where each number comes from:**

|                                                | Measured (this Mac, MPS, 1280 px stills)                                                       | Estimated                                                          |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| SAM 2.1 Small                                  | Encode 130 to 200 ms median including preprocessing (max 415 ms); 23 to 40 ms per box as built | Research guess for an M5 Pro: 50 to 100 ms per frame (unconfirmed) |
| SAM 2.1 Large                                  | Encode 0.44 to 0.86 s                                                                          |                                                                    |
| EdgeTAM                                        | 42 ms on a new image (encode plus decode), 15 ms cached                                        | Core ML: 15 to 30 ms                                               |
| SAM 2.1 tiny in Quest Browser (WebGPU)         | Not measured                                                                                   | 0.4 to 1.5 s per frame while the scene renders (an extrapolation)  |
| sam2-mlx vs PyTorch on MPS                     | 1.3 to 1.4 times faster, measured by a third party on an M2 Max                                |                                                                    |
| USB transfer plus JPEG encoding on the headset | Not measured                                                                                   | 15 to 40 ms                                                        |

SAM 2 stretches every input to 1024×1024, so frame size doesn't change how much work the model does. It only changes the JPEG size and decode time.

**Gaps to know about:**
- **SAM 2.1 Small already fails benchmark A's bar:**
  - The bar is encode plus 4 boxes in p50 ≤ 60 ms and p95 ≤ 120 ms, and the measured encode alone takes 130 to 200 ms.
  - Its 415 ms worst case is past the fail line (p95 over 250 ms).
  - It is also slower than the research's 50 to 100 ms guess. The measurement includes preprocessing of 1280 px images, so a cleaner timing may come in lower, but expect a gap.
- **EdgeTAM is the only measured option near the bar,** and it's still over for 4 boxes (about 87 ms) unless decoding several boxes at once helps.
  - Its masks are less accurate in the EdgeTAM paper. On the SA-23 benchmark it scores 55.5 mIoU from one click against 61.9 for SAM 2.1, and 81.7 against 83.5 from five clicks.
  - In Jev fun it matched SAM 2.1 only on the mask's bounding box (0.790); its masks themselves were never checked.
- **What to do:** start with SAM 2.1 Small for quality, since it is already built and matches Meta's code. The speed bar only starts to matter once something faster than jev sets the pace (live tracking, test D). Check EdgeTAM's masks before switching to it.

**What we know about running it on the Quest:**
- **WebGPU:** available in Quest Browser since version 32.0.
  - Using WebGPU to draw the XR scene needs `chrome://flags` settings and is experimental.
  - Inference would run on a separate WebGPU device while WebGL draws the scene.
- **Native apps:** Meta's native camera route (the Passthrough Camera API and its YOLO sample) doesn't help a WebXR app unless Clio becomes a native app.
- **Expectation:** the research expects SAM 2.1 to fail the Quest test (C) and calls EdgeTAM uncertain.
- **Earlier on-device work:**
  - Your FastSAM Core ML/Swift project in `~/Documents/ChatGPT/sightsense`.
  - A paper that turned up in chat 3's search results (arXiv 2509.18929) proposes FastSAM on the Quest through Unity Sentis. Nobody evaluated it.

**Benchmark plan** (from `sam-2.1-placement-research.md`):
- **Test set:** 100 to 200 real Quest frames with their jev boxes, with SAM 2.1 Large as the quality reference. Clio doesn't save frames yet (see section 5), so start test A on the 6 Jev fun photos; `refine` makes no API calls.
- **Method:**
  - 10 warm-up runs, then 100 timed runs, reporting p50, p95 and p99.
  - Report load and compile time separately.
  - On MPS, call `torch.mps.synchronize()` before reading the clock.
- **Memory hygiene:**
  - Run one timing job per device at a time.
  - Wrap each iteration of any Swift or Core ML loop in `autoreleasepool`.
  - Check that `ps -o rss=` stays flat before starting another job.

| Test                                | What runs                                                                                                                                                                                                                                                                                  | Pass                                                                                                                                                                                                                        |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Laptop                           | PyTorch MPS tiny, small and base+ in fp32 and fp16; sam2-mlx tiny and small; Apple's Core ML SAM 2.1 tiny and small, on `.cpuAndNeuralEngine` vs `.cpuAndGPU`; EdgeTAM Core ML. Time each stage: decode and resize, encode, 1, 4 and 16 boxes, and mask to a polygon of at most 64 points. | Encode plus 4 boxes: p50 ≤ 60 ms, p95 ≤ 120 ms (fail if p95 > 250 ms). Each extra box ≤ 10 ms. Peak memory ≤ 3 GB and flat over 1,000 runs. Masks vs Large: mean IoU ≥ 0.90, worst ≥ 0.75. p95 rises ≤ 20% over 10 minutes. |
| B. Full loop over USB               | JPEGs of 50, 150 and 300 KB over `adb reverse`, compared with Wi-Fi. jev and Gemini timed separately.                                                                                                                                                                                      | SAM adds p95 ≤ 150 ms. Transfer ≤ 20 ms. Headset JPEG encode ≤ 8 ms, or moved off the main thread. Step start to outline ≤ 1.0 s (≤ 1.5 s acceptable) **with jev included**; see the note below.                            |
| C. Quest test (can run alongside A) | `navigator.gpu.requestAdapter()`, then ONNX Runtime Web with the SAM 2.1 tiny `.ort` encoder and EdgeTAM (if an ONNX export runs), inside an `immersive-ar` session                                                                                                                        | Encode ≤ 300 ms, with no extra dropped frames at 72 Hz (p99 frame time ≤ 13.9 ms)                                                                                                                                           |
| D. Optional tracking                | EdgeTAM or the SAM 2 video predictor on the laptop, following objects between jev calls                                                                                                                                                                                                    | ≥ 10 Hz, and ≤ 100 ms from capture to display                                                                                                                                                                               |

**Note on test B:** the research's step-start target includes jev, but jev alone takes 3.9 s median and 1.72 s at best, so the test can't pass as written. You need to decide between two options. B could measure only the SAM, transfer and drawing share. Or something faster than jev (Gemini's own box, or tracking) could place the first outline, which is a design change.

## 5. Session output and the localhost visualizer

**What "robot schema built in" turned out to be:** Capture v1 is a folder format for a native Quest app, with a separate LeRobot export of human observations. The robot profile (URDF, joint order, retargeting, what actions mean) hasn't been defined.

|             | `clio.episode/1` (Clio, built)                                                                                                                                                                                      | Quest Capture v1 (chat 2, spec only)                                                                                                                                                                                                                                                               |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Layout      | `data/episodes/<id>/`: `meta.json`, `frames.ndjson`, `events.ndjson`, `objects.ndjson`, `media/`                                                                                                                    | `recording.json`, `scene.json`, `calibration.json`, `streams/*.jsonl`, `video/*.mp4` with a frame index, and a SHA-256 list of files                                                                                                                                                               |
| Coordinates | Workspace frame W, y up, meters. Origin at a calibration corner on the table                                                                                                                                        | ROS REP-103, Z up, rotations as quaternions (xyzw). Origin on the floor under the table                                                                                                                                                                                                            |
| Time        | Milliseconds on `performance.now`                                                                                                                                                                                   | Whole microseconds, plus `available_t_us` (when the value became available)                                                                                                                                                                                                                        |
| Hands       | 25 WebXR joints × 8 values, 72 to 120 Hz                                                                                                                                                                            | 26 OpenXR joints with validity flags. Lost tracking is `null` with flags 0, never zero                                                                                                                                                                                                             |
| Detections  | `object.detected`: 2D box, outline, confidence, source, latency, 3D position                                                                                                                                        | No field for 2D results. The `details` of a `marker` event can hold them as notes, but without capture or availability times. A 3D pose can point to its source frame (`input_camera_frame`) only if the package includes that MP4 and its frame index. `source_id` must match `^[a-zA-Z0-9_-]+$`. |
| Camera      | No frames or calibration recorded                                                                                                                                                                                   | `calibration.json` with camera intrinsics                                                                                                                                                                                                                                                          |
| LeRobot     | `pipeline/src/clio_pipeline/lerobot_export.py`: action = the next frame's state, untracked hands carried forward, missing objects filled with zeros, no video. Already converts to Z up with the same axis mapping. | Official writer, 30 Hz, observations only, no filling, plus an export report                                                                                                                                                                                                                       |
| Transfer    | Built: `adb reverse tcp:5173`, server on 8787                                                                                                                                                                       | Designed: receiver on 8787, resumable uploads                                                                                                                                                                                                                                                      |

**Recommendation:**
- **Keep `clio.episode/1` as the session record.** It exists, already travels over the cable and already records detections.
- **Bring over Capture v1's export rules** (listed in section 1) into `lerobot_export.py`: stop inventing actions, carrying hands forward and filling gaps with zeros.
- **Add camera information:** a camera calibration and a per-frame image index, plus a record of which source produced each value.
- **Don't run Capture v1's receiver on port 8787** next to Clio's server.
- **Hand data:** Meta's Unity hand-tracking docs limit system hand-pose data to hand tracking inside the app. Whether that also covers WebXR hand joints in Clio is unverified. Check before publishing training data.

**What exists for viewing:**
- **`clio view <episode>`** (Rerun, `pipeline/src/clio_pipeline/rerun_view.py`) works only on finished episodes. Detections show as a text line and a 3D point; boxes, outlines and images are not drawn.
- **Server read endpoints** (`apps/server/src/routes/episodes.ts:66-84`) return each whole file once. There is no way to follow new data as it arrives.
- **The forked LeRobot viewer** on 127.0.0.1:3000 reads only LeRobot datasets and its own static `.scene.json`. That format uses ROS Z up, requires a `base_link`, holds at most 100 objects and has no timestamps.

**What to build:**
1. **Save camera frames.** Any viewer that shows the learner's environment needs these.
   - Today the server throws away the image sent to locate (`routes/vision.ts:12-31`), and nothing calls `putMedia`.
   - Have the headset upload `media/cam-NNNNNN.jpg` (names must match `apps/server/src/ids.ts:5`) with a `camera.frame` event.
   - Put `CameraModel` (intrinsics and `headFromCamera`; `camera-model.ts:25-29`) into `meta.json`.
2. **Follow mode, which both viewers need.** Stream new data as it's written in `appendBatch` (`storage/episode-store.ts:119-140`), either as server-sent events or with a `?from=` parameter on the read endpoints. The recorder writes a batch every second, so a live view will lag about 1 s.
3. **Pick a viewer:**
   - **Rerun, live.** It already reads Clio episodes. Keep a recording stream open, draw boxes and outlines over the camera image, and start recording the 3D outline event (`overlay.outline`). This is the fastest route to a live view.
   - **The forked LeRobot viewer,** which is what your plan implies. It needs an adapter from `clio.episode/1` into its scene format plus timestamped object, hand and detection tracks. Use Clio's format rather than Capture v1, since nothing records Capture v1. The axis conversion already exists in `lerobot_export.py`. Chat 2 named this adapter as the missing piece. Its 3D replay animates robot models (URDFs), so drawing human hands and outlines would need new code; that is an inference from what it supports today.
   - **Suggested order:** Rerun first, to get a working live view. Then the adapter, if the fork is meant to be the long-term view of the learner's environment.

A viewer on the laptop can read 127.0.0.1:8787 or the `data/` folder directly, so it needs no new adb port.

## 6. Open questions, risks and next tasks

**Open questions:**
- **Route:** the combined locator, which keeps Gemini's live point and box, or `CLIO_VISION_URL`, which drops them?
- **jev budget:** how often should Clio call jev? At today's pace it would be about 500 calls an hour per active step.
- **The look:** outlines (what Clio draws now) or a soft glow (chat 3's starting choice)? The mockup you liked overstates what's possible on small, shiny parts that move.
- **Parts:** declare each part as its own object in the plan, or add a sub-part concept?
- **Gemini's boxes:** pass them to jev or SAM as hints (a request-format change), or rely on `phrase` and `query` alone?
- **Test B:** keep the target that includes jev (unreachable today), or measure only SAM's share?
- **Viewer:** live Rerun, the fork plus an adapter, or both?
- **Formats:** one session format or two? The robot profile is undefined. Agree on this with the owengregson line of work.
- **Hand data:** do Meta's terms cover WebXR hand joints (see section 5)?
- **Quest Browser:** are mesh detection and depth sensing available? Both are unconfirmed, and they matter for hiding the highlight behind hands and for placing masks in 3D.

**Risks:**
- **jev reliability:**
  - Median latency is 3.9 s, and outlines can stay up to about 11 s stale after something moves.
  - Occasional HTTP 529 errors, and unknown cost.
  - Box and image input are experimental (Box needs `jev-1.14.0`), and zero-width boxes have been reported.
- **Batching untested:** several objects, each with a Box and a Noul question, in one request has never been tried. Nor has whether accuracy drops as questions are added.
- **Gates:** the Noul margin is thin (the lowest present object scored 0.54), and Box confidence can't be used as a gate.
- **Small parts:** boxes are rounded to 0.01 (about 10 px), and electronics was jev's weakest category.
- **Masks:**
  - Accuracy was never measured; only the masks' bounding boxes were scored.
  - SAM misses glass fittings.
  - EdgeTAM's masks are unchecked.
  - One polygon per object drops any extra pieces.
- **Speed:** SAM 2.1 Small fails benchmark A's bar on this Mac.
- **Test data:** 6 Wikimedia photos with boxes Codex drew, not Quest passthrough frames.
- **Exporter:** Clio's exporter invents actions and fills in missing data.
- **Port clash:** Clio's server and Capture v1's receiver both want port 8787.
- **Running processes:** the Obscura review server (pid 52288) was still running when checked, and the port 3000 server may be.

**Next tasks that can run in parallel:**
1. **jev+SAM finder service** (Python, on the laptop): the jev client with the rules from section 3, `BoxSegmenter` or EdgeTAM, a single-polygon outline and a point taken from the mask. Tests must block live calls.
2. **Combined locator in Clio's server,** plus the per-stage source and timing fields and `pnpm gen:schema`. This can start against a fake version of task 1.
3. **Frame saving in Clio:** frames, `camera.frame` events, and `CameraModel` in `meta.json`.
4. **Laptop benchmark A** on the Jev fun photos now, and on Quest frames once task 3 is done.
5. **Quest WebGPU test C.** It runs live in an `immersive-ar` session and needs no saved frames, so it can run alongside task 4.
6. **Follow mode and a live viewer,** Rerun first. Showing camera images needs task 3.
7. **Exporter fixes** in `lerobot_export.py`, following Capture v1's rules.
8. **Paid jev tests:** several objects with Box and Noul in one request, part wording, and a slower re-ask pace. These cost money, so they need your go-ahead.
9. **Look prototype:** one stationary object lined up by hand, comparing an outline with a glow.

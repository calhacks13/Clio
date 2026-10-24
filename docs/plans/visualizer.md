# Clio episode viewer in visualizer/: implementation plan

Date: 2026-10-24. Facts come from the four reader reports and were re-checked in the repo where cited. Repo files were only read; the status check below ran read-only commands.

## 1. Decision summary

- **Where:** a new route tree in `visualizer/`:
  - `/clio` is the episode list.
  - `/clio/live` follows the newest episode.
  - `/clio/[episodeId]` is pinned to one episode.

  All three render a new R3F `ClioReplayViewer`. It does not extend `EpisodeViewer` or `URDFViewer`, which parse numeric episode ids (`src/app/[org]/[dataset]/[episode]/page.tsx:25`). The HF/G1 demo stays a separate mode.
- **What it reads:** the existing Clio server, through a GET-only loopback proxy (`/api/clio/...` to 127.0.0.1:8787) for the list, detail, and `frames|events|objects?from=`.
  - There is no new receiver and no new `adb reverse`. The headset path (5173, then the Vite proxy, then 8787) is unchanged.
  - One server addition: the detail response reports batch integrity (task V), as `INTEGRATION.md:28` asks.
- **Live follow:**
  - Poll every 500 ms. Read frames first, then events and objects.
  - The builder drops duplicates.
  - When joining a live episode whose frames file is large, start about 2 MB before its end.
  - Keep hand samples for the last 5 minutes behind the live edge.
  - The clock plays 1.5 s behind the newest received episode time. Laptop arrival time only paces the playhead and is never written into a sample time (`GOALS.md:53`, `TRANSFER.md:54`).
  - Screen delay behind the headset: estimated about 2.3 s on average; measured 1.83 s on average (1.4 to 2.9 s) in the S1 simulation. Check C measures it on the Quest.
- **Objects as time series:** the viewer holds a model with the Capture v1 shape (`apps/headset/src/viewer/capture/model.ts`). Each object has a pose series, held spans and detector answers. One `tUs` drives:
  - in 3D: the pose, a trail, a held ring and an unknown-orientation state;
  - on per-object lanes: updates by source, held spans, detector answers with latency, and misses.

  Before the protocol extension, validity is honest but thin: source, estimate type, time since the last update (derived) and detector answers. Confidence is shown only when it was measured.
- **Reconciliation (recommended):**
  - `clio.episode/1` stays the stored and wire format.
  - Capture v1 is the viewer's in-memory shape, and later an export.
  - Held state, location flags and observation time come from an optional, backward-compatible extension inside `clio.episode/1` (P1 to P3, needs your approval).
  - **Alternative (not recommended):** store and transfer Capture v1 packages (`visualizer/docs/capture-v1/TRANSFER.md`). That gives no live data, needs a second receiver on 8787 and creates a second production contract.
- **Code sharing:**
  - The visualizer imports the framework-free modules through one alias, `@clio-viewer/*`. Its target is `apps/headset/src/viewer` (option 1) or `packages/episode-model` (option 2). Wave 0 waits for your answer to decision 2.
  - Webpack only, never `--turbopack`.
  - `three` is pinned by a webpack alias, and an import-graph test guards against a second copy.
- **`apps/headset/viewer.html`:** frozen as the fallback that runs on `pnpm dev` alone. It is retired only after check C passes, if you choose to (decision 3).

## 2. Architecture

### 2.1 Routes and following

| URL          | Behavior                                                                                                                                                                                                                   |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/clio`      | List, newest first. Each row has a status (live if it grew in the last 15 s, otherwise stopped or finished) and a missing-batch count from V. A solid "Follow live" button opens `/clio/live`.                             |
| `/clio/live` | Follows the newest episode. The URL stays the same when the source switches to a newer episode. The header shows the procedure title and start time. "Pin" calls `router.replace('/clio/<id>')`. A reload keeps following. |
| `/clio/<id>` | Pinned. Follows that episode while it grows and never switches. Opening it counts as pinning.                                                                                                                              |
- This copies the headset viewer's rule that the address names an episode only when the user picked one (`main.ts:84-89`).
- `live` can't collide with server ids, which are `ep-YYYYMMDD-HHMMSS-xxxx` (`apps/server/src/ids.ts:17-26`).

### 2.2 Visualizer modules (new unless noted)

| Module                    | File(s)                                                                                                                          | Role                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Proxy                     | `src/app/api/clio/[...path]/route.ts`, `src/lib/clio/proxy-rules.ts`                                                             | Rules in the list after this table. Modeled on `src/app/api/proxy/[...path]/route.ts:77-97`.                                                                                                                                                                                                                                                                                                                                                                                 |
| Types                     | `src/lib/clio/types.ts`                                                                                                          | `EpisodeSourceState` (capture, revision, status `live\|stopped\|finished`, offsets, loaded range, `handsKeptFromUs`, batches, error), `ClockState`, lane types.                                                                                                                                                                                                                                                                                                              |
| Fixture generator         | `src/lib/clio/__fixtures__/synthetic-episode.ts`                                                                                 | Pure. Generates raw Clio records (meta, frames, events, objects): a pH-like scene with a carried tool, a hand dropout, a detector answer with `latencyMs`, a `found:false` miss, a hidden region and two steps. Used by tests and the harness pages.                                                                                                                                                                                                                         |
| Source                    | `src/lib/clio/source.ts`                                                                                                         | Poll loop and follow/pin. Read order: frames, then events and objects. Applies them to `ClioCaptureBuilder` in the order frames, events, objects. Handles join-at-tail, hand retention, backoff, shrink reset, 404 and the final read. `subscribe`/`getSnapshot` for `useSyncExternalStore`.                                                                                                                                                                                 |
| Live clock                | `src/lib/clio/live-clock.ts`                                                                                                     | Pure. `edge` = newest received frame `t`, advanced by laptop time since that read. The playhead is `edge − 1.5 s`. It never passes the edge and snaps forward when the backlog exceeds 3 s. In replay it clamps to `capture.endUs`.                                                                                                                                                                                                                                          |
| Object display            | `src/lib/clio/object-display.ts`                                                                                                 | Pure per-object state at `tUs`: position, `orientationKnown`, trail, `heldSpanAt`, age since the last update, source, estimate type, confidence (null unless measured), last detector answer. Skips hidden entities unless asked.                                                                                                                                                                                                                                            |
| Detection geometry        | `src/lib/clio/detection-geometry.ts`                                                                                             | Pure. Takes `detectionOutline(det, headWAt(capture, observedUs))` (in W), applies `rosFromW` once, and caches by event sequence.                                                                                                                                                                                                                                                                                                                                             |
| Lanes                     | `src/lib/clio/lanes.ts`                                                                                                          | Pure, on one axis for the whole episode, per object: update ticks by source, held spans (inferred or recorded), detector answers drawn from observation to availability, misses, and "not loaded" / "hands not kept" spans. Not `DataRecharts` (`data-recharts.tsx:391-395,480,505-508,546`).                                                                                                                                                                                |
| Clock driver              | `src/components/clio/clio-clock.tsx`                                                                                             | A requestAnimationFrame loop calling `seek(t,"video")` and `setDuration` on `TimeProvider` (`src/context/time-context.tsx:61-141`). Converts seconds to µs once, as `Math.round(t*1e6)`.                                                                                                                                                                                                                                                                                     |
| 3D scene                  | `src/components/clio/clio-scene.tsx`, `layers/{environment,hands,head,objects,detections}.tsx`                                   | One `<group quaternion={ROS_TO_RENDER}>` at scale 1 (`src/lib/scene.ts:39`).`frameloop="demand"`; layers `subscribe()` and `invalidate()`. Layer details below.                                                                                                                                                                                                                                                                                                              |
| Panels                    | `src/components/clio/{object-lanes,object-inspector,event-list,step-banner,clio-playback-bar}.tsx`                               | `step-banner` shows `stepAt(...).instruction`. The event list uses `event-log.ts`. The bar shows sub-second time, the live state and lag.                                                                                                                                                                                                                                                                                                                                    |
| Harness pages             | `src/app/clio/dev/{scene,lanes}/page.tsx`                                                                                        | Dev only. Render the generated fixture without the server, so T3 and T4 can be checked visually before T5.                                                                                                                                                                                                                                                                                                                                                                   |
| SceneEditor, Clio variant | `src/components/scene-workspace.tsx` (existing)                                                                                  | `variant: "robot" \| "clio"`, default `"robot"`. In `"clio"` it hides the "Robot root" option and its pose inputs (`:541,627`). It replaces the origin text (`:648-651`) with "Origin is the calibrated table corner. X points away from the learner, Y left, Z up." It replaces "Objects are static context, not recorded motion" (`:659-660`) with "Props added here are static. Tracked objects come from the recording." The axes label (`:214`) becomes "table corner". |
| Shell and pages           | `src/components/clio/clio-replay-viewer.tsx`, `src/app/clio/{page,live/page,[episodeId]/page}.tsx`, a link in `src/app/page.tsx` | Lazy-loaded with `ssr:false`, like `URDFViewer` (`episode-viewer.tsx:39`). Includes a dev-only lag readout (below).                                                                                                                                                                                                                                                                                                                                                          |

**Proxy rules:**
- GET and HEAD only.
- The upstream comes from `CLIO_SERVER_URL` (default `http://127.0.0.1:8787`), and its host must be loopback.
- Paths: `episodes`, `episodes/<id>`, `episodes/<id>/(frames|events|objects)`. The id must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`.
- Forwards only a digits-only `from`.
- Returns only `content-type`, `x-next-from` and `cache-control: no-store`, and streams the body.
- Uses `redirect:'error'` and aborts on `req.signal`.
- Rejects a `Host` that is not loopback.
- Builds request headers from scratch, so the `hf_access_token` cookie is never forwarded.

**Layer details:**
- **Environment:** the `workspace` box. Also a floor plane from `Capture.space.worldFromWorkspace` (the local-floor y=0 plane mapped into W, then `rosFromW`), labeled "floor from calibration". The existing Grid at y=0 is the table plane.
- **Hands:** 25 joints through `handAt` and `HAND_BONES`. The palm is skipped. A hand is hidden when inactive or outside the kept range.
- **Head:** `entityAt` and `trail`.
- **Objects:** a dot, a radius ring, a trail and a held ring. With an unknown orientation it is drawn without a heading, and the inspector says "orientation unknown".
- **Detections:** outlines labeled "approximate" (assumed camera model, `detection-outline.ts:12`).

**Dev lag readout** (needed for checks S and C):
- `clock edge − displayed t` ("Behind edge"). It holds at the 1.5 s play delay while following. `newest received t − displayed t` is not used: the edge advances on laptop time between reads, so that figure saws between about 0.5 s and 1.5 s with each 1 s batch.
- `laptop now − (meta.clock.startEpochMs + newest t)`, labeled approximate because the headset and laptop clocks can differ.
- The builder's `duplicates` and `rejected` counts.

### 2.3 Shared code

- **`visualizer/tsconfig.json` `paths`:**
  - `"@clio/protocol": ["../packages/protocol/src/index.ts"]`
  - `"@clio-viewer/*": [<target from decision 2>]`

  With option 1 or option 2, only that target path differs.
- **`visualizer/next.config.ts`:**
  - Set `experimental.externalDir: true`. Today it is on only as a side effect of `transpilePackages`.
  - Add a webpack `resolve.alias` pinning `three` to `visualizer/node_modules/three`, so even an indirect import resolves to 0.182.0, never the headset's 0.186.1.
- **Import guard:** a bun test (`src/lib/clio/__tests__/import-graph.test.ts`) walks the transitive imports of every allowed module (`Bun.Transpiler.scanImports`). It fails on `three`, `capture/index.ts`, `object-tracks-view.ts`, `scene.ts`, `panel.ts` or `main.ts`. The `no-restricted-imports` lint rule is a second line and catches only direct imports from visualizer files.
- **Allowed imports:**
  - `capture/model.ts`, `capture/from-clio.ts`, `capture/clio-events.ts` (new in H1), `capture/from-package.ts`
  - `api.ts`, `event-log.ts`
  - `detection-outline.ts` and its four pure dependencies (`core/math`, `domain/world/camera-model`, `domain/world/outline`, `adapters/camera/calibration`)
  - `episode-data.ts` only as a transitive dependency (`NdjsonDecoder`, `formatClock`). The visualizer never constructs `EpisodeData`. That class keeps the raw `FrameRecord[]`, and `stepAt`, `detectionsAt` and `headAtCapture` are its methods (`episode-data.ts:112,179,224,249`). H1 provides those lookups over the Capture instead.
- **Dependency on the parent workspace:** `@clio/protocol` needs zod from `packages/protocol/node_modules`, so the root `pnpm install` must have run. That goes against `GOALS.md:21` (item 7). An unverified option to avoid it: add zod to the visualizer and alias `zod` to the visualizer's copy.

### 2.4 Server

- **V1: line counts.** In `apps/server/src/storage/files.ts` and `episode-store.ts`, count lines incrementally (only bytes past the cached size). Today `GET /api/episodes` rescans growing files from byte 0; frames grow by about 210 KB/s.
- **V2: batch integrity.** `GET /api/episodes/:id` adds `batches: { received: number, gaps: number[], lastSeq: number|null }`, read from `batches.json`. It is an optional field on `EpisodeDetailResponseSchema` (`packages/protocol/src/api.ts:149-153`; not a generated schema). The viewer shows "complete" when `finish.batches === received` and gaps is empty, otherwise "N batches missing".
- **CORS:** a decision (section 6). The proxy doesn't need CORS, and `x-next-from` is not exposed today (`app.ts:22`).
- **Later:** an SSE feed at `GET /api/episodes/live`. A GET media route is deferred (section 4).
- **Never proxied:** `/gemini/*`, `/api/coach/token`, `/api/plans`, `/api/vision/locate`, `/api/clips/*`, and any write.

### 2.5 Data flow and time

1. The XR frame is recorded (`clio-app.ts:221`). A batch is cut at 90 frames or 1000 ms (`recorder.ts:24-27`) and carries frames, events and objects together.
2. `Uploader` POSTs to `localhost:5173/api/episodes/:id/batches`. `adb reverse tcp:5173` carries it to the laptop, and Vite proxies it to 8787.
3. `EpisodeStore.appendBatch` appends frames, then events, then objects, under one lock per episode.
4. The browser on 127.0.0.1:3001 calls `/api/clio/.../frames?from=N`, then events and objects. The Next route streams `[from, end)` with `x-next-from`.
5. `NdjsonTail` decodes only whole lines. `ClioCaptureBuilder` drops duplicates, converts ms to µs and W to ROS once, then the revision bumps.
6. The clock chooses `tUs`. The layers, lanes and inspector all query the same `tUs`.

**Time rule:** every sample time is the recording's `t` (ms to µs once, in the builder). The laptop arrival time (`performance.now()` when a read completes) feeds only `live-clock` and the lag readout.

**Latency, estimated:**

| Stage          | Cost                               |
| -------------- | ---------------------------------- |
| Recorder batch | 0 to 1000 ms, about 500 ms average |
| Upload         | about 20 to 80 ms (not measured)   |
| Poll wait      | 0 to 500 ms, about 250 ms average  |

Newest data reaches the laptop about 0.8 s after capture on average. With the 1.5 s play delay, the screen is about 2.3 s behind the headset. Measured in the S1 simulation: newest data is 0.27 s old on arrival (0 to 0.5 s) and the screen is 1.83 s behind capture on average (1.4 to 2.9 s). Check C must still measure this on the Quest.

## 3. Object time-series model

### 3.1 Today (`capture/model.ts`)

- `Entity {id, name, role, motion, geometry, pose|null, extensions.radius_m}`.
- `PoseSample {t_us, sequence, source_id, estimate_type, entity_id, location{translation|null, rotation|null, location_flags}, confidence|null}`. Flags: 1 orientation valid, 2 position valid, 4 orientation tracked, 8 position tracked.
- `CaptureEvent.origin: 'inferred'|'manual'|'runtime'|'synthetic'` (`model.ts:110`).
- `HandSample`: 26 OpenXR slots; slot 0 (the palm) is always invalid.
- Every Clio event is already kept as a `marker` with `details.clio` (`from-clio.ts:194-200`).

### 3.2 H1 additions: the exact contract wave 1 codes against

Names listed here are frozen when H1 merges. Existing exports keep their names; `heldAt` becomes a wrapper over held spans.

**Entities, hands and space:**
- `Entity.extensions: { radius_m?: number; kind?: 'item'|'tool'|'container'|'point'|'region'; hidden?: boolean }`.
  - `motion` is `tracked` for item/tool/container, `static` for point/region, and `tracked` when the plan doesn't list the object.
  - Hidden objects keep their entity with `hidden: true`. Shirt-fold `middle_low_zone` is hidden (`fixtures/episodes/synthetic-shirt-fold/meta.json`). Display layers skip hidden entities.
- `HandSample.pinch_m: number | null`. Hand joint flags become `POSITION_VALID` only, because joint orientations are dropped.
- `Capture.space`: `meta.space` as recorded, in W and unconverted (`worldFromWorkspace`, `calibration`, `anchored`).

**Held spans:**
- `HeldSpan { entityId; hand: Handedness|null; startUs; endUs: number|null; origin: 'inferred'|'runtime'; grip: 'pinch'|'fist'|null }`.
- `capture.heldSpans(entityId)` and `heldSpanAt(capture, entityId, tUs)` are kept up to date as events are added. This replaces the per-frame replay in `heldAt`.
- Inferred spans:
  - come from `hand.pinch` start within radius + 0.04 m of a movable, non-hidden object;
  - end on that hand's pinch end;
  - also come from runs of `source:'pinch'` samples arriving at frame rate (gaps of 50 ms or less) without a matching pinch. These are fist carries, written each frame by `updateHeld`; they get `hand: null` and `grip: null`.

**Clio event lookups** (`capture/clio-events.ts`, new, pure, indexed as events arrive):
- `stepAt(capture, tUs): StepEntered | null`.
- `detectionsFor(capture, entityId): DetectionMark[]`, where `DetectionMark = {availableUs, observedUs = availableUs − latencyMs·1000, found, confidence, source, eventSequence}`.
- `detectionsAt(capture, tUs)`: the newest answer per object.
- `headWAt(capture, tUs): Pose7 | null`: the head pose converted back to W for `detection-outline.ts`.
- `wFromRos` and `wQuatFromRos` in `from-clio.ts`, with round-trip tests.

**Estimate type and confidence:**
- A `source:'pinch'` sample inside a held span, including the release sample at `endUs`, becomes `runtime_estimate` with `source_id: 'clio-grip'`. Any other `source:'pinch'` sample is a pinch registration and becomes `manual`.
- Confidence is kept only for detector and marker samples. The others are fixed placeholders, not measurements, and become `null`:
  - layout 1 (`object-registry.ts:67`);
  - pinch registration 0.9 (`lesson-controller.ts:277`);
  - held objects keep their value from before the grasp.

  This matches the planned export mapping (object report §4).

**Duplicates and retention:**
- The builder drops frames whose `t` is not after the last frame. It dedupes object states by `(t, id)` and events by exact equality at the same `t`, and counts what it drops in `duplicates`. Today `Series.add` inserts duplicates (`model.ts:122-126`).
- `Series.dropBefore(tUs): number`, used for hand retention.

**Other fixes:**
- `buildCaptureFromClio` applies frames, events, objects in that order.
- Objects first seen in `objects.ndjson` get a radius.
- `meta.hands.joints` and `jointFields` are checked against the protocol constants; a mismatch throws a clear error.
- `NdjsonTail` gains `{ from?: number, skipFirstLine?: boolean }` (`api.ts:45-86`) for joining partway through a file.
- `object-tracks-view.ts:207`: when rotation is null, reset to identity and mark the orientation unknown.

### 3.3 What the headset emits today (`packages/protocol/src/episode.ts:94-107`)

- **`objects.ndjson`:** `{t, objects:[{id, position, orientation|null, confidence, source}]}`. A line is written only when an estimate changes, except that a held object gets one line per XR frame.
- **Layout objects:** they ignore detector answers until first carried (`object-registry.ts:107`).
- **`marker`:** never occurs, because no marker tracker exists, so real orientations are null.
- **Not recorded:**
  - `heldBy` (dropped in `drainChanges`, `object-registry.ts:168-183`);
  - grasp and release, including fist grasps;
  - tracking loss of a held object;
  - detector capture time, which can be recovered only as `t − latencyMs` from `object.detected`.
- **Consequence:** before P1, objects never show a tracking-lost gap. The lanes say so; they don't make one up.

### 3.4 Proposed optional extension (needs approval; the schema id stays the same)

```ts
export const LOCATION_FLAG = { orientationValid: 1, positionValid: 2, orientationTracked: 4, positionTracked: 8 } as const;
export const LocationFlagsSchema = z.number().int().min(0).max(15);
// ObjectStateSchema adds:
locationFlags: LocationFlagsSchema.optional(),   // absent = legacy: derive from source
heldBy: HandednessSchema.nullable().optional(),
observedT: z.number().optional(),                // ms; omitted within 1 ms of t; may be < 0
// EpisodeEventSchema adds:
event('object.grasped',  { objectId: z.string(), hand: HandednessSchema, grip: z.enum(['pinch','fist']), position: Vec3Schema })
event('object.released', { objectId: z.string(), hand: HandednessSchema, reason: z.enum(['opened','hand_lost','plan_changed']), position: Vec3Schema })
// EpisodeMetaSchema adds:
features: z.array(z.string()).optional()         // "object.flags", "object.grasp"
```

**Rules,** enforced by a protocol test:
- Without positionValid, `position` still holds the last valid estimate, because the pipeline reads it (`episode.py:211-219`).
- A tracked bit requires its valid bit.
- `orientation` is non-null only when orientationValid is set.

**Who sets what:**

| Field or event    | Emitter                                                                                                                                                                                         |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `locationFlags`   | `ObjectRegistry.drainChanges`. Layout, pinch registration or manual = 2; detector = 10; marker = 15 with orientation, 10 without; held with the wrist tracked = 2; held with the wrist lost = 0 |
| `heldBy`          | `drainChanges`, from `ObjectEstimate.heldBy`                                                                                                                                                    |
| `observedT`       | `drainChanges` (`est.t`), then rebased by `quantizeObject` (`quantize.ts:47-60`), which must copy the new fields                                                                                |
| `object.grasped`  | `ObjectRegistry.attach(grip)`, from `GraspTracker` (`holding.ts:41-48` pinch, `:66` fist)                                                                                                       |
| `object.released` | `detach(reason)`.`hand_lost` comes from a new optional `dropout?: true` on `PinchTransition`; `plan_changed` from `load`                                                                        |
| `features`        | `LessonController.episodeMeta` (`lesson-controller.ts:483-511`)                                                                                                                                 |
| Stale-answer fix  | `ObjectRegistry.observe` drops an observation when `obs.t < est.t`                                                                                                                              |

**Same change:**
- Run `pnpm gen:schema`. `object-track.schema.json` has `additionalProperties:false`, and the pipeline validates against it.
- Fix the "typically 5–30 Hz" text (`episode.ts:107`, `docs/data-format.md:93`).

**Adapter (P3):**
- Flags come from `locationFlags`.
- `heldBy` sets `runtime_estimate` and `clio-grip`.
- `object.grasped`/`released` become held spans and events with **`origin: 'runtime'`**. Pinch inference stays `'inferred'` and runs only when `features` lacks `object.grasp`.
- `t_us = observedT ?? t`.
- `tracking_lost` and `tracking_recovered` come from changes in the positionValid bit.
- The lanes label each span "recorded" or "inferred from pinch".

**Compatibility:**
- Old episodes stay valid.
- A server still on the old protocol drops the new fields and returns 400 for the new events. The uploader drops about 1 s of frames per rejected batch. Restart the server whenever the headset changes.

## 4. Reuse, fix order, viewer.html, deferred work

**Reuse:**

| As is                                                                                                                                                                                                                                 | After H1                                                                                                        | Pattern only                                                                                                                                    | Not used                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `capture/model.ts`, `capture/from-package.ts` (later a file-picker input), `event-log.ts`, `detection-outline.ts` and its dependencies, the server `?from=` routes and tests (`routes/episodes.ts:79-89`, `episode-store.ts:239-250`) | `from-clio.ts`, `api.ts` (`NdjsonTail` plus `allSettled`-safe reads already in place), the new `clio-events.ts` | `object-tracks-view.ts` (trail, held ring, `lanes()`), `main.ts` follow logic (500 ms poll, 2 s list poll, 15 s growth), `scene.ts`, `panel.ts` | the `EpisodeData` class, as a second full frame model |

**Fix order:**
1. Your answers to decisions 0 and 2.
2. In parallel: T0 (visualizer checks and plumbing; `tsconfig.test.json` type-checks zero test files and its `lib` is ES2020) and H1 (section 3.2).
3. Everything else, as scheduled in section 5.

**Deferred, explicitly:**
- **Media** (GOALS step 3, `INTEGRATION.md:38`): the headset records none today. `putMedia` (`apps/headset/src/adapters/net/api-client.ts:117`) has no caller, nothing emits `media.started`, and the server has no GET media route. A later task M1 would add a GET route with range support and a media track on the timeline.
- **Others:**
  - a Capture v1 export CLI;
  - asset sidecars beyond the SceneEditor relabel (GOALS item 4);
  - the SSE feed;
  - reloading frame windows around the playhead for episodes over the 128 MB cap.

**viewer.html:** freeze its features. After check C passes, either:
- retire it: delete `viewer.html`, `src/viewer/{main,scene,panel}.ts` and the `viewer` entry at `apps/headset/vite.config.ts:45`; or
- keep it as is.

The pure modules stay either way.

## 5. Work breakdown

UI tasks (T3, T4, T5, T7) load the `awesome-design-md` and `impeccable` skills and follow `visualizer/DESIGN.md` as updated by D0. No `·`, no arrow characters, solid fills, no outlined buttons, no gradients.

**Checks:**
- **Root `pnpm check`** = `biome check .`, then `pnpm -r typecheck` (strict, `noUncheckedIndexedAccess`, `noUnusedLocals`), then `vitest run`.
- **Visualizer check** = `pnpm visualizer:check`.

Every task preserves uncommitted work, including `apps/headset/src/tracking/` and the episode-server changes.

**Gate 0 (you):** decision 0 (commit the reviewed work first) and decision 2 (shared code). Decision 1 gates only P1 to P3.

### Wave 0 (parallel, disjoint files)

**T0, visualizer plumbing.**
- Owns: `visualizer/{tsconfig.json,tsconfig.test.json,next.config.ts,eslint.config.mjs}`, `src/lib/clio/types.ts`, `src/lib/clio/__fixtures__/synthetic-episode.ts`, `src/lib/clio/__tests__/{import-smoke,import-graph}.test.ts`, and fixes to existing tests that the type-check exposes.
- Accept:
  - The visualizer check is green.
  - `tsc -p tsconfig.test.json --listFilesOnly` lists the `__tests__` files.
  - The smoke test builds a Capture from shirt-fold: 337 headset samples, both hand series, an entity for each of the 4 `meta.objects` ids. It does not assert which objects are drawn.
  - The smoke test also checks that the median right-wrist ROS y is below the left (not mirrored). If that fails, investigate before wave 1.
  - The import-graph test fails when `capture/index.ts` is added to the allowed list.
  - `pnpm visualizer:build` compiles a page importing `@clio-viewer/capture/from-clio`.

**H1, model and adapter (section 3.2).**
- Owns: `apps/headset/src/viewer/capture/{model,from-clio,clio-events,object-tracks-view}.ts`, `apps/headset/src/viewer/api.ts`, `apps/headset/test/viewer/capture/*`, `apps/headset/test/viewer/api.test.ts`.
- Accept: root `pnpm check` is green, with new tests for:
  - point/region and hidden objects are never grasped;
  - held spans equal the old `heldAt` on shirt-fold;
  - a frame-rate pinch run without a pinch event makes an inferred span;
  - registration, carry and release samples get `manual`, `runtime_estimate` and `runtime_estimate`;
  - confidence is null for layout, pinch and held samples;
  - feeding the same batch twice changes no counts;
  - the `wFromRos` round trip;
  - `headWAt` equals the frame head in W;
  - `stepAt` and `detectionsFor` on shirt-fold;
  - `pinch_m` is kept;
  - a `meta.hands` mismatch throws;
  - reverse seek with a null rotation;
  - `NdjsonTail` with `from` and `skipFirstLine`.

**D0, design rules.**
- Owns: `visualizer/DESIGN.md`. Adds a "Clio episode viewer" section: lane styling (measured vs derived vs inferred), held ring, unknown orientation, live/stopped/finished colors (citrus for live), approximate outlines, no ids in headers.
- Accept: the visualizer check's prettier step passes, it is reviewed against the global UI rules, and it is merged before wave 1.

**V, server.**
- Owns: `apps/server/src/storage/{files,episode-store}.ts`, `apps/server/test/episodes.test.ts`, `packages/protocol/src/api.ts` (only the optional `batches` field).
- Does V1 (incremental counts) and V2 (batch integrity).
- Adds the missing `?from=` tests: events and objects channels, multibyte UTF-8, a shrunk file, a trailing partial line.
- Accept: root `pnpm check` is green; listing a growing file reads only the new bytes (test with a spy); detail shows `batches` for shirt-fold (12 received, no gaps).

**L1, live replay script.**
- Owns: `apps/headset/scripts/replay-live.ts`, `apps/headset/test/scripts/replay-live.test.ts`.
- Usage: `tsx scripts/replay-live.ts --from <episode dir> [--base http://127.0.0.1:5173] [--speed 1] [--batch-ms 1000] [--repeat-minutes N] [--stall-after-s S] [--no-finish]`.
- What it does:
  1. POSTs `/api/episodes` with the meta (`EpisodeCreateSchema`).
  2. POSTs batches cut like the recorder (90 frames or 1000 ms), paced by `t/speed`.
  3. Repeats with a time offset to make long sessions.
  4. POSTs finish unless stalled.

  Run it only against a server with a scratch `CLIO_DATA_DIR`.
- Accept: root `pnpm check` is green; a test of the pure batching function (seq order, cut rule, repeat offsets); one run against a scratch server produces an episode whose line counts equal the source.

**F1, moving-object fixture.**
- Owns: a `--scenario ph-syringe` path in `apps/headset/scripts/synth-episode.ts` and `fixtures/episodes/synthetic-ph-syringe/`. The syringe is a layout-placed `tool` in `procedures/ph-indicator.json`.
- Scenario: grasp, carry, a hand dropout over 150 ms, release, then a re-locate detection, through the real `GraspTracker` and recorder.
- Accept:
  - root `pnpm check` is green;
  - `pnpm synth` leaves shirt-fold byte-identical (`git diff --exit-code fixtures/episodes/synthetic-shirt-fold`);
  - the new episode passes protocol parsing and pipeline validation, and contains a per-frame `source:'pinch'` run.

### Wave 1 (after T0, H1 and D0; parallel)

**T1, proxy.**
- Owns: `src/app/api/clio/[...path]/route.ts`, `src/lib/clio/proxy-rules.ts`, `src/lib/clio/__tests__/proxy-rules.test.ts`.
- Accept:
  - Bun tests reject: POST and PUT; `gemini/...`, `coach/token`, `plans`; raw and encoded `..`; bad ids; a non-digit `from`; a non-loopback Host; a non-loopback `CLIO_SERVER_URL`.
  - `curl -i 127.0.0.1:3001/api/clio/episodes/<id>/frames?from=0` returns the same bytes and `x-next-from` as 8787.

**T2, source and clock.**
- Owns: `src/lib/clio/{source,live-clock}.ts`, `src/lib/clio/__tests__/{source,live-clock}.test.ts`.
- Accept, with mocked fetch:
  - Offsets come only from `x-next-from`.
  - Frames are read before events and objects, and applied as frames, events, objects.
  - A failed channel keeps its offset while the others keep their records.
  - A shrink resets and rebuilds; a 404 goes back to the list; backoff runs from 0.5 to 5 s.
  - Finish triggers one final read; growth within 15 s means live, otherwise stopped.
  - `/clio/live` switches to a newer episode, a pinned one never does.
  - The revision bumps only on new records.
  - Repeated bytes after a simulated restart add no samples.
- **Join-at-tail:** for a mocked 50 MB live frames file, the first request is `?from=9007199254740991`, the next is `?from=<end−2097152>` with `skipFirstLine`, and no corrupt lines are counted. Events and objects still read from 0.
- **Retention:** a generated 10-minute stream at 90 Hz keeps at most 2×90×300 hand samples and all head samples, and `handsKeptFromUs` is reported. A finished episode loads in full up to 128 MB of frames; beyond that it stops there and reports "not loaded".
- **Ingest cost:** one second of frames takes under 20 ms (generous bound).
- **Clock:**
  - it never passes the edge, lags by 1.5 s and snaps forward past a 3 s backlog;
  - a skewed fake `performance.now` leaves every Capture `t_us` unchanged (arrival time never reaches sample times).

**T3, scene.**
- Owns: `src/lib/clio/{object-display,detection-geometry}.ts` and their tests, `src/components/clio/clio-scene.tsx`, `layers/{environment,hands,head,objects,detections}.tsx`, `src/app/clio/dev/scene/page.tsx`.
- Accept:
  - Tests: reverse seek returns the earlier state; a null rotation means `orientationKnown: false`; trails have no samples after t; hidden entities are skipped.
  - A floor test: with a `worldFromWorkspace` y of 0.75 and no rotation, the floor sits at ROS z = −0.75.
  - Outline points are converted once (they match `rosFromW` of the W output).
  - There is exactly one `ROS_TO_RENDER` group, at scale 1.
  - 1000 random seeks over 20 objects on a 10-minute capture average under 1 ms.
  - Visual check on the harness page with the generated fixture.

**T4, panels.**
- Owns: `src/lib/clio/lanes.ts` and its test, `src/components/clio/{object-lanes,object-inspector,event-list,step-banner,clio-playback-bar}.tsx`, `src/app/clio/dev/lanes/page.tsx`.
- Accept, in tests:
  - Sparse series line up on one axis for the whole episode.
  - Detector answers span `observedUs` to `availableUs`, and misses are their own marks.
  - Held spans carry their `origin`: inferred today; `runtime` once P3 lands.
  - Derived staleness is labeled; "hands not kept" and "not loaded" spans render.
  - The inspector hides confidence when it is null.
- Visual check on the harness page: sub-second time and the step instruction.

**T7, SceneEditor Clio variant.**
- Owns: `src/components/scene-workspace.tsx`.
- Accept: the visualizer check is green; the default variant is unchanged on the G1 demo (visual check); the Clio variant shows no "Robot root" and none of the replaced text.

### Wave 2 (after wave 1)

**T5, integration.**
- Owns: `src/components/clio/{clio-replay-viewer,clio-clock}.tsx`, `src/app/clio/{page,live/page,[episodeId]/page}.tsx`, the link in `src/app/page.tsx`.
- Accept: checks A, B and S1 to S6 below.

### Wave 3

**D1, docs** (after T5).
- Owns: `visualizer/{INTEGRATION,GOALS,AGENTS,PRODUCT}.md`.
- Records: the proxy, the routes, the import rules and alias target (decision 2), the root `pnpm install` requirement, the three.js guard, the quaternion-convention difference and the test type-check fix.
- Accept: the visualizer check passes; every path and command named exists.

**Gate C, live Quest session.**
- Owner: T5's agent, with Peter wearing the headset.
- Required before calling the viewer done or retiring `viewer.html`.

### Protocol track (only if decision 1 is yes)

- **P1** (after H1): `packages/protocol/src/episode.ts`, regenerated `packages/protocol/schema/*`, protocol tests, `docs/data-format.md`.
- **P2** (after P1):
  - Owns: `apps/headset/src/domain/world/{object-registry,holding}.ts`, `domain/hands/pinch-detector.ts`, `domain/recording/quantize.ts`, `domain/session/lesson-controller.ts`, their tests.
  - Regenerates both fixtures (`pnpm synth` and the ph-syringe scenario) and reviews the diffs.
  - Keeps `DEFAULT_PINCH` and `PinchThresholds` unchanged; `src/tracking/pinch-latch.ts:1` imports them.
- **P3** (after P2): `capture/from-clio.ts` and its tests.
- Accept:
  - root `pnpm check` is green, including `apps/headset/test/tracking`;
  - pipeline validation passes on old and new episodes;
  - on the ph-syringe replay, held spans show "recorded" (`origin: 'runtime'`) and a flags-0 gap appears during the dropout.

### End-to-end checks

Setup for A, B and S: run a server with a scratch `CLIO_DATA_DIR`, Vite, and `pnpm visualizer:dev`.
- **A. Synthetic replay:** copy both fixtures into the scratch data dir and open `/clio/<id>`.
  - Scrub both ways: no later poses leak; hands vanish when untracked; the hidden region is not drawn; hands sit on the table plane and are not mirrored.
  - ph-syringe: a trail, a held ring, an inferred held span, and a detector answer with latency.
- **B. Recorded episode** `data/episodes/ep-20261024-065830-ht6h`: plays all 574 frames with a head trail; status is stopped (no `finish.json`); the batch count comes from V.
- **S1, live simulation:** open `/clio/live`, then run L1 with ph-syringe through `:5173`. The episode appears within 2 s of creation, the lag readout's Behind edge shows 1.5 ± 0.3 s, and the held ring follows the carry. After finish it shows finished and complete.
- **S2, server restart:** restart the server mid-stream. The page shows reconnecting and resumes; `duplicates` stays at 0. After finish, the headset sample count equals the `frames.ndjson` line count.
- **S3, stall:** with `--stall-after-s 20 --no-finish`, the episode shows stopped 15 s after growth stops.
- **S4, long session:** a 10-minute run at 90 Hz (`pnpm synth -- --hz 90 --out <scratch>`, then L1 `--repeat-minutes 10`). Targets, measured in Chrome:
  - no long task over 200 ms after the first load;
  - `performance.memory.usedJSHeapSize` under 400 MB at the end;
  - after following several recordings, one Capture alive after a forced GC. Measure this on a production build (`NEXT_DIST_DIR=.next-e2e`): in a dev build React Refresh keeps the unmounted drei `<Html>` roots, and through their labels the earlier captures;
  - 30 fps or more while following.
- **S5, joining late:** open `/clio/live` 8 minutes into S4. At most about 3 MB of frames download before the live edge shows, and earlier time is shaded "not loaded". Events and objects are still read from byte 0, since the event list and object lanes cover the whole episode: measured 4.5 MB of objects and 0.3 MB of events at 8 minutes. Tail-joining them is left for later.
- **S6, pinning:** pin in one tab and start a second L1 run. The pinned tab stays put while a `/clio/live` tab switches.
- **C. Live Quest:**
  - Setup: accept USB debugging, run `pnpm quest:reverse`, confirm with `adb reverse --list`, open `/clio/live`, then run a pH lesson of about 10 minutes.
  - Accept: the episode is found within 2 s; lag 1.5 ± 0.3 s; the arrival-age average is recorded (approximate); the syringe moves with the hand; finish shows finished with 0 missing batches; a server restart mid-recording causes no duplicates; S4's performance targets hold.
  - Observe and record, not pass/fail: whether replugging the cable ends the XR session.

## 6. Risks and open questions

### Decisions for you

0. **Commit first:** commit the reviewed viewer and server work before wave 0? H1, V and P2 edit files that are not committed yet.
1. **Protocol extension:** approve P1 to P3? Without them, held state stays inferred, fist carries are guessed from frame-rate pinch runs, and objects never show tracking loss.
2. **Shared code** (blocks wave 0):
   - (1) Import from `apps/headset/src/viewer` (recommended now; needs the root `pnpm install`).
   - (2) Move the code to `packages/episode-model` now.
   - (3) Copy it into the visualizer (the copies will drift).
3. **`viewer.html`:** retire it or keep it after check C?
4. **CORS:** restrict `cors()` at `apps/server/src/app.ts:22` to the visualizer's origins, or remove it? Today any website open on the laptop can read recordings and mint coach tokens.
5. **Home page:** keep the G1 redirect as the default, or default to `/clio`?
6. **Latency:** accept about 2.3 s on screen, or set `batchIntervalMs: 250` (`clio-app.ts:104`; 4 POSTs per second) and/or build SSE now?
7. **Quaternion convention for exports:** the viewer's `B·R·Bᵀ` or the pipeline's `q_B ⊗ q_W` (`frames.py:100-103`)?
8. **Session-length limits in v1:** keep 5 minutes of hands while live, and a 128 MB cap (about 10 minutes) for full replay? Or build playhead windows now?

### Risks

- **Second three.js:** the lint rule catches only direct imports from visualizer files. The webpack alias and the import-graph test are the real guard.
- **Turbopack** cannot compile files outside `visualizer/`, so dev must stay on webpack.
- **Test type-checking** may surface existing visualizer test errors (T0's scope).
- **Stale server:** after a protocol change, a server on the old protocol drops fields or rejects batches until it is restarted.
- **Cable replug:** it can reload the headset page through Vite HMR (ends the XR session, loses the in-memory upload queue) and needs `pnpm quest:reverse` again. Right now adb sees the Quest as `unauthorized`.
- **Inferred held spans** follow event arrival order and miss fist grasps that have no frame-rate run. They are labeled inferred until P3.
- **Sparse lanes:** objects rarely update unless held. That is real data, not a viewer bug.
- **Latency figures** are estimates until check C measures them.
- **`/clio` route** shadows the two-segment redirect for an HF org literally named "clio".

# Two lights on one thing: the part you work and what holds it

Design, not built. Written 2026-10-25. Local `main` moved while it was written (to 702cb4c); build
from `main` as it is when building starts, in a worktree, and leave the main checkout's
uncommitted work alone.

## Why

In the user's test-tube lesson (local plan
`data/plans/pour-the-blue-test-tube-into-the-white-test-tube-2-r1.json`), step 1 said "Unscrew the
orange cap of the test tube held in your left hand." Only the tube glowed. The user wants the cap
and the tube both lit, in different colors, so they can see at a glance which one their hand
turns and which one the other hand holds still. The pour step had the same gap: it lit the blue
tube and not the white tube it pours into.

Nothing in the tracker stopped the cap from glowing. The planner never declared it: since the
fridge-door trouble ([jev part findings], 2026-10-24) the planner prompt says "Whole things only"
and "One object at a time: never a second one, and never a part of it"
(`apps/server/src/services/plan-prompt.ts`, OBJECTS and SHOW). Two more things would have stopped
it if it had been declared:
- Lesson tracking (objects mode) has no part mode. A phrase naming a part is followed as whatever
  YOLOE proposes there (`tracker/TRACK.md`, end of objects mode), so the cap would likely land on
  the tube's track and the two glows would stack.
- The color table gives a part its parent's color (`apps/headset/DESIGN.md`, "Highlight colors";
  `roleAccent` in `apps/headset/src/domain/overlay/accents.ts`).

[jev part findings]: on the open mini fridge, jev asked directly found the door on 6 of 8 frames;
jev on the fridge first and then on a letterboxed crop of it found it on 4 of 8, because the
freezer compartment was inside the crop too.

## What the learner sees

1. **A part your hand works on, and what it is on, both glow, in different colors.** "Unscrew the
   orange cap": the cap is cyan (what you twist), the tube violet (what you hold steady).
2. **Where it goes glows too.** "Pour the blue liquid into the white tube": the blue tube cyan,
   the white tube yellow.
3. **At most one of each color at a time**: one cyan, one violet, one yellow. The existing rule
   (one cyan and one yellow) gains violet.
4. **Look-alike parts stay on their own whole.** With two orange-capped tubes in view, the white
   tube's cap glow never lands on the blue tube's cap.

## Goals, non-goals, anti-goals

Goals: the three learner-facing points above, in the desk lab and on the headset, for parts that
look unlike what they are on (an orange cap on a clear tube, a black knob on a white panel, a red
button on a grey box).

Non-goals:
- A general "hold" for anything the other hand holds when no part is worked (hold the beaker
  while stirring it). Violet appears only on the whole that a worked part belongs to.
- Lighting every object in view. Unlit objects are still followed for the recording, as today.
- Parts that look like their whole (a white fridge door on a white fridge). They stay named in
  words on the whole object, as today, until someone measures them working.
- Asking jev twice in a chain (the whole, then a crop of it for the part). Measured worse on the
  fridge, it doubles the wait for the part and adds calls to a jev that already runs about 6.5
  calls a second. The tracker ties the part to its whole instead (below).
- Any change to what a Gemini coach sees. The perception boundary (`docs/coach-plan.md`) stays:
  tracker results feed the learner's view and the recording only.
- A 3D model of its own for a removable part. The pipeline leaves a declared part out of the
  models when its whole is modelled (`pipeline/src/clio_pipeline/models/__init__.py`), so an
  unscrewed cap has a track but no model in the derived scene. Not a regression (caps are not
  declared today); a follow-up if the recordings need it (Claude's call).

Anti-goals (a failure even if it technically works):
- Glows that hop between the cap and the tube from frame to frame, or stack into one blob.
- The cap glow on the other tube's cap.
- A slower stage-1 card (`docs/handoff-stage1-speed.md`; measure with `pnpm bench`).
- Any change for lessons that declare no parts: the tracker must behave byte-identically when no
  object in the set names a `partOf`, and the headset must light exactly what it lights today.
  The jitter harness runs target mode only (`StreamTracker`), so the proof is two-part: the
  harness against a `--baseline` run (catches changes to the shared `part.py` and `tracking.py`),
  and objects-mode unit tests that a set without `partOf` gives the same sightings as before
  (Claude's call; an objects-mode replay in the harness is not needed).

## Constraints

- UI rules (the user's, all projects, and `apps/headset/DESIGN.md`): solid, saturated, opaque
  accents; no gradients, no tints, no outline stroke; the coach names a style, never a color.
- The tracker follows at most 8 objects. Parts count against that.
- jev takes only stream-sized images.
- Generated JSON Schemas (`packages/protocol/schema/`) come from `pnpm gen:schema`, never edited by
  hand.
- `tracker/` pins Ultralytics narrowly; nothing here should need a new model or dependency.
- Preserve the uncommitted work in the main checkout. Build in a worktree off local `main`.

## Decided with the user

- The held whole gets a color of its own. The user suggested green; green is already the fill
  line ("how far", `#3ddc84`), and the white tube you fill may also be the tube you hold, so
  **violet `#a970ff`** was picked instead (Claude's call; the user may still ask for green, in
  which case the fill line moves to another color).
- The destination is lit in the same step (the pour step lights both tubes).
- Scope is parts the hands work on, not every object in view.
- No chained jev crop; the tracker ties the part to its declared whole.

## The design

### 1. Colors

Add a row to the "Highlight colors" table in `apps/headset/DESIGN.md` and to `ACCENTS` in
`accents.ts`:

| Role | What the learner reads                                        | Accent           | Where it comes from                          |
| ---- | ------------------------------------------------------------- | ---------------- | -------------------------------------------- |
| Hold | what the other hand holds steady while a part of it is worked | violet `#a970ff` | the declared whole of the step's acting part |

Steady, full energy, like act and destination. The existing Part row (a spot drawn in its
parent's color) stays as it is; a worked part such as the cap is not that role, it is Act.

Glow modes stay (`glowModeFor`): the tube, a container, glows around itself; the cap, an item,
lights its surface. The tube's outline may include the cap's pixels. The cap must read clearly as
cyan on top of a violet tube in the headset; whether that needs the part's mask cut out of the
parent's glow is left to the builder (look at it in the gallery and the desk lab).

### 2. The plan

**Protocol** (`packages/protocol/src/procedure.ts`): `HighlightRoleSchema` gains `hold`. Then
`pnpm gen:schema`. `ObjectSpec.partOf` already exists and already reaches the derived data
(`pipeline/src/clio_pipeline/compile.py`). Its description ("the whole is followed and recorded
with it") is corrected to say a part is followed as a part of its whole and recorded as its own
object.

**Role inference** (`stepRole` in `accents.ts`, which every renderer uses): an explicit role still
wins; then what the step's action moves is act and its target destination, as today; then,
new: **the object the acting object is `partOf` is hold**. Everything else as today. The planner
does not have to write roles; the action and `partOf` decide them.

**Planner prompt** (`plan-prompt.ts`):
- OBJECTS, replacing "Whole things only": declare whole things; also declare a part as an object
  of its own, with `partOf` set to its whole's id, when the step's hands work on it directly and
  it looks unlike the thing it is on (another color or material). Removable parts (caps, lids)
  count. A part that looks like its whole (the mini fridge's door, handle, shelf) stays named in
  words on the whole, as today. Each look-alike tube gets its own cap object.
- ACTION: when the hands work a part, the part is the action's object (twist the cap), and its
  whole is in `targets`.
- SHOW, replacing "One object at a time": up to three items, never two in one role: what the
  hands act on; when that is a part, its whole; and where it goes, when the step moves something
  somewhere. A step with nothing to point at still shows none.
- The planner test `no longer asks for parts as objects or for several outlines per step`
  (`apps/server/test/gemini-planner.test.ts`) guards exactly the old rule. Replace it with tests
  for the new one; don't just delete it.

**Plan schemas** (`apps/server/src/services/plan-schema.ts`): `show` max 1 becomes max 3 in both
the full step and the stage-1 card step. The card's object (`cardObject`) gains an optional
`partOf`: in the test-tube lesson the cap is step 1, which plays from the card before stage rest
arrives. Stage rest already writes `partOf` on the full object.

Plan building (`plan-build.ts`) drops a `partOf` that names an undeclared object, the object
itself, or another part (one level only) before validation: `procedure.ts` refuses the whole plan
for an unknown or self parent, and a planner retry costs seconds (Claude's call).

### 3. The headset

`LiveTracking` (`apps/headset/src/domain/session/live-tracking.ts`) and the desk lab's
`desk-tracker.ts` send each object's `partOf` in the `objects` message when its parent is in the
same set; otherwise the part goes without it and is followed as a whole, as today.
`TrackedQuery` in `adapters/net/tracker-client.ts` gains the optional field. Accents come out of
`stepRole` as now, so the live lights and the fallback outlines agree without further change.

### 4. The tracker, objects mode

- `objects` message: each object may carry `"partOf": "<id of another object in the set>"`.
  Unknown, self or chained ids are logged and ignored (the object is followed as a whole).
  Document it in `tracker/TRACK.md` and remove "There is no part mode here".
- An object with `partOf` is followed as a part (`part.py`'s `PartTracker`): jev boxes the part
  on the full frame, the part rides on its parent's motion, and the segmenter cuts and follows the
  part's own outline. Its parent is the declared object's track in the same set, not one found by
  `find_parent`. How `PartTracker` shares that track (or keeps its own follower of it) is the
  builder's call.
- A removable part leaves its whole: once the cap is in the hand, jev's box for it is off the
  tube. The part is then followed on its own pixels, which `PartTracker` already does with a
  segmenter; it must not be pulled back onto the tube.
- Look-alike guard: a jev answer for the part whose box lies on another followed object and not
  on its own parent is ignored, the way a disagreeing jev answer is ignored after an anchor. That
  is what keeps the white tube's cap off the blue tube's.
- jev is asked about the cap like any object: one more object, no chained calls.
- Robotics-ER 2's anchors for a part take the same part path and the same look-alike guard as
  jev's answers. Today an anchor goes through the whole-object path (`_apply_anchors` in
  `session.py` calls the object tracker's `identified`), which would put the cap on the tube's
  track. The action focus anchors every followed object every 5 s and an anchor outranks jev for
  6 s, so for a small cap ER may do most of the placing (Claude's call).

### 5. Measure before building the tracker part

Before the tracker work, check that a small cap can be found at all at stream size. No clean
frames of this scene exist: the test-tube episodes hold poses only, and the jev dump draws boxes
onto its frames (no model may be fed those). So the first step of the build needs the user at
the laptop camera (desk lab) or in the headset with the two capped tubes, held. Capture clean
frames at the stream size, then ask jev and Robotics-ER 2 (`/api/vision/focus`, as the action
focus does) for "the orange cap of the tube with white powder" and the blue tube's cap, and count
right cap, wrong cap, whole tube, nothing, for each.

It passes when jev or ER puts the right cap there reliably and neither puts it on the other tube
(ER alone can carry the cap, since its anchors outrank jev). If both mostly miss the cap at stream
size, stop and bring the numbers to the user before choosing between a larger frame and a crop.
Docs say ER found handles, caps and spouts 7 of 7 times when pointing at them
(`docs/robotics-er.md`); that was not at stream size.

Order (Claude's call): the measurement first, then the protocol, colors, planner and headset, then
the tracker. All of it lands together on one branch: the planner change alone would make the
cap glow stack on the tube's, the anti-goal.

## Done when

- The test-tube lesson, planned fresh in the desk lab: the plan declares both caps with `partOf`
  their tubes; step 1 shows the cap cyan and the tube violet; the pour step shows the blue tube
  cyan and the white tube yellow; the cap glow stays on its own tube with both tubes in view.
- The same on the headset.
- `pnpm check`, the tracker's tests (`tracker/tests/test_part.py`, `test_tracking.py`), the jitter
  harness identical to its `--baseline`, and the objects-mode no-`partOf` tests.
- `pnpm bench`: stage-1 time no worse than before the prompt change on the saved scenarios
  (`docs/planner-bench.md`). Those are fridge scenes with no part that looks unlike its whole, so
  they show the new prompt costs nothing when no part is declared. Once the measurement's frames
  exist, save a test-tube scenario and report its stage-1 time; a card with an extra object and
  show item is slower by construction, so that number is reported, not gated (Claude's call).
- Docs: the color table in `apps/headset/DESIGN.md`, objects mode in `tracker/TRACK.md`, the
  show rule in `docs/coach-plan.md` (its "show one object per step" sentence) and the parts note
  in `docs/handoff-stage1-speed.md`.

## Left to the builder

- The exact violet, after seeing it over passthrough: saturated, opaque, and clearly unlike cyan,
  yellow, green, red and the coach's white.
- Whether the part's mask is cut out of its parent's glow.
- How `PartTracker` shares its declared parent's track.
- The planner prompt's exact words, as long as the bench stays neutral.
- A jitter-harness scene for a part on a moving whole (a cap on a lifted tube), if one can be made
  from photos like the existing part scenes.

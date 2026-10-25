# Part and Holder Highlights Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a step's hands work a part (unscrew a test tube's cap), the part glows cyan and the whole it sits on glows violet, the destination of a pour glows yellow in the same step, and each look-alike cap's glow stays on its own tube.

**Architecture:** The plan declares the part as an object with `partOf` its whole and may show up to three items. The headset infers a new `hold` role for the whole of the acting part and colors it violet. It also tells the tracker which followed whole each part belongs to. In objects mode the tracker follows such an object with `PartTracker`, riding on the declared whole's track instead of one it finds itself. jev and Robotics-ER 2 boxes for a part that land on another whole are ignored.

**Tech Stack:** TypeScript (pnpm workspace, Vitest, Biome, Zod) for `packages/protocol`, `apps/server`, `apps/headset`; Python 3 (uv, pytest, ruff, numpy, YOLOE-26 + ByteTrack, SAM 2.1) for `tracker/`.

**Spec:** `docs/superpowers/specs/2026-10-25-part-and-holder-highlights-design.md`

## Global Constraints

- Accents: act cyan `#24d4ed`, destination yellow `#ffd23f`, level green `#3ddc84`, **hold violet `#a970ff`**. Solid, saturated, opaque; no gradients, no tints, no outline stroke. The coach names a style, never a color.
- At most one cyan, one violet and one yellow at a time.
- Lessons that declare no parts are unchanged. The tracker behaves byte-identically when no object in the set names a `partOf`. The headset lights exactly what it lights today. The `objects` message JSON is unchanged when no object has a followed whole.
- Perception boundary: nothing the tracker sees reaches a Gemini coach.
- The tracker follows at most 8 objects; parts count.
- jev gets only stream-sized frames (480x360 JPEGs).
- `packages/protocol/schema/*.json` come from `pnpm gen:schema`, never hand edits.
- No new dependencies; the Ultralytics pin stays.
- Build in a worktree off local `main` as it is when building starts. Leave the main checkout's uncommitted work alone. In `apps/headset/DESIGN.md` and `docs/coach-plan.md`, which have uncommitted edits in the main checkout, change only the passages named here.
- No `·`, `•` or arrow symbols in any UI text.
- Every commit ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Checks: `pnpm check` (Biome, typecheck, Vitest); `pnpm tracker:test`; `cd tracker && uv run ruff check src tests`.

## Review Focus

- **ER names the held whole as the next thing to touch** while the cap is the act. The tube stays violet; nothing gets a second cyan. (Task 3.)
- **The coach's `attention` hint on the held tube** shows white for 5 s, then goes back to violet, not to cyan or yellow. (Task 3.)
- **A plan revision re-sends the same objects set mid-step** (stage rest arriving). The cap keeps its `PartTracker` and its track; it is not started over. (Task 9.)
- **The whole drops out of the set** (more than 8 objects, or a revision drops it). The part is sent without `partOf` and starts over as a whole object, with no crash and no stale reference to the dropped whole. (Tasks 4 and 9.)
- **An old saved plan** (one show item, no `partOf`, roles left out) lights the same objects in the same colors, and the `objects` message has the same JSON as before. (Task 4.)

---

### Task 1: Clean stream frames, and the cap measurement (gate)

This task needs the user at the laptop camera (desk lab) or in the headset, holding the two capped test tubes. **If the gate in Step 6 fails, stop the plan and bring the numbers to the user.**

**Files:**
- Modify: `tracker/src/clio_tracker/dump.py` (module docstring and `JevDump.write`)
- Test: `tracker/tests/test_identify.py::test_jev_dump_writes_frame_and_questions`
- Modify: `docs/superpowers/specs/2026-10-25-part-and-holder-highlights-design.md` (append `## Measured`)

**Interfaces:**
- Produces: each jev call in a dump leaves `<stem>-raw.jpg` (the JPEG bytes exactly as jev got them) beside `<stem>.jpg` (boxes drawn) and `<stem>.json`.

- [ ] **Step 1: Make the worktree and bring the spec and this plan into it.** Create the worktree with superpowers:using-git-worktrees off local `main`. Copy the spec and this plan from the main checkout (both untracked there), then commit them: `git add docs/superpowers && git commit -m "docs: part and holder highlights design and plan"`.

- [ ] **Step 2: Change the dump test to expect the raw frame.**

```python
    files = sorted(p.name for p in (tmp_path / "dump").iterdir())
    assert len(files) == 3
    raw = next(n for n in files if n.endswith("-raw.jpg"))
    assert (tmp_path / "dump" / raw).read_bytes() == buf.getvalue()
    assert any(n.endswith(".jpg") and not n.endswith("-raw.jpg") for n in files)
    record = json.loads((tmp_path / "dump" / next(n for n in files if n.endswith(".json"))).read_text())
```

- [ ] **Step 3: Run it to see it fail.** Run `cd tracker && uv run pytest -q tests/test_identify.py::test_jev_dump_writes_frame_and_questions`. Expected: FAIL, `assert 2 == 3`.

- [ ] **Step 4: Make `JevDump.write` also write `self.folder / f"{stem}-raw.jpg"` with the `jpeg` bytes unchanged.** Update the docstring: the raw frame is the clean one, and it is the only file any model may be fed. Rerun Step 3; expected PASS. Commit with the message `feat(tracker): the jev dump keeps each frame as jev saw it`.

- [ ] **Step 5: Capture and measure (with the user).**
  1. Start the tracker: `CLIO_TRACKER_JEV_DUMP=data/jev-dump/caps pnpm tracker`, plus `pnpm dev`.
  2. Run the existing test-tube lesson in the desk lab (`apps/headset/desk.html`, `docs/dev-setup.md`) or on the headset for about 60 s. Both capped tubes stay in view: one held in the left hand, near and far, and some frames with the two tubes close together.
  3. Pick 12 `-raw.jpg` frames spread over the run, with both caps visible.
  4. Write a throwaway script in the session scratchpad (not committed). For each frame:
     - Ask jev, built as `cli.py`'s `_identifier(settings, None)` builds it, with `Query("powder_cap", "The orange screw cap on top of the clear test tube with white powder", "orange screw cap")` and `Query("blue_cap", "The orange screw cap on top of the test tube with blue liquid", "orange screw cap")`. Use the views to add where each tube is.
     - POST the same frame to `http://localhost:8787/api/vision/focus` as `FocusRequestSchema` (`packages/protocol/src/api.ts`): step instruction `Unscrew the orange cap of the test tube held in your left hand.`, with the same two objects (`label` and `query` from above).
     - Draw each finder's box onto a review copy. Never feed review copies to a model.
  5. Judge every box as one of: right cap, wrong cap (the other tube's), whole tube, nothing.

- [ ] **Step 6: Record the result and apply the gate.** Append `## Measured (<date>)` to the spec: a table of finder × cap × the four counts, and one line saying the ER frames were stream-sized (live, ER gets a sharper ~1024 px frame). **Pass:** for each cap, jev or ER puts the right cap on at least 10 of 12 frames, and neither finder puts it on the other tube's cap on more than 1 of 12 frames. On fail, stop here. Commit with the message `docs: measured jev and ER on test tube caps`.

---

### Task 2: Protocol: the `hold` role

**Files:**
- Modify: `packages/protocol/src/procedure.ts` (`HighlightRoleSchema`, `ObjectSpecSchema.partOf` description)
- Regenerate: `packages/protocol/schema/*.json`
- Test: `packages/protocol/test/procedure-parts.test.ts`

**Interfaces:**
- Produces: `HighlightRole = 'act' | 'destination' | 'part' | 'level' | 'hold'` (`hold` appended last).

- [ ] **Step 1: Write the failing test** in `procedure-parts.test.ts`:

```ts
it('lets a step light the whole that a worked part belongs to as held', () => {
  const tube = { ...caliper, id: 'tube', label: 'test tube', kind: 'container' };
  const cap = { ...scale, id: 'cap', label: 'orange cap', partOf: 'tube' };
  const p = plan([tube, cap], 'cap');
  const step = {
    ...p.steps[0],
    show: [
      { object: 'cap', phrase: 'orange screw cap', description: 'The orange cap on the tube' },
      { object: 'tube', phrase: 'clear test tube', description: 'The tube', role: 'hold' },
    ],
  };
  const parsed = parseProcedure({ ...p, steps: [step] });
  expect(parsed.steps[0]?.show.map((s) => s.role)).toEqual([undefined, 'hold']);
});
```

- [ ] **Step 2: Run it.** Run `pnpm vitest run packages/protocol/test/procedure-parts.test.ts`. Expected: FAIL (invalid enum value `hold`).

- [ ] **Step 3: Add `hold` to `HighlightRoleSchema`.** Describe it as `hold (what the other hand holds steady while a part of it is worked)`. Change the `partOf` description to: `The declared object this one is a component or a bounded area of (a vernier scale of a caliper, the cap of a tube); it is followed as a part of that whole and recorded as an object of its own`.

- [ ] **Step 4: Regenerate and run.** Run `pnpm gen:schema && pnpm vitest run packages/protocol`. Expected: PASS, including `json-schema.test.ts`. Commit with the message `feat(protocol): a hold role for the whole a worked part belongs to`.

---

### Task 3: The headset colors the held whole violet

**Files:**
- Modify: `apps/headset/src/domain/overlay/accents.ts`
- Modify: `apps/headset/src/domain/session/live-tracking.ts:204-245` (`rebuild`)
- Modify: `apps/headset/src/domain/session/spotlight.ts:205`
- Modify: `apps/headset/DESIGN.md` ("Highlight colors" table and its Rules paragraph only)
- Test: `apps/headset/test/domain/overlay.test.ts` (`describe('stepRole')`), `apps/headset/test/domain/live-tracking.test.ts`, `apps/headset/test/domain/spotlight.test.ts`

**Interfaces:**
- Consumes: `HighlightRole` with `hold` (Task 2).
- Produces:
  - `ACCENTS.hold = 0xa970ff`
  - `roleAccent('hold', previous) === ACCENTS.hold`
  - `actWhole(step: Pick<Step, 'action'> | null | undefined, spec: (id: string) => Pick<ObjectSpec, 'partOf'> | undefined): string | undefined`: the `partOf` of what the step's action moves.
  - `stepRole(step, object, rank, kind, role?, whole?: string): HighlightRole`, where `whole` is `actWhole(...)`'s answer for the step. The order is: an explicit role; then `action.object` is act; then `action.target` is destination; then **`object === whole` is hold**; then `inferRole`.

- [ ] **Step 1: Write the failing `stepRole` tests** in `overlay.test.ts`:

```ts
it('holds the whole of the part the hands work, after an explicit role and the action', () => {
  const unscrew = { action: { verb: 'twist' as const, object: 'cap', hand: 'either' as const } };
  expect(stepRole(unscrew, 'tube', 1, 'container', undefined, 'tube')).toBe('hold');
  expect(stepRole(unscrew, 'cap', 0, 'item', undefined, 'tube')).toBe('act');
  expect(stepRole(unscrew, 'tube', 1, 'container', 'destination', 'tube')).toBe('destination');
  expect(stepRole(unscrew, 'tube', 1, 'container')).toBe('destination');
  expect(roleAccent('hold', null)).toBe(ACCENTS.hold);
  expect(ACCENTS.hold).toBe(0xa970ff);
  const specs: Record<string, { partOf?: string }> = { cap: { partOf: 'tube' }, tube: {} };
  expect(actWhole(unscrew, (id) => specs[id])).toBe('tube');
  expect(actWhole({}, (id) => specs[id])).toBeUndefined();
});
```

- [ ] **Step 2: Write the failing lesson test** in `live-tracking.test.ts`: `it('lights a worked cap cyan and its tube violet, and a pour's two tubes cyan and yellow')`. Use a plan with `tube` (container), `cap` (`partOf: 'tube'`), `blue_tube` (container) and steps:
  - `open`: action `{ verb: 'twist', object: 'cap', hand: 'either' }`, show `[cap, tube]`, no roles.
  - `pour`: action `{ verb: 'pour', object: 'blue_tube', target: 'tube', hand: 'either' }`, show `[blue_tube, tube]`.

  Assert:
  - On `open`, the accents are `cap` `{ color: ACCENTS.act, opacity: 1 }` and `tube` `{ color: ACCENTS.hold, opacity: 1 }`.
  - On `pour`, `blue_tube` is act and `tube` is destination.
  - Review Focus, on `open`:
    - After `focus.answered` with `actionId: 'tube'`, `tube` is still `ACCENTS.hold` and exactly one followed object is `ACCENTS.act`.
    - After `highlight('tube', 'attention')` the tube is `{ color: ACCENTS.hint, opacity: HINT_OPACITY }`, and after `tracking.update(7000)` it is `ACCENTS.hold` again.

- [ ] **Step 3: Write the failing fallback test** in `spotlight.test.ts`: `it('outlines the whole of the worked part with the hold role')`. For the same `open` step, the `overlay.outline` event for `tube` carries `role: 'hold'`.

- [ ] **Step 4: Run the three files.** Run `pnpm vitest run apps/headset/test/domain/overlay.test.ts apps/headset/test/domain/live-tracking.test.ts apps/headset/test/domain/spotlight.test.ts`. Expected: FAIL (`actWhole` not exported, `ACCENTS.hold` undefined).

- [ ] **Step 5: Implement in `accents.ts`, then compute `actWhole(step, registry.spec)` once per rebuild.** Pass it as the sixth argument at both `stepRole` calls in `LiveTracking.rebuild` and at `spotlight.ts:205`. Rerun Step 4; expected PASS.

- [ ] **Step 6: Update `DESIGN.md`.**
  - Add the row `| Hold | what the other hand holds steady while a part of it is worked | violet \`#a970ff\` | the declared whole of the step's acting part |` after Destination.
  - Change the Rules line to `at most one cyan, one violet and one yellow at a time`.
  - Add `hold` to the role list in the "Implementation map" paragraph.

  Run `pnpm check`; expected PASS. Commit with the message `feat(headset): the whole a worked part sits on glows violet`.

---

### Task 4: The headset tells the tracker which followed whole a part is on

**Files:**
- Modify: `apps/headset/src/domain/session/live-tracking.ts` (`LiveObject`, `rebuild`, `followed`)
- Modify: `apps/headset/src/adapters/net/tracker-client.ts` (`TrackedQuery`, new `toTrackedQuery`)
- Modify: `apps/headset/src/app/live-tracker.ts:320-335` (`follow`), `apps/headset/src/desk/desk-tracker.ts:243-248` (`follow`)
- Test: `apps/headset/test/domain/live-tracking.test.ts`, `apps/headset/test/adapters/tracker-client.test.ts`

**Interfaces:**
- Produces:
  - `LiveObject.partOf: string | null`: the id of the object it is a part of, when that object is in the same followed list and is not itself a part. Otherwise null. Computed after the list is cut to `MAX_LIVE_OBJECTS`.
  - `TrackedQuery.partOf?: string`
  - `toTrackedQuery(o: { id: string; phrase: string; query: string; partOf: string | null }): TrackedQuery`. It returns `{ id, phrase, query }` plus `partOf` only when it is non-null, so a set with no parts serializes exactly as before.

- [ ] **Step 1: Write the failing tests.**
  - `live-tracking.test.ts`, `it('says which followed whole each part is on')`: the Task 3 plan gives `cap.partOf === 'tube'`, `tube.partOf === null`, `blue_tube.partOf === null`. A plan with 8 other findable objects declared before `tube` and its `cap` shown leaves `tube` out of the list, so `cap.partOf === null` (Review Focus).
  - Update the existing `follows the whole object a part belongs to…` expectation: add `partOf: null` to `caliper`, and assert `tracking.get('scale')?.partOf === 'caliper'`.
  - `tracker-client.test.ts`:

```ts
  it('names a part's whole only when it has one, so a set without parts is sent as before', () => {
    const plain = { id: 'cup', phrase: 'blue cup', query: 'The blue cup', partOf: null };
    expect(JSON.stringify(toTrackedQuery(plain))).toBe(
      '{"id":"cup","phrase":"blue cup","query":"The blue cup"}',
    );
    expect(toTrackedQuery({ ...plain, id: 'cap', partOf: 'tube' }).partOf).toBe('tube');
  });
```

- [ ] **Step 2: Run them.** Run `pnpm vitest run apps/headset/test/domain/live-tracking.test.ts apps/headset/test/adapters/tracker-client.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.** Add `partOf` to every `LiveObject` the rebuild makes (null at first), then fill it in one pass over the final list. Map `this.tracking.objects` through `toTrackedQuery` in both `follow()` methods. Rerun Step 2; expected PASS. Run `pnpm check`; expected PASS. Commit with the message `feat(headset): tell the tracker which followed whole each part is on`.

---

### Task 5: Plans can declare a part and show up to three things (schemas and building)

**Files:**
- Modify: `apps/server/src/services/plan-schema.ts:151` (full object `partOf` description), `:186-195` (full step `show`), `:256-266` (`cardObject`), `:277` (card step `show`)
- Modify: `apps/server/src/services/plan-build.ts` (`cardObject`, new `soundParts`, `buildPlanCandidate`, `mergeRevision`, `writerObjects`, `mergeParallelRest`)
- Test: `apps/server/test/plan-schema.test.ts`, `apps/server/test/plan-build.test.ts`

**Interfaces:**
- Produces:
  - Both `show` arrays: `maxItems: 3`, described as `At most 3: what the hands act on, the whole it is part of when that is a part, and where it goes; never two in one role`.
  - `cardObject` schema: an optional `partOf` string as the last property, with `required` unchanged. Its description, also used for the full object: `Only for a part the hands work on that looks unlike the declared object it is on (an orange cap on a clear tube): that object's id. Leave it out otherwise`.
  - `cardObject(card)` keeps `partOf` when it is a string.
  - `soundParts(objects: readonly unknown[]): unknown[]` drops `partOf` from any object whose `partOf` names an id not in the list, its own id, or an object whose own `partOf` is a string (one level only). It decides from the input, leaves everything else untouched, and returns the same array contents when nothing needs dropping.
  - `soundParts` is applied to the `objects` of the candidates built by `buildPlanCandidate`, `mergeRevision` and `mergeParallelRest` (after its filter of unused new objects), and to the result of `writerObjects`.

- [ ] **Step 1: Write the failing tests.**
  - `plan-schema.test.ts`:
    - Both show expectations become `maxItems: 3`.
    - The card keys become `['id', 'label', 'phrase', 'look', 'moves', 'partOf']`, with `required` still `['id', 'label', 'phrase', 'look', 'moves']`.
    - `props(card).partOf` matches `{ type: 'string' }`.
    - The existing "never bounds an array of $ref or anyOf items" test stays green.
  - `plan-build.test.ts`:
    - `it('keeps a card's partOf')`: `cardObject({ ...washerCap, partOf: 'reservoir' })` has `partOf: 'reservoir'`.
    - `it('drops a partOf that names no object, itself or another part')`: `soundParts` on `[a, {b, partOf: 'a'}, {c, partOf: 'b'}, {d, partOf: 'zz'}, {e, partOf: 'e'}]` keeps only b's.
    - `it('builds a first card whose cap is a part of its tube and shows both')`: `buildFirstStageCandidate` with cards `tube` and `cap` (`partOf: 'tube'`) and `firstStep.show: ['cap', 'tube']` parses with `parseProcedure`. The cap has `partOf: 'tube'` and the first step shows 2 items.
    - `it('drops a part's partOf when rest leaves its whole out')`: in `mergeParallelRest`, a new part card whose whole no written step uses gives a valid plan with that `partOf` removed.

- [ ] **Step 2: Run them.** Run `pnpm vitest run apps/server/test/plan-schema.test.ts apps/server/test/plan-build.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement as in Interfaces.** Rerun Step 2; expected PASS. Run `pnpm check`; expected PASS. Commit with the message `feat(planner): a plan may declare a worked part and show up to three things`.

---

### Task 6: The planner prompt asks for worked parts and up to three lights

**Files:**
- Modify: `apps/server/src/services/plan-prompt.ts`: the `action` bullet (around line 86), SHOW `show` bullet (112-114), OBJECTS "Whole things only" bullet (141-146), `firstStageText` `objects` and `firstStep` bullets (215-222), `reviewText` `objects` bullet (around 371)
- Modify: `docs/coach-plan.md` (the "show one object per step…" sentence only, around line 172), `docs/handoff-stage1-speed.md` (the parts sentence around line 122)
- Test: `apps/server/test/gemini-planner.test.ts`

**Interfaces:**
- Consumes: the Task 5 schemas (the prompt must not ask for more than they allow).

- [ ] **Step 1: Change the prompt tests.**
  - In the `covers %j` list, remove `'never a part that stays attached to it'`, `'Name the part in the words instead'` and `'One object at a time'`. Keep `'the mini fridge, not its door, handle, shelf or freezer compartment'`. Add `'as an object of its own, with \`partOf\`'`, `'it looks unlike the thing it is on'`, `'A part that looks like its whole stays a word'`, `'up to three items, never two of one kind'`and`"the part is the action's \`object\` and its whole is in \`targets\`"`.
  - Replace the test `no longer asks for parts as objects or for several outlines per step` with `it('keeps parts that look like their whole out of the objects')`, asserting the prompt contains `'(an open door for the freezer compartment)'`.

- [ ] **Step 2: Run it.** Run `pnpm vitest run apps/server/test/gemini-planner.test.ts`. Expected: FAIL on the added phrases.

- [ ] **Step 3: Rewrite the bullets.** The words are the builder's, but they must contain the tested phrases and say:
  - **OBJECTS:** declare whole things. Also declare a part as an object of its own, with `partOf` set to the whole's id, when a step's hands work on it directly and it looks unlike the thing it is on (another color or material: the orange cap of a clear test tube, a black knob on a white panel). Each look-alike whole gets its own part (one cap per tube). A part that looks like its whole stays a word: keep the fridge-door example and its reason, and name such a part in the instruction, doneWhen and show description.
  - **ACTION:** when the hands work a part, the part is the action's `object` and its whole is in `targets`.
  - **SHOW:** up to three items, never two of one kind: what the hands act on; when that is a part, the whole it is on, which the other hand holds; where it goes, when something moves somewhere. Give the cap-and-tube example and the pour example. A step with nothing to point at shows none.
  - **First stage:** `show` lists the object ids it outlines, as SHOW says, and a part card carries `partOf`, as OBJECTS says.
  - **Review cards:** add `partOf` for a part to the card fields.
  - **Docs:** update the two doc sentences to match.

  Rerun Step 2; expected PASS.

- [ ] **Step 4: Measure the first stage.** Run `pnpm bench` (`docs/planner-bench.md`) on this branch and on its base commit, on the saved scenarios. Expected: the median stage-1 time on the branch is no more than 10% above the base's, and the fridge scenes still declare no door, handle or shelf. Record both numbers in the commit message. Commit with the message `feat(planner): ask for worked parts and up to three lights per step`.

---

### Task 7: The tracker reads which whole a part is on

**Files:**
- Modify: `tracker/src/clio_tracker/identify.py` (`Query`)
- Modify: `tracker/src/clio_tracker/track.py:188-214` (`_object_set`)
- Modify: `tracker/TRACK.md` (objects mode: the `objects` field list, and replace "There is no part mode here…" with a "Parts in objects mode" paragraph describing Tasks 8 and 9)
- Test: `tracker/tests/test_track.py`

**Interfaces:**
- Produces:
  - `Query(id: str, query: str, phrase: str | None = None, part_of: str | None = None)`, frozen as now.
  - `_object_set` reads `partOf` and checks it after the first-8 cut. It keeps it when it is a string naming another object kept in the set whose own `partOf` is not kept.
  - Otherwise `part_of` is None and `log.warning("Track: %s names %r as its whole, which is not another whole in the set; followed as a whole", oid, part_of)` is logged.
  - A bad `partOf` never raises `BadMessage`.

- [ ] **Step 1: Write the failing tests.**

```python
def test_objects_keep_a_part_of_another_object_in_the_set(caplog):
    tube = {"id": "tube", "phrase": "clear test tube", "query": "A clear test tube"}
    cap = {"id": "cap", "phrase": "orange cap", "query": "Its orange cap", "partOf": "tube"}
    (t, c) = parse_command(objects(tube, cap)).objects
    assert t.part_of is None and c.part_of == "tube"
    for bad in ("zz", "cap", 3):
        with caplog.at_level(logging.WARNING, logger="clio_tracker"):
            (_, c) = parse_command(objects(tube, {**cap, "partOf": bad})).objects
        assert c.part_of is None
    chained = {"id": "label", "phrase": "label", "query": "Its label", "partOf": "cap"}
    assert parse_command(objects(tube, cap, chained)).objects[2].part_of is None
    assert "followed as a whole" in caplog.text
```

`test_objects_parse_in_order_first_words_win_and_at_most_eight` stays unchanged and green.
- [ ] **Step 2: Run it.** Run `cd tracker && uv run pytest -q tests/test_track.py -k "part_of or objects_parse or bad_objects"`. Expected: FAIL (`part_of` unknown).

- [ ] **Step 3: Implement it and write the TRACK.md text.** Rerun Step 2; expected PASS. Commit with the message `feat(tracker): an objects message may say which object a part is on`.

---

### Task 8: `PartTracker` rides a declared whole

**Files:**
- Modify: `tracker/src/clio_tracker/part.py` (`PartTracker` fields, `identified`, `_parent_on`, `step`, new members)
- Test: `tracker/tests/test_part.py`

**Interfaces:**
- Produces, on `PartTracker`:
  - `whole: ObjectTracker | None = None`: the declared whole, followed by the session. The part reads it and never steps it or tells it anything.
  - `placed_by: str | None = None`
  - `identified(seq, t, present, box, enc, vision, carry=None, mask=None, finder: str = "jev") -> str` sets `placed_by = finder` unless the change is `"stale"` or `"part absent"`.
  - `step(enc, seq, t, vision, camera=None, gray=None, held: Sighting | None = None) -> Sighting`. With `whole` set, `held` is the whole's sighting on this frame and stands in for stepping `self.parent`.
  - `wants_jev_now: bool` (property): `self._box is None and not self.absent`.
  - `steady(t: float) -> bool`: `self.whole.steady(t)` with a whole, else False.
  - `holds(seq: int, box: np.ndarray, carry: np.ndarray | None = None) -> bool`: True when there is no part box. Otherwise the box (carried by `carry`) must overlap the part box on frame `seq`, or else the newest one, by IoU at least `params.match_iou`, or one box must lie inside the other.
  - `box_on(seq: int) -> np.ndarray | None`: the public form of `_box_on`.
- With `whole` set, `_parent_on` never calls `find_parent` and never identifies anything. It returns `(whole.box_on(seq), "part, on its whole")` when `_held(box, held[None])[0] >= params.part_inside`, else `(None, "part, off its whole")`.
- With `whole` set, the part rides the whole's motion, and the whole's sighting refreshes `_seen_t`, only while the part box lies on the whole's measured box (`_held >= part_inside`). Off it, only the camera and its own follower move it, and it ages from jev's last answer like a part with no parent.
- With `whole` None, behavior is unchanged (`test_part_without_follower_is_identical_to_before` and the rest of `test_part.py` stay green).

- [ ] **Step 1: Write the failing tests** in `test_part.py`. Use an `ObjectTracker` placed on `WHOLE` as the whole, and step it before the part on each frame, passing its sighting as `held`.
  - `test_a_part_on_a_declared_whole_rides_it_and_never_tells_it`: the part is identified at `PART`, then the whole moves +20 px over 5 frames. The part box moves with it (x1 within 3 px of `PART[0] + 20`). A spy on `whole.identified` records no calls, and `part.parent is None`.
  - `test_a_part_on_a_declared_whole_never_looks_for_a_parent`: monkeypatch `clio_tracker.part.find_parent` to raise. `identified` at `PART` returns `"part, on its whole"`; at `OTHER` it returns `"part, off its whole"`.
  - `test_a_part_off_its_whole_is_not_dragged_by_it`: identified at `OTHER`, then the whole moves +40 px. The part box stays within 3 px of `OTHER`. After `params.part_hold_s` with no answer it is `state == "lost"`, even though the whole is tracking.
  - `test_a_part_says_whether_a_box_is_on_it_and_who_placed_it`: after `identified(..., finder="er")`, `placed_by == "er"`, `holds(seq, PART_box)` is True, `holds(seq, OTHER_box)` is False, and `steady(t)` equals `whole.steady(t)`.

- [ ] **Step 2: Run them.** Run `cd tracker && uv run pytest -q tests/test_part.py`. Expected: the four new tests FAIL; the others PASS.

- [ ] **Step 3: Implement as in Interfaces.** Rerun Step 2; expected all PASS. Run `cd tracker && uv run ruff check src tests`; expected clean. Commit with the message `feat(tracker): a part can ride a whole the session follows`.

---

### Task 9: Lesson mode follows parts on their wholes

**Files:**
- Modify: `tracker/src/clio_tracker/session.py` (`follow`, `_follow`, `_tracker_for`, `_apply`, `_apply_anchors`, new `_tell`, new `_on_another_whole`)
- Modify: `tracker/README.md` ("Parts of objects" paragraph: objects mode now follows declared parts)
- Test: `tracker/tests/test_session.py`, `tracker/tests/test_track.py`

**Interfaces:**
- Consumes:
  - `Query.part_of` (Task 7).
  - `PartTracker(object_id, phrase, params, follower=..., whole=...)`, with `step(..., held=)`, `identified(..., finder=)`, `placed_by`, `wants_jev_now`, `steady`, `holds` and `box_on` (Task 8).
- Produces:
  - `_tracker_for(q, now) -> ObjectTracker | PartTracker`. A query with `part_of` gets a `PartTracker` whose `whole` is the whole's tracker in `self._objects`. Trackers are made for wholes before parts.
  - The tracker starts over, as for a new phrase, when the phrase changes, when `part_of` appears or goes, or when it names another whole.
  - Re-sending the same query keeps the same tracker.
  - `follow` and `_follow` step every whole before its parts. Each part's step gets its whole's sighting from this frame as `held`. Sightings are returned in query order, and a set without `part_of` is stepped in exactly today's order.
  - `_tell(tr, seq: int, now: float, present: bool, box: np.ndarray | None, enc: Encoding, carry: np.ndarray | None, finder: str) -> str` calls the right `identified`. An `ObjectTracker` gets an appearance from `self.vision.prompts(enc, box)[0]`. A `PartTracker` gets `enc` and `self.vision`.
  - `_on_another_whole(oid: str, seq: int, box: np.ndarray) -> str | None`. "Other wholes" are objects in the set that some other part names as its `part_of`. For a part, it returns such an object (not the part's own whole) whose `box_on(seq)` holds the box (`_held >= part_inside`), but only while the part's own whole's `box_on(seq)` does not. It returns None for everything else.
  - In `_apply` and `_apply_anchors`, a box for which `_on_another_whole` gives an id is skipped with `log.info("%s: %s boxed it on %s, not on %s: ignored", oid, finder, other, whole)`. It is not cut and not anchored.

- [ ] **Step 1: Pin today's behavior first.** Before touching `session.py`, add `test_a_set_without_parts_follows_exactly_as_before` with two cases:
  - The `setup` fixture with two queries (`CUP` and a jug), one jev answer placing both, then 10 frames of moving `Thing`s.
  - `anchored_lesson` with one `er` anchor, then 5 frames.

  Write the detections each case produces now as literal expected values. Run `cd tracker && uv run pytest -q tests/test_session.py -k exactly_as_before`. Expected: PASS. Commit it alone with the message `test(tracker): pin objects-mode output for sets without parts`.

- [ ] **Step 2: Write the failing tests** in `test_session.py`. Use `TUBE_A`, `TUBE_B`, and `CAP_A = Query("cap_a", "The orange cap on tube A", "orange cap", "tube_a")`, with `CAP_B` likewise. Each cap is a `Thing` at the top of its tube's box.
  - `test_a_part_rides_its_declared_whole`: jev places both tubes and `cap_a`. Over 6 frames tube A moves +24 px. `cap_a` is found, its box moves with tube A within 3 px, and `tube_a`'s box is unchanged by the cap's answers. Detections come back in query order.
  - `test_jevs_box_for_a_part_on_another_whole_is_ignored`: `cap_a` placed, then jev answers `cap_a` at cap B's box. `cap_a`'s box stays on tube A, and the log has `"not on tube_a: ignored"`.
  - `test_an_er_anchor_for_a_part_takes_the_part_path`: an `er` anchor for `cap_a` makes its sighting `finder == "er"` and `tube_a`'s box unchanged. An anchor for `cap_a` on tube B is ignored with the same log line.
  - `test_the_same_set_again_keeps_the_part_and_a_dropped_whole_starts_it_over` (Review Focus): sending the same queries keeps `session._objects["cap_a"]` the same object. Sending `CAP_A` without `part_of` (tube A left out) makes it an `ObjectTracker`, with no error on the next frame.
  - In `test_track.py`, `test_objects_mode_follows_a_part_over_the_socket`: an objects message with `partOf` through `Modes` gives detections for both ids.

- [ ] **Step 3: Run them.** Run `cd tracker && uv run pytest -q tests/test_session.py tests/test_track.py`. Expected: the new tests FAIL; `exactly_as_before` PASSES.

- [ ] **Step 4: Implement as in Interfaces.** Rerun Step 3; expected all PASS, `exactly_as_before` included. Run `pnpm tracker:test` and `cd tracker && uv run ruff check src tests`; expected PASS and clean.

- [ ] **Step 5: Check that target mode is unchanged.** First confirm `git -C /Users/peter/Desktop/Clio status --short tracker` prints nothing (the main checkout's tracker is the base). Then run `cd tracker && uv run --extra coreml clio-tracker jitter --baseline /Users/peter/Desktop/Clio/tracker/src/clio_tracker`. Expected: every figure the same in both columns. Commit with the message `feat(tracker): lessons follow a part on the whole it belongs to`.

---

### Task 10: The whole lesson, with the user

**Files:**
- Modify: `docs/superpowers/specs/2026-10-25-part-and-holder-highlights-design.md` (append results to `## Measured`)

- [ ] **Step 1: Run the full checks.** Run `pnpm check && pnpm tracker:test`. Expected: PASS.

- [ ] **Step 2: Run the desk lab.** Start `pnpm tracker` and `pnpm dev`, open the desk lab, and plan "Pour the blue test tube into the white test tube" fresh with both capped tubes in view. Check:
  - The plan declares one cap per tube with `partOf` its tube.
  - Step 1 shows the cap cyan and its tube violet.
  - The pour step shows the blue tube cyan and the white tube yellow.
  - With the tubes held close together, the white tube's cap glow never sits on the blue tube's cap.
  - The unscrewed cap keeps its own glow, not the tube's, until the step ends.

  Screenshot each step.

- [ ] **Step 3: Run it on the headset.** Do the same run on the headset (`docs/dev-setup.md`).

- [ ] **Step 4: Look at the colors.** If the cap's cyan does not read clearly on top of the violet tube, try cutting the part's mask out of its whole's glow, and choose with the user. Any other violet must stay saturated, opaque, and unlike cyan, yellow, green, red and `#f2f6fa`. If the hex changes, update `ACCENTS.hold` and `DESIGN.md` together.

- [ ] **Step 5: Save a test-tube bench scenario.** Use the Task 1 frames, saved the way `docs/planner-bench.md` describes. Run `pnpm bench` on it and note its stage-1 time. This is reported, not gated: a card with an extra object and show item is slower by construction.

- [ ] **Step 6: Record and commit.** Append what was seen (pass or fail per check, the screenshots' paths, and the test-tube stage-1 time) to the spec. Commit with the message `docs: test tube lesson with part and holder highlights`.

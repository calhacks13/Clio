# The plan language

A procedure is a lesson: the objects involved, plus ordered steps. Each step has the end state
that says it's done, a machine-checkable success condition, an action Clio can demonstrate, and
the things Clio outlines for the learner. **Most procedures are written at runtime by
the planner LLM** (`POST /api/plans`, saved to `data/plans/`). The files in `procedures/` are
curated golden lessons used for demos, as planner examples and as test fixtures, and the coach can
start a lesson from one (`start_lesson` with `template_id`). Both use the same schema,
`packages/protocol/src/procedure.ts`, and pass the same validation, including the cross-references
(a step can't target an object that wasn't declared). Whoever wrote the first draft, the coach
edits the plan as the lesson goes ([coach-plan.md](coach-plan.md)).

The planner writes a lesson in two stages, so it can start quickly. The first stage writes the
first step as a short card (its instruction, `doneWhen`, `targets`, action, what it shows and up
to two mistakes) with only the objects that step uses and its look-alikes, and the other steps as
an outline: an instruction each and a `confirm` check whose prompt is that instruction, with no
`targets` and nothing to `show` yet. The server expands the card into an ordinary procedure
([coach-plan.md](coach-plan.md)). While the learner does the first step, the second stage writes
the outline steps in full as a revision (`<id>-r1`, `origin.revisionOf`), and the card's objects
again in full, keeping their ids and labels.

To get editor autocomplete, add `"$schema": "../packages/protocol/schema/procedure.schema.json"`.
`pnpm test` validates every file in `procedures/`.

The **instruction** is the most important field. It's spoken by the coach, shown in AR, and stored
as the language label for every frame of its step. Write it as one short imperative sentence that
a robot policy could be conditioned on: "Add vinegar to cup A."

## Objects

```json
{
  "id": "cap",
  "label": "blue reservoir cap",
  "kind": "item",
  "radius": 0.03,
  "placement": { "method": "detect", "hint": "front left of the engine bay" },
  "tracking": { "query": "blue cap with a windshield symbol", "moves": true }
}
```

**`placement`** says how Clio first finds the object:
- `detect`: from the camera, using `tracking.query` (or the label). This is what the planner uses.
- `register`: the learner pinches it.
- `layout`: a fixed workspace position, for curated mats with taped spots. A camera detection
  doesn't move a layout object until it has been carried. Its outline is still drawn where the
  camera saw it.

**`tracking`** (optional):
- `query` is an open-vocabulary visual description. Be specific about color, shape and label text.
- `marker` is a printed ArUco fiducial, for precision demos.
- `moves: true` marks objects that travel.

Grasped movable objects (`item`, `tool`, `container`) ride with the hand that holds them.

**`partOf`** (optional) names the declared object this one is a component or a bounded area of:
a caliper's vernier scale is its own object (`kind: "item"`, its own `tracking.query`) with
`partOf: "caliper"`, and the caliper is declared too. A step that shows the part lights only the
part; the camera follows and records both, so the dataset has the whole object wherever the
learner takes it. The whole must be declared, and an object is never a part of itself. The
planner no longer writes it: it declares and shows the whole object (the mini fridge) and names
the part in the words ("Open the mini fridge door by its handle on the left."). It stays for
curated lessons and older plans.

**`hidden: true`** objects aren't drawn. Use them as zones for mistake rules.

While a lesson runs, the live tracker follows every declared object the camera can find (not
hidden zones or points), up to 8 at a time, with the focused step's `show` items first. Only the
show items and the coach's highlights are lit; the rest is recorded
([object-finder.md](object-finder.md#when-clio-asks)).

**Positions** are reference points in the workspace frame (x along the near edge, y up, z toward
the learner, so tabletop positions have z < 0). Put the point where the hand or tool goes, such as
the rim or the mouth.

## Actions: how Clio shows a step

```json
"action": { "verb": "twist", "object": "cap", "direction": "ccw", "amount": 1.5 }
```

The verb picks a choreography for the synthesized ghost hands, placed on the objects' real
positions. It's also stored as a structured action label. Verbs (`ACTION_VERBS` in
`packages/protocol/src/actions.ts`):

| Verb                                                   | Object / target                               | Shows                                                  |
| ------------------------------------------------------ | --------------------------------------------- | ------------------------------------------------------ |
| `point_at`, `touch`, `pinch`, `grasp`, `press`, `wipe` | object                                        | reach and touch / pinch / grip / push / wipe           |
| `pick_up`, `lift`                                      | object (`amount` = height)                    | grip and raise                                         |
| `place`, `insert`, `pour`, `fold`                      | object → target                               | carry, then set down / push in / tilt over / fold over |
| `twist`                                                | object (`direction` cw/ccw, `amount` = turns) | grip from above and rotate in strokes                  |
| `pull`                                                 | object (`direction`, `amount` = meters)       | grip and pull                                          |
| `observe`, `wait`, `other`                             | optional                                      | no hand motion (highlights only)                       |

When an expert's recording of the step exists (`mode=record_demo`, then sliced into clips), it
replaces the synthesized demo.

## Show: what a step outlines

```json
"show": [
  {
    "object": "cap",
    "phrase": "blue washer fluid cap",
    "description": "Round blue plastic cap with a windshield-spray symbol, on a white tank at the front left of the engine bay, beside a yellow cap"
  }
]
```

When the step starts, Clio sends one camera frame and each item's words to the **object finder**
and outlines what it finds in AR. The finder is Gemini, or jev or another model behind
`CLIO_VISION_URL` (see [object-finder.md](object-finder.md)). The first item, the thing to act
on, is outlined in cyan; the rest, where it goes, in amber. While the step runs, Clio looks again
every few seconds, so the outlines follow objects that get moved. It skips objects in the
learner's hand, because hand tracking already follows them.
- `phrase`: 2 to 5 words, the subject a detector looks for: color or material, then a concrete
  noun ("blue plastic cap", "white yogurt bottle"). It names what stays true all lesson (a cup's
  own color, not its contents'), because the tracker starts an object's track over when its
  phrase changes. Never a position, a verb, or a word as bare as "item", "object" or
  "container". jev and other detectors that take category prompts use it.
- `description`: one short standalone sentence of at most 30 words that jev can check against
  the one frame it sees, with no other context. It names one particular thing, never a kind: say
  what it is and its color (and any text or symbols, or its state at that point in the task,
  when that tells it apart), then, always, both where it is in the picture (left or right, top
  or bottom, closest to the camera) and where it is relative to other things in view: its place
  among look-alikes ("the bottom one of the three chargers", "the leftmost cup") or next to a
  nearby object ("left of the laptop"). Never just a name, and never a place in the picture alone
  ("on the lower right": on a Quest lesson jev found the charger on none of 78 calls in those
  words). Relate it to whole things, not
  to their parts ("plugged into the lower socket of the extension block" is too hard to check).
  Never an action or a step. The instruction still singles out a place a step uses (a shelf, a
  drawer) as a person would: "the second shelf from the top".
  `tracking.query` follows the same rule, because the finder gets only that sentence;
  `placement.hint` never replaces it. While a step is focused, Robotics-ER 2's action focus
  rewrites what jev is told about each object from a sharp frame
  ([robotics-er.md](robotics-er.md)).
- At most 4 items, most important first. Every `object` must be declared.

The planner writes `show` for every step, with one item: the whole thing the step acts on, so
one object glows at a time. A step without it outlines nothing and only looks for targets it
hasn't found yet. Each answer is recorded as an `object.detected` event, so every
outline is also a training label.

## Done when: how a step ends

```json
"doneWhen": "the blue cap is off and lying on the fender"
```

`doneWhen` is the step's finished state, as a camera or the learner would see it. The coach judges
completion against it, and so does the step watcher, which sends a camera frame and the step's
`doneWhen` to the planner's model every few seconds and tells the coach when the step looks done
(see [coach-plan.md](coach-plan.md)). Every plan the coach hears shows it as `Done when: ...`.
- One sentence, 3 to 200 characters. Start lower case and leave off the period, because it's read
  after "Done when:".
- Describe the end state, not the motion. Good: "cup A has turned pink". Vague: "the user has
  compared the colors", which no camera can see.
- Name real things by how they look and where they are. The camera doesn't see AR dots or
  outlines: write "the left hand pinches the near shoulder, halfway between the collar and the
  sleeve seam", not "at the shoulder dot".
- Say what tells the right object apart from a look-alike in view, so the look-alike can't pass:
  "the small bottle with the pink cap and the DRINKING YOGURT label is in the learner's hand",
  not "the learner has the drink" (which the milk beside it would pass too).
- Write steps so each one ends in a visible state. When it can't be seen (a click, work out of
  view), say what the learner will notice, so the coach can ask.
- A `confirm` check's `prompt` says the same thing as `doneWhen`.

The planner writes `doneWhen` for every step. It's optional in the schema; without it, the coach
and the watcher judge by the instruction.

## Checks

Every leaf check is a **state**: "true now, for at least `dwellMs`". That makes checks composable
and tolerant of one-frame tracking dropouts.

| Check                                                | Satisfied when                                                                          | Defaults                       |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------ |
| `pinch_near { object, hand, radius }`                | the hand is pinching within `radius` of the object                                      | hand `either`, 0.04 m, dwell 0 |
| `hand_near { object, hand, point, radius, dwellMs }` | a hand point (`pinch`, `index_tip`, `thumb_tip`, `palm`, `wrist`) stays near the object | 0.06 m, 250 ms                 |
| `lift { hand, point, height }`                       | the point is at least `height` above the surface                                        | wrist, 0.15 m, 200 ms          |
| `object_near { object, target, radius }`             | a tracked object stays near another                                                     | 0.06 m, 500 ms                 |
| `confirm { by, prompt }`                             | the coach (`complete_step`) or learner (Done button) confirms                           | `either`                       |
| `elapsed { ms }`                                     | the step has been active for `ms`                                                       |                                |
| `all` / `any` / `sequence { of }`                    | every child / some child / children in order (each latches)                             |                                |

Patterns:
- Use `any [object_near syringe→cup_a, hand_near cup_a]` as a fallback for when tracking drops.
- Use `all` to hold one point while pinching another (see `shirt-fold.json`).
- End visual results with `sequence [..., confirm]`: the coach sees the camera frames, e.g. "cup A
  has turned pink".
- Loosen radii (7–8 cm) where the hands cross or hide each other.

A passing check completes the focused step on its own, and so does the Done button. The coach can
complete any step, in any order, with `complete_step` and the step's `step_id`. A step is labeled
`forced` when its check hadn't passed.

When the coach is Gemini in learn mode, checks and mistake rules see only trusted positions: hand
tracking, and objects placed by a printed marker, a manual placement, `layout` on a calibrated
workspace, or a learner's pinch when it was the only object missing. Camera detections don't
count, so a check on an object only the camera found waits for the coach or the Done button, even
while the learner holds it. The same check also runs on every position, with its own state, but
that only labels a completion `forced`; it never completes a step. Everywhere else (the scripted
coach, `record_demo`, or while the Gemini connection is down) checks see every position. See
[the perception boundary](coach-plan.md#the-perception-boundary).

## Mistakes

```json
{
  "kind": "wrong_cup",
  "message": "That's cup B. Vinegar goes in cup A.",
  "when": { "type": "hand_near", "object": "cup_b", "dwellMs": 700 },
  "cooldownMs": 4000
}
```

A mistake fires on its rising edge, then waits `cooldownMs` before it can fire again. It's recorded
as `mistake.detected`, and the coach is told to correct the learner. A Gemini coach is told only
while it is in charge, when the rule saw only trusted positions. Give it a dwell so that passing by
doesn't count. When a look-alike is in view, the planner makes taking it a step's first mistake,
and its message says how to tell the two apart.

## Coach hints

- `coachNotes` (per step) and `coach.persona` / `coach.notes` (per procedure) shape the coach.
  Write them about the task, not about tracking or checks: the coach judges from what it sees and
  hears, and never hears positions.
- `stuckAfterMs` tells the coach the learner seems stuck, which is a cue to offer `show_demo`.
- Generated plans carry `origin: { kind: "generated", goal, model, createdAt, revisionOf? }`.

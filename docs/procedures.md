# The plan language

A procedure is a lesson: the objects involved, plus ordered steps. Each step has a
machine-checkable success condition, an action Clio can demonstrate, and the things Clio outlines
for the learner. **Most procedures are written at runtime by
the planner LLM** (`POST /api/plans`, saved to `data/plans/`). The files in `procedures/` are
curated golden lessons used for demos, as planner examples and as test fixtures. Both use the same
schema, `packages/protocol/src/procedure.ts`, and pass the same validation, including the
cross-references (a step can't target an object that wasn't declared).

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

**`hidden: true`** objects aren't drawn. Use them as zones for mistake rules.

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
- `phrase`: 2 to 5 words naming the thing, like a label on a box. Detectors that take category
  prompts (SAM 3, Grounding DINO) use it.
- `description`: one sentence of 12 to 30 words that finds the object in a single frame with no
  other context. Say what it is, and give its color, material, shape and size, any text or symbols
  on it, and where it is relative to its surroundings. Describe its state at that point in the
  task ("the cap is off", "the cup is now pink"). If something similar is nearby, say what tells
  them apart.
- At most 4 items, most important first. Every `object` must be declared.

The planner writes `show` for every step. A step without it outlines nothing and only looks for
targets it hasn't found yet. Each answer is recorded as an `object.detected` event, so every
outline is also a training label.

## Checks

Every leaf check is a **state**: "true now, for at least `dwellMs`". That makes checks composable
and tolerant of one-frame tracking dropouts.

| Check                                                | Satisfied when                                                                          | Defaults                       |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------ |
| `pinch_near { object, hand, radius }`                | the hand is pinching within `radius` of the object                                      | hand `either`, 0.04 m, dwell 0 |
| `hand_near { object, hand, point, radius, dwellMs }` | a hand point (`pinch`, `index_tip`, `thumb_tip`, `palm`, `wrist`) stays near the object | 0.06 m, 250 ms                 |
| `lift { hand, point, height }`                       | the point is at least `height` above the surface                                        | wrist, 0.15 m, 200 ms          |
| `object_near { object, target, radius }`             | a tracked object stays near another                                                     | 0.06 m, 500 ms                 |
| `confirm { by, prompt }`                             | the coach (`advance_step`) or learner (Done button) confirms                            | `either`                       |
| `elapsed { ms }`                                     | the step has been active for `ms`                                                       |                                |
| `all` / `any` / `sequence { of }`                    | every child / some child / children in order (each latches)                             |                                |

Patterns:
- Use `any [object_near syringe→cup_a, hand_near cup_a]` as a fallback for when tracking drops.
- Use `all` to hold one point while pinching another (see `shirt-fold.json`).
- End visual results with `sequence [..., confirm]`: the coach sees the camera frames, e.g. "cup A
  turned pink".
- Loosen radii (7–8 cm) where the hands cross or hide each other.

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
as `mistake.detected`, and the coach is told to correct the learner. Give it a dwell so that
passing by doesn't count.

## Coach hints

- `coachNotes` (per step) and `coach.persona` / `coach.notes` (per procedure) shape the coach.
- `stuckAfterMs` tells the coach the learner seems stuck, which is a cue to offer `show_demo`.
- Generated plans carry `origin: { kind: "generated", goal, model, createdAt, revisionOf? }`.

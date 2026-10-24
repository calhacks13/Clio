# Writing procedures

A procedure is a task script: the objects involved, and the ordered steps with machine-checkable
success conditions. Files live in `procedures/<id>.json`, and the schema is
`packages/protocol/src/procedure.ts`. Add `"$schema": "../packages/protocol/schema/procedure.schema.json"`
to get autocomplete in your editor. `pnpm test` validates every file, including cross-references
such as a step targeting an object that doesn't exist.

The **instruction** is the most important field. It's spoken by the coach, shown in AR, and stored
as the language label for every frame of that step, so write it as one short imperative sentence
a robot could also be conditioned on: "Add vinegar to cup A."

## Objects

```json
{
  "id": "cup_a",
  "label": "cup A",
  "kind": "container",
  "radius": 0.04,
  "placement": { "method": "layout", "position": [0.15, 0.07, -0.12] },
  "tracking": {
    "marker": { "id": 1, "sizeM": 0.04, "offset": [0, 0.03, -0.035] },
    "query": "white paper cup with a large letter A",
    "moves": false
  }
}
```

- **`placement`** sets the starting position. `layout` uses a fixed workspace position: tape a spot
  there. `register` means the user pinches the object during setup.
- **`tracking`** (optional) tells the camera how to follow the object: a printed fiducial `marker`
  (fast, unambiguous, gives full pose), a detector `query` (works without stickers), or both.
  Set `moves: true` for things that travel, such as tools.
- **`hidden: true`** objects aren't drawn. Use them as zones for mistake rules ("pinched too low").
- Positions are reference points in the workspace frame: x along the near table edge, y up, z toward
  you, so table positions have z < 0. Put the point where a hand or tool should go, such as a cup
  rim or bottle mouth, not the object's base.

## Checks

Every leaf check is a **state** ("true right now, for at least `dwellMs`"). That makes checks
composable and tolerant of tracking dropouts.

| Check                                                | Satisfied when                                                                          | Defaults                            |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------- |
| `pinch_near { object, hand, radius }`                | the hand is pinching, with its pinch point within `radius` of the object                | hand `either`, radius 0.04, dwell 0 |
| `hand_near { object, hand, point, radius, dwellMs }` | a hand point (`pinch`, `index_tip`, `thumb_tip`, `palm`, `wrist`) stays near the object | radius 0.06, dwell 250              |
| `lift { hand, point, height }`                       | the point is at least `height` above the table                                          | wrist, 0.15 m, dwell 200            |
| `object_near { object, target, radius }`             | a tracked object stays near another object                                              | radius 0.06, dwell 500              |
| `confirm { by, prompt }`                             | the coach or user confirms (the coach's `advance_step` tool)                            | by `either`                         |
| `elapsed { ms }`                                     | the step has been active for `ms`                                                       |                                     |
| `all { of }`                                         | every child holds in the same frame                                                     |                                     |
| `any { of }`                                         | at least one child holds                                                                |                                     |
| `sequence { of }`                                    | children pass in order; each latches once it passes                                     |                                     |

Patterns:
- Use `any` for a tracking fallback: `any [object_near syringe→cup_a, hand_near cup_a]` still works if the marker is hidden.
- Use `all` to hold one point while pinching another (`pinch-middle` in `shirt-fold.json`).
- End visual results with `sequence [..., confirm]` and let the coach judge, e.g. "cup A turned pink".
- Use loose radii (7–8 cm) where the hands cross or occlude each other.

## Mistakes

```json
{
  "kind": "wrong_cup",
  "message": "That's cup B. Vinegar goes in cup A.",
  "when": { "type": "hand_near", "object": "cup_b", "dwellMs": 700 },
  "cooldownMs": 4000
}
```

A rule fires on its rising edge, then waits `cooldownMs` before it can fire again. It emits
`mistake.detected` (the machine label) and the coach responds, usually with `flag_mistake` and a
spoken correction. Give rules a dwell so that passing by doesn't count.

## Coach hints

- `coachNotes` (per step) and `coach.persona` / `coach.notes` (per procedure) go into the coach's
  system prompt.
- `stuckAfterMs` makes the app tell the coach the learner seems stuck, which is a cue to offer
  `show_demo`.

## Drafting new procedures ("learn anything")

`POST /api/procedures/draft { "task": "change a bike tire" }` asks an LLM for a draft that is
validated against the same schema and saved to `data/drafts/`. Review the positions, radii and
mistakes, then move the file to `procedures/`.

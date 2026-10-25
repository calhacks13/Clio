import { ACTION_VERB_NAMES, ACTION_VERBS, type ActionVerb } from '@clio/protocol';
import type { Content, Part } from '@google/genai';
import type { PlannerRequest, RestLine, RestPart } from './planner';

// Pure: the planner's system instruction and conversation turns. One system instruction serves
// every stage; what a stage asks for (the whole plan, an outline with its first step as a card,
// or the rest of an outline) is in the request turn.

function verbLine(verb: ActionVerb): string {
  const spec: { object: string; target: string; means: string } = ACTION_VERBS[verb];
  const arg = (name: string, rule: string) =>
    rule === 'required' ? [name] : rule === 'optional' ? [`${name}?`] : [];
  const args = [...arg('object', spec.object), ...arg('target', spec.target)].join(', ');
  return `  - ${verb}(${args}): ${spec.means}`;
}

export const PLANNER_SYSTEM_INSTRUCTION = [
  'You plan hands-on lessons for Clio, an AR coach that runs on a Meta Quest 3 headset. A ' +
    'learner names a task; you return the lesson plan as JSON that matches the response schema. ' +
    'The plan drives everything Clio does: the voice coach follows it, AR outlines show what ' +
    'each step is about, ghost hands demonstrate each step from its `action`, and every ' +
    'recorded frame is labeled with the active step to train robots.',
  '',
  'THE SCENE',
  '- Plan from the camera views, as things stand now. If the end state of a step is already ' +
    'visible (a cup already pink, a cap already off), that part of the goal is done: do not ' +
    'plan it again, in the same place or a new one. Start from there and say so in `warnings`.',
  '- Declare only objects you can see in the views, plus anything the task needs that is not ' +
    'in view; then say in `warnings` that the learner must fetch it.',
  '- `sightings`: point at every declared object you can see, once for each view it is in: ' +
    '`view` (numbered from 1 in the order the views are attached), `point` [y, x] on the object ' +
    'and `box_2d` [ymin, xmin, ymax, xmax], integers from 0 to 1000. An object that is not in ' +
    'view must not be pointed at: leave it out.',
  '- Look-alikes: when something in view could be taken for what a step needs (a milk carton ' +
    'beside a yogurt drink, three similar cups, two clear bottles), say how to tell them apart ' +
    'in that step, and make the mix-up one of its `mistakes`.',
  '- Without views, assume a typical home setup and leave `sightings` empty.',
  '',
  'ONE THING, NEVER A KIND',
  '- Every object or place a step uses is one particular thing in view. Everything you ' +
    'write about it must single it out, so that an object finder that sees one camera frame ' +
    'and nothing else cannot pick anything else: the instruction, the show description, ' +
    '`tracking.query` and doneWhen.',
  '- When there are several of a kind (shelves, drawers, doors, cups, beakers, bottles, ' +
    'buttons), choose one and name it by its place among them, counted the way a person ' +
    'would: "the second shelf from the top", "the leftmost of the three beakers", "the top ' +
    'drawer on the right". Left and right are as seen in the camera views.',
  '- Anchor it to large things that stay put (the fridge, the sink, the desk, the edge of the ' +
    'table), and add its color, material, size and any text, number or symbol on it.',
  "- The object finder's words (the show `description` and `tracking.query`) always say both " +
    'where it is in the camera picture and where it is relative to other things in view, as ' +
    'SHOW says.',
  '- Places count too: "Put the yogurt drink on the second shelf from the top.", not "on a ' +
    'shelf". Something not in sight yet (inside a closed fridge or drawer) is described as it ' +
    'will look once it is open, and where: "the second glass shelf from the top inside the ' +
    'black mini fridge, once its door is open".',
  '- Never a bare kind: "the shelf inside the refrigerator", "black refrigerator door" and ' +
    '"the beaker" are too vague. Good: "The black mini fridge on the floor right of the desk, ' +
    'the lower of two stacked black boxes, with a silver handle along the left edge of its door."',
  '',
  'STEPS',
  '- 3 to 10 steps, in the order a person does them, with exactly one physical action per step.',
  '- Cover the whole goal: everything it asks to do, make or test gets its steps, in the order ' +
    'it names them, unless the views show it done.',
  '- Keep the control the setup implies: when more like samples are set out than the goal ' +
    'treats (three cups for two tests), the spare one stays untouched for comparison. Use the ' +
    'others in their order.',
  '- Every step changes something a camera can see. Looking, comparing or checking is not a ' +
    'step of its own: put what to notice in the coachNotes of the step that causes it.',
  '- Leave things as they should be: close a door, lid or cap that the task opens or uses, ' +
    'unless the goal needs it open.',
  '- `instruction`: one short imperative sentence, at most 15 words, naming the action and the ' +
    'one object (and place) it uses, e.g. "Unscrew the blue washer fluid cap." or "Put the ' +
    'jar on the second shelf from the top." It is spoken, shown in AR, and used as the ' +
    "robot's language label.",
  '- `doneWhen`: one sentence, an end state a camera can confirm, described as it will look ' +
    'when the step is finished, e.g. "the blue cap is off and lying on the fender". It must be ' +
    'in sight: not inside an opaque bottle, syringe or box. Name what ' +
    'tells the right object apart from anything similar in view: "the small pink bottle with ' +
    'the foil lid is in the learner\'s hand, outside the fridge", not "the learner has the ' +
    'drink". Describe a state, never an action: "the liquid in cup C has turned green", not ' +
    '"baking soda is added". The coach and a camera check judge the step against it and must ' +
    'not pass a look-alike, so write each step so it ends in a visible state.',
  "- `targets`: ids of the objects the step's hands touch or look at. `hand`: left, right, " +
    'either or both.',
  '- `action`: what the hands do, as one verb with its arguments (object = the thing acted on, ' +
    'target = destination or recipient; "?" marks an optional argument, and a verb takes only ' +
    'the arguments listed):',
  ...ACTION_VERB_NAMES.map(verbLine),
  '  Add `direction` (cw, ccw, up, down, toward, away, left, right) and `amount` (turns for ' +
    'twist, meters for lift or pull, seconds for wait) when the verb uses them, and `note` for ' +
    'anything else.',
  '- `success`: how the app knows the step is done. Checks are states that must hold for `dwellMs`:',
  '  - confirm: the coach or learner confirms. Prefer it for visual state changes (a color, a ' +
    'fill level, "the cap is off") and anything hands alone cannot show; `prompt` says what ' +
    'must be true: make `prompt` match `doneWhen`.',
  '  - pinch_near / hand_near: the hand pinches at / stays near an object. Use them for touch ' +
    'and grasp.',
  '  - object_near: a tracked object is near another object. Use it only when `object` has ' +
    'tracking.moves = true.',
  '  - lift: a hand is raised above the work surface. elapsed: the step has lasted `ms`.',
  '  - all / any / sequence combine leaf checks one level deep, e.g. sequence [hand_near ' +
    'washer_cap, confirm "the cap is off"]. any [object_near …, hand_near …] still works when ' +
    'tracking is lost. Use loose radii (0.06 to 0.08 m) where hands cross or block each other.',
  '- `mistakes`: 0 to 2 plausible errors for the step, each a check that detects the error ' +
    '(e.g. hand_near the wrong bottle with dwellMs 700) and a short spoken `message` that ' +
    'corrects it and says how to tell the right one apart. Taking or using a look-alike that is ' +
    'in view comes first. `kind` is a lowercase label such as "wrong_cap".',
  '- `coachNotes`: a sentence or two for the coach: what to watch for and how to help.',
  '',
  'SHOW',
  '- `show`: the one object Clio outlines in AR during the step: the whole thing the learner ' +
    'acts on (the mini fridge for "Open the mini fridge door."). One object at a time: never ' +
    'a second one, and never a part of it. A step with nothing to point at shows none.',
  '- When the step starts, Clio hands each item to an object finder that sees one live camera ' +
    'frame and nothing else, and outlines what it finds. Each item must work on its own, ' +
    'without the plan, the other steps or the other items:',
  '  - `object`: the id of the declared object it is.',
  '  - `phrase`: what the object finder looks for, 2 to 5 words: color or material, then a ' +
    'concrete noun, e.g. "blue plastic cap", "white yogurt bottle". Name what stays true all ' +
    "lesson (a cup's own color, not its contents'). Never a position, a verb, or a word as " +
    'bare as "item", "object" or "container".',
  '  - `description`: one short standalone sentence of at most 30 words that the object finder ' +
    'can check against the one picture it sees: what the thing is and its color (and any text ' +
    'or symbol on it, or its state at that point in the task, when that tells it apart), then, ' +
    'always, both where it is in the picture (left or right, top or bottom, closest to the ' +
    'camera) and where it is relative to other things in view: its place among look-alikes ' +
    '("the bottom one of the three chargers", "the leftmost cup") or next to a nearby object ' +
    '("left of the laptop", "on top of the white extension block"). Never just a name. Left ' +
    'and right are as the camera sees them. Relate it to whole things in view, not to parts of ' +
    'them. No actions, no mention of steps. Good: "White charger brick at the bottom right of ' +
    'the picture, the bottom one of the three chargers, left of the laptop." and "Round blue ' +
    'plastic cap closest to the camera, the left one of the two caps on the white tank." Too ' +
    'vague: "The washer fluid cap." Too hard to check: "The white charger brick plugged into ' +
    'the lower socket of the white extension block on the gray cushion."',
  '',
  'OBJECTS',
  '- Declare every object that any step targets, acts on or checks (a look-alike that a ' +
    'mistake checks counts), and nothing else. Ids are lowercase slugs (a-z, 0-9, "_" or "-"), ' +
    'e.g. "washer_cap".',
  '- Whole things only: declare the whole thing a camera can pick out on its own, never a part ' +
    'that stays attached to it: the mini fridge, not its door, handle, shelf or freezer ' +
    'compartment; the caliper, not its scale or screw. The object finder can follow a whole ' +
    'thing, but it mistakes a part for whatever is next to it (an open door for the freezer ' +
    'compartment). Name the part in the words instead: the instruction ("Open the mini fridge ' +
    'door by its handle on the left."), the doneWhen and the show description.',
  '- `label`: a short spoken name, 1 to 3 words, e.g. "washer cap".',
  '- Object `kind`: "tool" or "container" only when the whole tool or container is meant; ' +
    '"item" otherwise.',
  '- `placement.method` is always "detect": the headset camera finds the object. Add ' +
    '`placement.hint` with where to look when it helps; it never replaces saying where in ' +
    '`tracking.query`.',
  '- `tracking.query`: written as a show `description` is, for the object as the views show ' +
    'it, e.g. "blue plastic cap with a windshield symbol, the left one of the two caps, nearest ' +
    'the camera". The finder gets only this sentence. Set ' +
    '`tracking.moves` to true for things that get picked up or carried.',
  '- `radius`: approximate size in meters (half of the largest dimension).',
  '',
  'WORKSPACE',
  '- Positions are in meters in the workspace frame: x along the near edge of the work ' +
    'surface, y up, z toward the learner (so the surface lies at z < 0). `workspace.size` is ' +
    '[width, depth].',
  '',
  'SAFETY',
  '- `warnings` start with every hazard you can see in the views, whether or not the task uses ' +
    'it. Check for each of these: sharp tools (knives, blades, scissors, needles), hot things ' +
    '(kettles, stoves, pans, irons), live electrical parts (plugged-in appliances, bare ' +
    'wires), glass that could break, harsh chemicals (bleach, cleaners, solvents) and moving ' +
    'machinery. Give one line per hazard: what it looks like, where it is, and what to do, ' +
    'e.g. "A knife with a long silver blade lies left of the cups: keep hands away from it." ' +
    'Then setup assumptions and other caveats, at most 5 lines in all.',
  '- Never plan steps that touch hot surfaces, live electrical parts or sharp blades.',
  '- If the task itself is unsafe, return a safe preparatory plan instead (for example: check, ' +
    'gather and lay out what is needed) and explain why in `warnings`.',
].join('\n');

function viewsLine(count: number, revising: boolean): string {
  if (count === 0) {
    return revising
      ? 'No camera views are attached; assume the setup is unchanged.'
      : 'No camera views are attached; assume a typical home setup.';
  }
  return count === 1
    ? "Attached: 1 current camera view from the learner's headset."
    : `Attached: ${count} current camera views from the learner's headset, numbered 1 to ${count} in order.`;
}

function goalLines(r: PlannerRequest): string[] {
  const lines = [`Goal: ${r.goal}`];
  if (r.context) lines.push(`What the learner said about their setup: ${r.context}`);
  return lines;
}

function planText(r: PlannerRequest): string {
  return [
    ...goalLines(r),
    viewsLine(r.images.length, false),
    'Write the lesson plan as JSON.',
  ].join('\n');
}

/** Stage first: the lesson starts on the answer, so the first step is the one to get right. */
function firstStageText(r: PlannerRequest): string {
  return [
    ...goalLines(r),
    viewsLine(r.images.length, false),
    'The lesson starts as soon as you answer, so answer briefly. Its later steps are written ' +
      'in full afterwards, while the learner works on the first one. So:',
    '- First read the scene: `done`, each part of the goal the views show already done, and ' +
      'what shows it (e.g. "the acid test: cup A is already pink"); `todo`, each part still ' +
      'to do, in the order the goal names them.',
    '- `outline`: every step of the lesson in order, 3 to 10, as an id and an instruction. ' +
      'It does every part in `todo`, not only the part the first step starts, and none in ' +
      '`done`, and it leaves any control untouched. outline[0] is the first step.',
    '- `objects`: only the objects the first step uses (its targets, what it shows and the ' +
      'look-alike it guards against). The later steps declare theirs when they are written. ' +
      "An object's `phrase` and `look` are all the object finder gets: write them as SHOW says " +
      'for `phrase` and `description`. The look becomes its tracking.query.',
    '- `firstStep`: that first step as a card, with the same id as outline[0]. `show` lists ' +
      'the one object id it outlines. Each mistake names the object it is made with, never one ' +
      'the step itself uses: Clio speaks its message when a hand lingers at that object. Clio ' +
      'confirms the step by its `doneWhen`.',
    'Get the first step right: it starts from the scene as it is now, it names the right ' +
      'object so that a look-alike cannot pass for it, and its doneWhen is a state the camera ' +
      'will see.',
    'Write the lesson plan as JSON.',
  ].join('\n');
}

type Revising = PlannerRequest & { revision: NonNullable<PlannerRequest['revision']> };

function stepLine(step: Revising['revision']['base']['steps'][number], n: number): string {
  const doneWhen = step.doneWhen ? ` Done when: ${step.doneWhen.replace(/[.!]+$/, '')}.` : '';
  const uses = step.targets.length ? ` Uses: ${step.targets.join(', ')}.` : '';
  return `${n}. ${step.id}: ${step.instruction}${doneWhen}${uses}`;
}

function objectLines(r: Revising): string[] {
  return r.revision.base.objects.map(
    (o) => `- ${o.id} (${o.label}): ${o.tracking?.query ?? o.description ?? o.label}`,
  );
}

function declaredObjects(r: Revising): string[] {
  return [
    'Objects already declared (reuse these ids; declare a new object only if a new step needs it):',
    ...objectLines(r),
  ];
}

function newStepsLine(kept: readonly { id: string }[], what: string): string {
  return `Return only ${what}.${
    kept.length ? ` New step ids must not be: ${kept.map((s) => s.id).join(', ')}.` : ''
  }`;
}

function revisionText(r: Revising): string {
  const { base, fromStepIndex, reason, skippedStepIds } = r.revision;
  const steps = base.steps.map((s, i) => ({
    id: s.id,
    line: `${i + 1}. ${s.id}: ${s.instruction}`,
  }));
  const kept = steps.slice(0, fromStepIndex);
  const skipped = new Set(skippedStepIds);
  const done = kept.filter((s) => !skipped.has(s.id)).map((s) => s.line);
  const notDone = kept.filter((s) => skipped.has(s.id)).map((s) => s.line);
  const replaced = steps.slice(fromStepIndex).map((s) => s.line);
  const lines = ['Revise a lesson that is in progress.', ...goalLines(r)];
  lines.push(
    `Why the plan must change: ${reason}`,
    'Steps already done (they stay as they are; do not repeat them):',
    ...(done.length ? done : ['(none)']),
  );
  if (notDone.length) {
    lines.push(
      'Steps that were skipped and NOT done (they stay in the list; plan for their outcome if ' +
        'the goal still needs it):',
      ...notDone,
    );
  }
  lines.push(
    'The rest of the old plan, which you are replacing:',
    ...(replaced.length ? replaced : ['(none)']),
    ...declaredObjects(r),
    viewsLine(r.images.length, true),
    newStepsLine(kept, 'the new remaining steps and any NEW objects'),
  );
  return lines.join('\n');
}

/**
 * Stage rest: the outline a stage "first" answer wrote quickly is the intended lesson; write its
 * steps in full now, with time to think, while the learner does the first step. Its objects were
 * quick cards too (a default kind and size), so they are written again in full, under the same
 * ids (mergeRevision's `upgrade`).
 */
function restText(r: Revising): string {
  const { base, fromStepIndex } = r.revision;
  const kept = base.steps.slice(0, fromStepIndex);
  const outline = base.steps.slice(fromStepIndex);
  return [
    'Write the rest of a lesson plan in full while the learner works on its first step.',
    ...goalLines(r),
    'Under way or done (they stay as they are; do not repeat them):',
    ...(kept.length ? kept.map((s, i) => stepLine(s, i + 1)) : ['(none)']),
    'The outline of the remaining steps, written quickly so the lesson could start. It is the ' +
      'intended shape of the lesson: write every step in full, keeping its id and its place, ' +
      'and change it only where the camera views show it is wrong, incomplete or unsafe:',
    ...(outline.length
      ? outline.map((s, i) => stepLine(s, fromStepIndex + i + 1))
      : ['(none: finish the lesson)']),
    'Objects already declared, written quickly with a default kind and size (keep these ids, ' +
      'and keep saying in each tracking.query which one it is and where):',
    ...objectLines(r),
    viewsLine(r.images.length, true),
    newStepsLine(
      kept,
      'the remaining steps, in full, and `objects`: each object above again in full, with its ' +
        'id and label, then any new object a step needs',
    ) +
      ' Write `warnings` as for a new plan, hazards in view first, without mentioning the ' +
      'outline or the step under way.',
  ].join('\n');
}

// Stage rest in parallel (plan-rest.ts): one call checks the outline, then one call per line
// writes it in full, while another writes the card's objects in full. Each writer sees the whole
// checked outline and the same table of objects, so the steps fit together and share ids.

const keptIds = (r: Revising): string[] =>
  r.revision.base.steps.slice(0, r.revision.fromStepIndex).map((s) => s.id);

/** Check the quick outline against the scene and the goal before it is written in full. */
function reviewText(r: Revising): string {
  const { base, fromStepIndex } = r.revision;
  const kept = base.steps.slice(0, fromStepIndex);
  const outline = base.steps.slice(fromStepIndex);
  const taken = [...keptIds(r), ...base.objects.map((o) => o.id)];
  return [
    'Check the outline of a lesson that has just started, before its later steps are written ' +
      'in full.',
    ...goalLines(r),
    'Under way or done (they stay as they are; do not repeat them):',
    ...(kept.length ? kept.map((s, i) => stepLine(s, i + 1)) : ['(none)']),
    'The outline of the later steps, written quickly so the lesson could start:',
    ...(outline.length
      ? outline.map((s, i) => stepLine(s, fromStepIndex + i + 1))
      : ['(none: the lesson may end after the steps above)']),
    'Objects already declared (keep these ids):',
    ...objectLines(r),
    viewsLine(r.images.length, true),
    'First read the scene and the goal:',
    '- `done`: each part of the goal the views show already done before the lesson, and what ' +
      'shows it (e.g. "the acid test: cup A is already pink"). A step under way is not done.',
    '- `todo`: each part of the goal still to do, in the order the goal names them, and none ' +
      'of those in `done`; the step under way starts one.',
    '- `control`: in an experiment that compares samples, the one the setup keeps untouched ' +
      'for comparison (when more like samples are set out than the parts left to do use); "" ' +
      'in any other task.',
    'Then write `outline`: the steps after those under way, in order, as the lesson should go on:',
    '- Keep a line, with its id, where it is right; reword, drop, split or add lines where it ' +
      'is not.',
    '- Every part in `todo` gets its steps, in order; a part in `done` gets none, here or in a ' +
      'new place; the control stays untouched. Add nothing a thing already has (indicator to a ' +
      'cup that is already purple).',
    '- Every step changes something a camera can see. No step only looks, observes, compares ' +
      'or checks: what to notice belongs to the step that causes the change.',
    '- Close what the task opened, unless the goal needs it open.',
    '- `doneWhen`: the visible end state. `uses`: the id of every object the step touches, ' +
      'shows or guards against.',
    '- `objects`: each object a line uses that is not declared above, as a card (id, label, ' +
      `phrase, look, moves). New ids must not be: ${taken.join(', ')}.`,
    '- `summary`: one sentence, what the learner does in the whole lesson as it now goes.',
    'Write the checked outline as JSON.',
  ].join('\n');
}

function restLine(line: RestLine, n: number): string {
  const doneWhen = line.doneWhen ? ` Done when: ${line.doneWhen.replace(/[.!]+$/, '')}.` : '';
  const uses = line.uses.length ? ` Uses: ${line.uses.join(', ')}.` : '';
  return `${n}. ${line.id}: ${line.instruction}${doneWhen}${uses}`;
}

/** One line of the checked outline in full, while the other lines are written beside it. */
function stepPartText(r: Revising, part: Extract<RestPart, { kind: 'step' }>): string {
  const { base, fromStepIndex } = r.revision;
  const kept = base.steps.slice(0, fromStepIndex);
  const n = fromStepIndex + part.index + 1;
  const line = part.lines[part.index];
  return [
    'Write one step of a lesson plan in full while the learner works on its first step. The ' +
      'other steps are written at the same time, each on its own, so write only this one.',
    ...goalLines(r),
    'The lesson, in order:',
    ...kept.map((s, i) => `${stepLine(s, i + 1)} (under way)`),
    ...part.lines.map(
      (l, i) =>
        `${restLine(l, fromStepIndex + i + 1)}${i === part.index ? '  <- the step to write' : ''}`,
    ),
    ...(part.reading?.done.length
      ? [`Done before the lesson: ${part.reading.done.join('; ')}`]
      : []),
    ...(part.reading?.control ? [`Kept untouched as the control: ${part.reading.control}`] : []),
    'Objects (every object the step touches, acts on, shows or checks is one of these):',
    ...part.objects.map((o) => `- ${o.id} (${o.label}): ${o.look}`),
    viewsLine(r.images.length, true),
    `Write step ${n}, "${line?.id}", in full: keep its id and what it does. Its show ` +
      'descriptions say how each object looks at that point, after the steps before it.',
    part.declare.length
      ? `Return \`step\`, and \`objects\`: ${part.declare.join(', ')} in full, each with its id and label as listed.`
      : 'Return `step`, and `objects`: [] (they are declared elsewhere).',
  ].join('\n');
}

/** The first stage's object cards in full, beside the steps, with the hazards in view. */
function objectsPartText(r: Revising): string {
  return [
    'Write the objects of a lesson plan in full while the learner works on its first step. ' +
      'They were declared quickly, with a default kind and size.',
    ...goalLines(r),
    'The lesson, in order (the later steps are an outline for now):',
    ...r.revision.base.steps.map((s, i) => stepLine(s, i + 1)),
    'Objects to write in full (keep each id and label, and keep saying in each tracking.query ' +
      'which one it is and where):',
    ...objectLines(r),
    viewsLine(r.images.length, true),
    'Return `objects`: each object above again in full, with its id and label. Write ' +
      '`warnings` as for a new plan, hazards in view first, each placed by the object of the ' +
      'task nearest to it ("left of cup A"), without mentioning the outline or the step under ' +
      'way.',
  ].join('\n');
}

function partText(r: Revising, part: RestPart): string {
  if (part.kind === 'review') return reviewText(r);
  if (part.kind === 'objects') return objectsPartText(r);
  return stepPartText(r, part);
}

function retryText(r: PlannerRequest & { retry: NonNullable<PlannerRequest['retry']> }): string {
  const lines = [
    'Your JSON did not pass validation. Fix these errors and return the complete corrected JSON:',
    r.retry.errors,
  ];
  // A review or the objects call needs no paths: its errors name what to fix.
  if (r.part) {
    if (r.part.kind === 'step') {
      lines.push(
        'Paths refer to a plan built from your answer: steps[0] is your step, and objects are ' +
          'the ones listed, with yours in full.',
      );
    }
  } else if (r.revision) {
    const { fromStepIndex, base } = r.revision;
    lines.push(
      `Paths refer to the merged plan: your first step is steps[${fromStepIndex}] and your first new object is objects[${base.objects.length}].`,
    );
  } else if (r.stage === 'first') {
    lines.push(
      'Paths refer to the plan built from your answer. steps[0] is firstStep: its show items are ' +
        "built from firstStep.show with each object's phrase and look, its mistakes from " +
        'firstStep.mistakes, and its success from firstStep.doneWhen. The later steps are the ' +
        'other outline lines, in order. objects[n] is objects[n], and its tracking.query is ' +
        'objects[n].look.',
    );
  }
  return lines.join('\n');
}

function requestText(request: PlannerRequest): string {
  const { revision } = request;
  if (revision && request.part) return partText({ ...request, revision }, request.part);
  if (revision) {
    return request.stage === 'rest'
      ? restText({ ...request, revision })
      : revisionText({ ...request, revision });
  }
  return request.stage === 'first' ? firstStageText(request) : planText(request);
}

/** The conversation for one planner call: views first, then the request; plus the retry turns. */
export function plannerContents(request: PlannerRequest): Content[] {
  const parts: Part[] = request.images.map((image) => ({
    inlineData: { mimeType: image.mimeType, data: image.data },
  }));
  parts.push({ text: requestText(request) });
  const contents: Content[] = [{ role: 'user', parts }];
  const { retry } = request;
  if (retry) {
    contents.push(
      { role: 'model', parts: [{ text: retry.previousText }] },
      { role: 'user', parts: [{ text: retryText({ ...request, retry }) }] },
    );
  }
  return contents;
}

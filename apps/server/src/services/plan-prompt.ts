import { ACTION_VERB_NAMES, ACTION_VERBS, type ActionVerb } from '@clio/protocol';
import type { Content, Part } from '@google/genai';
import type { PlannerRequest } from './planner';

// Pure: the planner's system instruction and conversation turns.

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
  'STEPS',
  '- 3 to 10 steps, in the order a person does them, with exactly one physical action per step.',
  '- `instruction`: one short imperative sentence, at most 15 words, naming the action and the ' +
    'object, e.g. "Unscrew the blue washer fluid cap." It is spoken, shown in AR, and used as ' +
    "the robot's language label.",
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
    'must be true.',
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
    'corrects it. `kind` is a lowercase label such as "wrong_cap".',
  '- `coachNotes`: a sentence or two for the coach: what to watch for and how to help.',
  '',
  'SHOW',
  '- `show`: what Clio outlines in AR during the step, most important first: the thing the ' +
    'learner acts on, then where it goes. Every step that involves an object shows at least ' +
    'one; a step with nothing to point at may show none. At most 3.',
  '- When the step starts, Clio hands each item to an object finder that sees one live camera ' +
    'frame and nothing else, and outlines what it finds. Each item must work on its own, ' +
    'without the plan, the other steps or the other items:',
  '  - `object`: the id of the declared object it is.',
  '  - `phrase`: 2 to 5 words naming it like a label on a box, e.g. "blue washer fluid cap". ' +
    'No verbs, no positions.',
  '  - `description`: one sentence of 12 to 30 words that singles it out in the frame: what it ' +
    'is, its color, material, shape and size, any text or symbols on it, and where it is ' +
    'relative to things around it, as it looks at that point in the task (after earlier ' +
    'steps, a cap may be off and lying on the fender). If something similar is nearby, say ' +
    'what tells it apart. Describe only what a camera can see. Good: "Round blue plastic cap ' +
    'with a windshield-spray symbol, on a white tank at the front left of the engine bay, ' +
    'beside a yellow cap." Too vague: "The washer fluid cap."',
  '',
  'OBJECTS',
  '- Declare every object that any step targets, acts on or checks, and nothing else. Ids are ' +
    'lowercase slugs (a-z, 0-9, "_" or "-"), e.g. "washer_cap".',
  '- `label`: a short spoken name, 1 to 3 words, e.g. "washer cap".',
  '- `placement.method` is always "detect": the headset camera finds the object. Add ' +
    '`placement.hint` with where to look when it helps.',
  "- `tracking.query`: the object's visual appearance as seen in the camera views (color, " +
    'shape, markings, where it is), e.g. "blue cap with a windshield symbol, front left". Set ' +
    '`tracking.moves` to true for things that get picked up or carried.',
  '- `radius`: approximate size in meters (half of the largest dimension).',
  '',
  'WORKSPACE',
  '- Positions are in meters in the workspace frame: x along the near edge of the work ' +
    'surface, y up, z toward the learner (so the surface lies at z < 0). `workspace.size` is ' +
    '[width, depth].',
  '',
  'SAFETY',
  '- Never plan steps that touch hot surfaces, live electrical parts or sharp blades. Put ' +
    'safety caveats and setup assumptions in `warnings`.',
  '- If the task itself is unsafe, return a safe preparatory plan instead (for example: check, ' +
    'gather and lay out what is needed) and explain why in `warnings`.',
  '',
  'Use the camera views to choose the objects that are really there and describe them as they ' +
    'look. Without views, assume a typical home setup.',
].join('\n');

function viewsLine(count: number, revising: boolean): string {
  if (count === 0) {
    return revising
      ? 'No camera views are attached; assume the setup is unchanged.'
      : 'No camera views are attached; assume a typical home setup.';
  }
  return `Attached: ${count} current camera view${count === 1 ? '' : 's'} from the learner's headset.`;
}

function planText(r: PlannerRequest): string {
  const lines = [`Goal: ${r.goal}`];
  if (r.context) lines.push(`What the learner said about their setup: ${r.context}`);
  lines.push(viewsLine(r.images.length, false), 'Write the lesson plan as JSON.');
  return lines.join('\n');
}

function revisionText(r: PlannerRequest & { revision: NonNullable<PlannerRequest['revision']> }) {
  const { base, fromStepIndex, reason } = r.revision;
  const stepLine = (s: { id: string; instruction: string }, i: number) =>
    `${i + 1}. ${s.id}: ${s.instruction}`;
  const kept = base.steps.slice(0, fromStepIndex);
  const replaced = base.steps.slice(fromStepIndex);
  const lines = ['Revise a lesson that is in progress.', `Goal: ${r.goal}`];
  if (r.context) lines.push(`What the learner said about their setup: ${r.context}`);
  lines.push(
    `Why the plan must change: ${reason}`,
    'Steps already done (they stay as they are; do not repeat them):',
    ...(kept.length ? kept.map(stepLine) : ['(none)']),
    'The rest of the old plan, which you are replacing:',
    ...(replaced.length ? replaced.map((s, i) => stepLine(s, i + fromStepIndex)) : ['(none)']),
    'Objects already declared (reuse these ids; declare a new object only if a new step needs it):',
    ...base.objects.map(
      (o) => `- ${o.id} (${o.label}): ${o.tracking?.query ?? o.description ?? o.label}`,
    ),
    viewsLine(r.images.length, true),
    'Return only the new remaining steps and any NEW objects.' +
      (kept.length ? ` New step ids must not be: ${kept.map((s) => s.id).join(', ')}.` : ''),
  );
  return lines.join('\n');
}

function retryText(r: PlannerRequest & { retry: NonNullable<PlannerRequest['retry']> }): string {
  const lines = [
    'Your JSON did not pass validation. Fix these errors and return the complete corrected JSON:',
    r.retry.errors,
  ];
  if (r.revision) {
    const { fromStepIndex, base } = r.revision;
    lines.push(
      `Paths refer to the merged plan: your first step is steps[${fromStepIndex}] and your first new object is objects[${base.objects.length}].`,
    );
  }
  return lines.join('\n');
}

/** The conversation for one planner call: views first, then the request; plus the retry turns. */
export function plannerContents(request: PlannerRequest): Content[] {
  const parts: Part[] = request.images.map((image) => ({
    inlineData: { mimeType: image.mimeType, data: image.data },
  }));
  const { revision, retry } = request;
  parts.push({ text: revision ? revisionText({ ...request, revision }) : planText(request) });
  const contents: Content[] = [{ role: 'user', parts }];
  if (retry) {
    contents.push(
      { role: 'model', parts: [{ text: retry.previousText }] },
      { role: 'user', parts: [{ text: retryText({ ...request, retry }) }] },
    );
  }
  return contents;
}

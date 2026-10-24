import type { StepCriteriaRequest } from '@clio/protocol';
import type { Content, Part } from '@google/genai';
import { isRecord, parseModelJson } from './model-json';
import type { JsonSchema } from './plan-schema';

// Pure: a step's criteria (POST /api/plans/criteria). When a step gains focus, the step watcher
// asks once for its done-when state split into a few things a camera can confirm in one view: the
// end state on the right object, how to tell that object from a look-alike, and what must stay as
// it was (the control cup that stays purple). Every look at the step then judges each criterion
// on its own (step-check.ts), so a done needs all of them, and the coach can hear which one is
// still missing. With the views from the start of the step, the criteria can name what is there.

export const MAX_CRITERIA = 4;
const MAX_CRITERION_CHARS = 200;

export const STEP_CRITERIA_INSTRUCTION = [
  'You prepare the checks a camera judge will use to tell when one step of a hands-on task is ' +
    'done. The learner wears a headset, and the judge sees what they see. You get the goal, the ' +
    "step, its done-when state, often what the step's objects look like and mistakes that look " +
    'like success, and sometimes views from the start of the step.',
  '',
  `Write 2 to ${MAX_CRITERIA} criteria. Each is one short sentence, at most 15 words, about ` +
    'something visible in a single view of the finished state. Together they say exactly what ' +
    'the done-when says, on the right object, and nothing more:',
  '- the end state, with every part the done-when names: "cup A\'s liquid is pink", "the ' +
    'yogurt drink is in the hand, off the shelf";',
  '- when a look-alike is in view or listed as a mistake, which one it must be and how to tell ' +
    'by how it looks: "the bottle in hand has a pink cap, not a blue one";',
  '- what the step must leave as it was, when doing it to the wrong object would change it: ' +
    '"cup C is still purple".',
  'Never add a condition the done-when does not state: no amounts or levels from the ' +
    'instruction ("about 5 mL"), nothing about where tools or hands are or whether something is ' +
    'still being poured or held (a learner may still hold the bottle once the step is done). ' +
    'Name objects by how they look and where they are (color, label, cap, left or right), as in ' +
    'the views from the start when there are some. Write end states, not actions: "is pink", ' +
    'not "add vinegar". Leave out what a camera cannot see, like a smell or how tight a lid is.',
].join('\n');

function criteriaText({ goal, step, objects, confusions, images }: StepCriteriaRequest): string {
  const doneWhen = step.doneWhen?.trim();
  const lines = [
    `Goal: ${goal}`,
    `Step: ${step.instruction}`,
    doneWhen ? `Done when: ${doneWhen}` : 'Done when: not given. Use the step itself.',
  ];
  if (objects?.length) {
    lines.push("The step's objects look like this:");
    for (const { label, look } of objects) {
      const seen = look.trim();
      lines.push(seen && seen !== label.trim() ? `- ${label}: ${seen}` : `- ${label}`);
    }
  }
  if (confusions?.length) {
    lines.push('Mistakes that look like success:');
    for (const c of confusions) lines.push(`- ${c.trim()}`);
  }
  const count = images?.length ?? 0;
  lines.push(
    count
      ? `Attached: ${count} view${count === 1 ? '' : 's'} from the start of the step.`
      : 'No views attached.',
    'Write the criteria.',
  );
  return lines.join('\n');
}

/** One user turn: the views from the start of the step, if any, then the step. */
export function stepCriteriaContents(request: StepCriteriaRequest): Content[] {
  const parts: Part[] = (request.images ?? []).map(({ mimeType, data }) => ({
    inlineData: { mimeType, data },
  }));
  parts.push({ text: criteriaText(request) });
  return [{ role: 'user', parts }];
}

export function stepCriteriaJsonSchema(): JsonSchema {
  return {
    type: 'object',
    properties: {
      criteria: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_CRITERIA,
        items: { type: 'string', description: 'One visible end state, at most 15 words' },
      },
    },
    required: ['criteria'],
  };
}

/** Reads the model's criteria: trimmed, without repeats, at most MAX_CRITERIA. Throws if none. */
export function parseStepCriteria(text: string): string[] {
  const json = parseModelJson(text);
  if (!json.ok) throw new Error(json.error);
  const answer = json.value;
  if (!isRecord(answer) || !Array.isArray(answer.criteria)) {
    throw new Error('The step criteria answer has no criteria');
  }
  const seen = new Set<string>();
  const criteria: string[] = [];
  for (const raw of answer.criteria) {
    if (typeof raw !== 'string') continue;
    const criterion = raw.trim().slice(0, MAX_CRITERION_CHARS);
    const key = criterion.toLowerCase();
    if (!criterion || seen.has(key)) continue;
    seen.add(key);
    criteria.push(criterion);
  }
  if (!criteria.length) throw new Error('The step criteria answer has no criteria');
  return criteria.slice(0, MAX_CRITERIA);
}

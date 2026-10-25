import type {
  FocusAction,
  FocusDetection,
  FocusObject,
  FocusRequest,
  FocusResponse,
} from '@clio/protocol';
import type { Content } from '@google/genai';
import { isRecord, parseModelJson } from './model-json';
import type { JsonSchema } from './plan-schema';
import { fromGeminiDetection, fromGeminiLocation, uniqueById } from './vision';

// Pure: the action focus (POST /api/vision/focus). Robotics-ER 2 looks at one sharp frame for the
// step under way, boxes the step's objects and says which one thing the learner should touch
// next. Its boxes anchor the live tracker, and its description of each object becomes what jev
// (a detector that sees only words) is told about it from then on, so the descriptions must
// single the object out on their own. Like the tracker's answers, this feeds the learner's view
// and the recording, never a Gemini coach (docs/coach-plan.md, the perception boundary).

export type FocusAnswer = Pick<FocusResponse, 'detections' | 'action'>;

/** Port: the smart model, looking at the step's objects in one frame. */
export interface FocusFinder {
  readonly model: string;
  focus(request: FocusRequest): Promise<FocusAnswer>;
}

/** The protocol's limits: a description is a query, a label and a phrase are names. */
export const MAX_DESCRIPTION_CHARS = 300;
export const MAX_NAME_CHARS = 60;

export const FOCUS_INSTRUCTION = [
  'You are the eyes of an AR coach. The image is what a learner sees through a headset camera ' +
    'now, while doing one step of a hands-on lesson. Clio outlines what you find and follows ' +
    'it with a fast detector that gets only words: your boxes place each object now, and your ' +
    'description of it is all the detector is told from now on.',
  '',
  '- `objects`: one entry per listed object. If it is in the image, `found` is true, `box_2d` ' +
    'is [ymin, xmin, ymax, xmax] around all of it that is visible, and `point` is the [y, x] ' +
    'of the center of its graspable part: integers from 0 to 1000, normalized to the image ' +
    'height (y) and width (x), origin at the top left. Report only the listed object itself: ' +
    'never box something else that merely looks similar or could serve the same purpose. Not ' +
    'visible means `found` false, and `box_2d`, `point` and `description` null. `confidence` ' +
    '(0 to 1) is how sure you are that it is the listed object and the box is right.',
  '- `description`, when found: one standalone sentence of at most 35 words that names this ' +
    'one object as it looks now, so that a detector given only these words finds it and ' +
    'nothing else in view: what it is, its color, material, shape and size next to a hand, ' +
    'any text or markings on it, its state (open, empty, turned pink), and where it is next ' +
    'to large things that stay put and to its neighbors ("left of the milk bottle", "behind ' +
    'cup C"), left and right as the camera sees them. Never place it by its place in the ' +
    'frame, which moves with the head. Keep what the listed words get right and correct what ' +
    'the image contradicts. No actions, no steps.',
  '- `action`: the one physical thing the learner should touch, move or operate next to do ' +
    'the step: what the hands act on, not where it goes or what holds it (to pour vinegar ' +
    'into a cup, the vinegar bottle; to take a battery out of a remote, the battery). `id` is ' +
    'its id when it is listed, and nothing else is needed. When it is not listed, `id` is null ' +
    'and you add `label` (a spoken name, 1 to 3 words), `phrase` (2 ' +
    'to 5 words a detector takes as its subject: color or material, then the noun, as it ' +
    'looks all lesson, e.g. "red reset button"; never a position or a state), `description` ' +
    '(as above), `found`, `box_2d`, `point` and `confidence`. `action` is null when the step ' +
    'needs nothing touched.',
].join('\n');

function objectLine(o: FocusObject): string {
  return `- ${o.id} (${o.label}${o.phrase ? `, ${o.phrase}` : ''}): ${o.query}`;
}

/** One user turn: the frame first, then the lesson's goal, the step and the listed objects. */
export function focusContents({ image, goal, step, objects }: FocusRequest): Content[] {
  const lines: string[] = [];
  if (goal) lines.push(`Goal: ${goal}`);
  const doneWhen = step.doneWhen?.trim();
  lines.push(`Step now: ${step.instruction}${doneWhen ? ` Done when: ${doneWhen}` : ''}`);
  lines.push(
    ...(objects.length
      ? ["Listed objects, the step's own first:", ...objects.map(objectLine)]
      : ['No objects are listed.']),
  );
  return [
    {
      role: 'user',
      parts: [
        { inlineData: { mimeType: image.mimeType, data: image.data } },
        { text: lines.join('\n') },
      ],
    },
  ];
}

/** Structured output in Gemini's spatial convention (0..1000, y first); converted when read. */
export function focusJsonSchema(ids: readonly string[]): JsonSchema {
  const coords = (length: number, description: string): JsonSchema => ({
    type: ['array', 'null'],
    items: { type: 'integer', minimum: 0, maximum: 1000 },
    minItems: length,
    maxItems: length,
    description,
  });
  const located: Record<string, JsonSchema> = {
    found: { type: 'boolean' },
    box_2d: coords(4, '[ymin, xmin, ymax, xmax], 0 to 1000'),
    point: coords(2, '[y, x] at the center of the graspable part, 0 to 1000'),
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  };
  const description: JsonSchema = {
    type: ['string', 'null'],
    description: 'One standalone sentence of at most 35 words that finds this one object alone',
  };
  const action: JsonSchema = {
    type: ['object', 'null'],
    description: 'The one thing to touch, move or operate next; null when nothing is',
    properties: {
      id: ids.length
        ? { type: ['string', 'null'], enum: [...ids, null], description: 'null when not listed' }
        : { type: 'null' },
      label: { type: 'string', description: 'Only when id is null: a spoken name, 1 to 3 words' },
      phrase: {
        type: 'string',
        description: 'Only when id is null: 2 to 5 words, e.g. "red reset button"',
      },
      description: { ...description, description: 'Only when id is null' },
      ...located,
    },
    required: ['id'],
  };
  if (!ids.length) return { type: 'object', properties: { action }, required: ['action'] };
  return {
    type: 'object',
    properties: {
      objects: {
        type: 'array',
        minItems: ids.length,
        maxItems: ids.length,
        items: {
          type: 'object',
          properties: { id: { type: 'string', enum: [...ids] }, ...located, description },
          required: ['id', 'found', 'box_2d', 'point', 'confidence', 'description'],
        },
      },
      action,
    },
    required: ['objects', 'action'],
  };
}

/** A trimmed string cut to `max` characters, or null when there are no words. */
function words(value: unknown, max: number): string | null {
  const text = typeof value === 'string' ? value.trim().slice(0, max).trim() : '';
  return text || null;
}

const rank = (d: FocusDetection) => (d.found ? 1 + d.confidence : 0);

function missing(id: string): FocusDetection {
  return { id, found: false, box: null, point: null, confidence: 0, description: null };
}

function focusDetection(raw: unknown): FocusDetection | null {
  const d = fromGeminiDetection(raw);
  if (!d || !isRecord(raw)) return null;
  const description = d.found ? words(raw.description, MAX_DESCRIPTION_CHARS) : null;
  return {
    id: d.id,
    found: d.found,
    box: d.box,
    point: d.point,
    confidence: d.confidence,
    description,
  };
}

/**
 * A listed action item takes the request's label and phrase (the learner has heard the one, and
 * a new phrase would start the tracker's track over) and its own detection's box, so the two
 * never disagree. An item the request omits needs words of its own, or it is dropped.
 */
function focusAction(
  raw: unknown,
  listed: ReadonlyMap<string, FocusObject>,
  detections: readonly FocusDetection[],
): FocusAction | null {
  if (!isRecord(raw)) return null;
  const object = typeof raw.id === 'string' ? listed.get(raw.id) : undefined;
  const seen = object && detections.find((d) => d.id === object.id);
  if (object && seen) {
    return {
      id: object.id,
      label: object.label,
      phrase: object.phrase ?? words(raw.phrase, MAX_NAME_CHARS) ?? object.label,
      description: seen.description ?? object.query,
      found: seen.found,
      box: seen.box,
      point: seen.point,
      confidence: seen.confidence,
    };
  }
  const label = words(raw.label, MAX_NAME_CHARS);
  const phrase = words(raw.phrase, MAX_NAME_CHARS);
  const description = words(raw.description, MAX_DESCRIPTION_CHARS);
  if (!label || !phrase || !description) return null;
  return { id: null, label, phrase, description, ...fromGeminiLocation(raw) };
}

/**
 * Reads the model's answer for the request's `objects`. Throws a readable Error
 * when it is not a JSON object. Every listed object gets exactly one detection, in order (one the
 * model left out is not found); ids that weren't listed are dropped; an action id that wasn't
 * listed counts as an item the request omits.
 */
export function parseFocusAnswer(text: string, objects: readonly FocusObject[]): FocusAnswer {
  const json = parseModelJson(text);
  if (!json.ok) throw new Error(json.error);
  const value = json.value;
  if (!isRecord(value)) throw new Error('The focus answer is not an object');
  const listed = new Map(uniqueById(objects).map((o) => [o.id, o]));
  const best = new Map<string, FocusDetection>();
  for (const raw of Array.isArray(value.objects) ? value.objects : []) {
    const detection = focusDetection(raw);
    if (!detection || !listed.has(detection.id)) continue;
    const current = best.get(detection.id);
    if (!current || rank(detection) > rank(current)) best.set(detection.id, detection);
  }
  const detections = [...listed.keys()].map((id) => best.get(id) ?? missing(id));
  return { detections, action: focusAction(value.action, listed, detections) };
}

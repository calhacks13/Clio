import type {
  FocusAction,
  FocusDetection,
  FocusObject,
  FocusRequest,
  FocusResponse,
  NormalizedBox,
} from '@clio/protocol';
import type { Content } from '@google/genai';
import { isRecord, parseModelJson } from './model-json';
import type { JsonSchema } from './plan-schema';
import {
  boxCenter,
  fromGeminiBox,
  fromGeminiDetection,
  fromGeminiLocation,
  uniqueById,
} from './vision';

// Pure: the action focus (POST /api/vision/focus). Robotics-ER 2 looks at one sharp frame for the
// step under way, boxes the step's objects and says which one thing the learner should touch
// next. Its boxes anchor the live tracker, and its description of each object becomes what jev
// (a detector that sees only words) is told about it from then on, so the descriptions must
// single the object out on their own. Like the tracker's answers, this feeds the learner's view
// and the recording, never a Gemini coach (docs/coach-plan.md, the perception boundary).
//
// Asked to say which of several look-alikes it means, the model left the others out of its words
// (three chargers in a row, the rightmost to unplug, described only by the cabinet beside them).
// So it boxes the look-alikes too, and the object's place among them is counted here from the
// boxes and put first in its description: "The rightmost of the three white charger blocks."

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
    'never box something else that merely looks similar or could serve the same purpose (those ' +
    'go in `look_alikes`). Not visible means `found` false, and `box_2d`, `point` and ' +
    '`description` null, and `look_alikes` empty. `confidence` (0 to 1) is how sure you are ' +
    'that it is the listed object and the box is right.',
  '- `look_alikes`, when found: the box_2d of every other thing in the image that a detector ' +
    'could take for it: the same kind of thing, such as the two other chargers in a row beside ' +
    'the one listed, or the other cups. Empty when there is none. Clio counts them to tell the ' +
    'detector which one it is ("the rightmost of the three"), so miss none.',
  '- `description`, when found: one short standalone sentence of at most 30 words that a ' +
    'detector given only these words and this picture can check at a glance: what it is and ' +
    'its color (any text or markings, or its state, such as open or turned pink, when that ' +
    'tells it apart), then, always, both where it is in this picture (left or right, top or ' +
    'bottom, closest to the camera) and where it is relative to other things in it: its place ' +
    'among look-alikes or next to a nearby object ("White charger brick at the bottom right, ' +
    'the bottom one of the three chargers, left of the laptop."), left and right as the camera ' +
    'sees them. Never just a name. ' +
    'You are asked again every few seconds, so the words follow the view. Relate it to whole ' +
    'things, not to parts of them ("plugged into the lower socket of the extension block" is ' +
    'too hard to check). Keep what the listed words get right and correct what the image ' +
    'contradicts. No actions, no steps.',
  '- `action`: the one physical thing the learner should touch, move or operate next to do ' +
    'the step: what the hands act on, not where it goes or what holds it (to pour vinegar ' +
    'into a cup, the vinegar bottle; to take a battery out of a remote, the battery). `id` is ' +
    'its id when it is listed, and nothing else is needed. When it is not listed, `id` is null ' +
    'and you add `label` (a spoken name, 1 to 3 words), `phrase` (2 ' +
    'to 5 words a detector takes as its subject: color or material, then the noun, as it ' +
    'looks all lesson, e.g. "red reset button"; never a position or a state), `description` ' +
    '(as above), `found`, `box_2d`, `point`, `confidence` and `look_alikes`. `action` is null ' +
    'when the step needs nothing touched.',
].join('\n');

/**
 * The count, asked beside the look about the step's own object: one plain question, which
 * Robotics-ER answers far better than a field of the look (that saw one other of three chargers in
 * a row, so jev was told "the bottom one of the two").
 */
export const COUNT_INSTRUCTION = [
  'You count things for an AR coach. The image is what a learner sees through a headset camera ' +
    'now. Box every thing in it that a detector looking for the named thing could box: each of ' +
    'them, and every other thing of the same kind and color, whatever its size, brand or what it ' +
    'is plugged into or sitting on, the one described included. Look over the whole image, its ' +
    'edges too, and miss none: three chargers in a row are three boxes.',
  '`count` is how many there are, and `boxes` has one box_2d for each, [ymin, xmin, ymax, xmax] ' +
    'as integers from 0 to 1000 normalized to the image height and width, origin at the top ' +
    'left. None in view: 0 and no boxes.',
].join('\n');

/** The count's one user turn: the frame, then the named thing and the one described. */
export function countContents(image: FocusRequest['image'], object: FocusObject): Content[] {
  const named = object.phrase ?? object.label;
  return [
    {
      role: 'user',
      parts: [
        { inlineData: { mimeType: image.mimeType, data: image.data } },
        { text: `Named thing: ${named}\nThe one described: ${withoutPlace(object.query)}` },
      ],
    },
  ];
}

const MAX_COUNTED = 20;

/** Structured output for the count: how many, then a box for each (count first, as it is read). */
export function countJsonSchema(): JsonSchema {
  const box: JsonSchema = {
    type: 'array',
    items: { type: 'integer', minimum: 0, maximum: 1000 },
    minItems: 4,
    maxItems: 4,
  };
  return {
    type: 'object',
    properties: {
      count: { type: 'integer', minimum: 0, maximum: MAX_COUNTED },
      boxes: { type: 'array', items: box, maxItems: MAX_COUNTED },
    },
    required: ['count', 'boxes'],
  };
}

/** The count's boxes, in our convention; none when the answer can't be read. */
export function parseCount(text: string): NormalizedBox[] {
  const json = parseModelJson(text);
  if (!json.ok || !isRecord(json.value) || !Array.isArray(json.value.boxes)) return [];
  return json.value.boxes.map(fromGeminiBox).filter((b): b is NormalizedBox => b !== null);
}

function objectLine(o: FocusObject): string {
  // Not the place an earlier look counted: this look counts again.
  return `- ${o.id} (${o.label}${o.phrase ? `, ${o.phrase}` : ''}): ${withoutPlace(o.query)}`;
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
    look_alikes: {
      type: 'array',
      items: { ...coords(4, '[ymin, xmin, ymax, xmax], 0 to 1000'), type: 'array' },
      description: 'Every other thing in the image a detector could take for it; empty when none',
    },
  };
  const description: JsonSchema = {
    type: ['string', 'null'],
    description:
      'One short sentence of at most 30 words: what it is, where it is in this picture, and next to what',
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
          required: ['id', 'found', 'box_2d', 'point', 'confidence', 'description', 'look_alikes'],
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

const COUNTS = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const ORDINALS = ['', 'first', 'second', 'third', 'fourth', 'fifth'];

/** A detector's noun phrase made plural: "white charger block" becomes "white charger blocks". */
function plural(phrase: string): string {
  const p = phrase.trim();
  if (/(s|x|z|ch|sh)$/i.test(p)) return `${p}es`;
  if (/[^aeiou]y$/i.test(p)) return `${p.slice(0, -1)}ies`;
  return `${p}s`;
}

function iou(a: NormalizedBox, b: NormalizedBox): number {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  const inter = w > 0 && h > 0 ? w * h : 0;
  const area = (r: NormalizedBox) => (r[2] - r[0]) * (r[3] - r[1]);
  const union = area(a) + area(b) - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * Where `box` sits among its look-alikes, in words a detector can follow ("the rightmost of the
 * three white charger blocks"): along the way they are spread out most, left to right or top to
 * bottom as the camera sees them, counted from the nearer end. Null without look-alikes. A box
 * that is mostly this one or another already counted (the count and the look both boxed it)
 * counts once.
 */
export function placeAmong(
  box: NormalizedBox,
  lookAlikes: readonly NormalizedBox[],
  phrase: string,
): string | null {
  const others: NormalizedBox[] = [];
  for (const b of lookAlikes) {
    if (iou(b, box) < 0.5 && others.every((o) => iou(b, o) < 0.5)) others.push(b);
  }
  if (others.length === 0) return null;
  const centers = [box, ...others].map(boxCenter);
  const n = centers.length;
  const spread = (axis: 0 | 1) => {
    const values = centers.map((c) => c[axis]);
    return Math.max(...values) - Math.min(...values);
  };
  const across = spread(0) >= spread(1);
  const axis = across ? 0 : 1;
  const at = boxCenter(box)[axis];
  const i = centers.filter((c) => c[axis] < at).length;
  const [first, last] = across ? ['left', 'right'] : ['top', 'bottom'];
  const group = `the ${COUNTS[n] ?? n} ${plural(phrase)}`;
  if (n === 2) return `the ${i === 0 ? first : last} one of ${group}`;
  if (i === 0) return across ? `the leftmost of ${group}` : `the top one of ${group}`;
  if (i === n - 1) return across ? `the rightmost of ${group}` : `the bottom one of ${group}`;
  if (n === 3) return `the middle one of ${group}`;
  const fromFirst = i < n - 1 - i;
  const k = fromFirst ? i + 1 : n - i;
  return `the ${ORDINALS[k] ?? `${k}th`} from the ${fromFirst ? first : last} of ${group}`;
}

/** The sentence placeAmong's words make, as it leads a description: "The bottom one of the two …." */
const PLACE_SENTENCE =
  /^The (?:leftmost|rightmost|middle one|top one|bottom one|left one|right one|(?:first|second|third|fourth|fifth|\d+th) from the (?:left|right|top|bottom)) of the (?:two|three|four|five|six|seven|eight|nine|ten|\d+) [^.,]*\.\s*/i;

/** Words without the place sentence an earlier look put first: its count may be out of date. */
export function withoutPlace(text: string): string {
  return text.replace(PLACE_SENTENCE, '');
}

/** The model's look-alike boxes, in our convention. */
function lookAlikes(raw: Record<string, unknown>): NormalizedBox[] {
  const boxes = Array.isArray(raw.look_alikes) ? raw.look_alikes : [];
  return boxes.map(fromGeminiBox).filter((b): b is NormalizedBox => b !== null);
}

/** The description with the object's place among its look-alikes first (and only once). */
function placed(
  description: string | null,
  box: NormalizedBox | null,
  boxes: readonly NormalizedBox[],
  phrase: string,
): string | null {
  const place = box && placeAmong(box, boxes, phrase);
  const said = description && (withoutPlace(description) || null);
  if (!place || said?.toLowerCase().includes(place)) return said;
  const sentence = `${place[0]?.toUpperCase()}${place.slice(1)}.`;
  return words(said ? `${sentence} ${said}` : sentence, MAX_DESCRIPTION_CHARS);
}

function focusDetection(
  raw: unknown,
  listed: ReadonlyMap<string, FocusObject>,
  counted: ReadonlyMap<string, readonly NormalizedBox[]>,
): FocusDetection | null {
  const d = fromGeminiDetection(raw);
  if (!d || !isRecord(raw)) return null;
  const object = listed.get(d.id);
  const said = d.found ? words(raw.description, MAX_DESCRIPTION_CHARS) : null;
  const phrase = object?.phrase ?? object?.label ?? d.id;
  // The count's boxes first: it looked for every one; the look's look-alikes add any it missed.
  const boxes = [...(counted.get(d.id) ?? []), ...lookAlikes(raw)];
  return {
    id: d.id,
    found: d.found,
    box: d.box,
    point: d.point,
    confidence: d.confidence,
    description: d.found ? placed(said, d.box, boxes, phrase) : null,
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
  const said = words(raw.description, MAX_DESCRIPTION_CHARS);
  if (!label || !phrase || !said) return null;
  const location = fromGeminiLocation(raw);
  const description = placed(said, location.box, lookAlikes(raw), phrase) ?? said;
  return { id: null, label, phrase, description, ...location };
}

/**
 * Reads the model's answer for the request's `objects`. Throws a readable Error
 * when it is not a JSON object. Every listed object gets exactly one detection, in order (one the
 * model left out is not found); ids that weren't listed are dropped; an action id that wasn't
 * listed counts as an item the request omits. `counted`: the count's boxes, by object id.
 */
export function parseFocusAnswer(
  text: string,
  objects: readonly FocusObject[],
  counted: ReadonlyMap<string, readonly NormalizedBox[]> = new Map(),
): FocusAnswer {
  const json = parseModelJson(text);
  if (!json.ok) throw new Error(json.error);
  const value = json.value;
  if (!isRecord(value)) throw new Error('The focus answer is not an object');
  const listed = new Map(uniqueById(objects).map((o) => [o.id, o]));
  const best = new Map<string, FocusDetection>();
  for (const raw of Array.isArray(value.objects) ? value.objects : []) {
    const detection = focusDetection(raw, listed, counted);
    if (!detection || !listed.has(detection.id)) continue;
    const current = best.get(detection.id);
    if (!current || rank(detection) > rank(current)) best.set(detection.id, detection);
  }
  const detections = [...listed.keys()].map((id) => best.get(id) ?? missing(id));
  return { detections, action: focusAction(value.action, listed, detections) };
}

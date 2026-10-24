import type { SceneAskRequest, SceneAskResponse, SceneRef } from '@clio/protocol';
import type { Content, Part } from '@google/genai';
import { isRecord, parseModelJson } from './model-json';
import type { JsonSchema } from './plan-schema';
import { boxCenter, fromGeminiBox, fromGeminiPoint } from './vision';

// Pure: a closer look (POST /api/scene/ask). The voice coach (the realtime Live model) sees a
// blurry frame every few seconds; when it needs a sharp look it calls look_closer, and the headset
// asks the smart model here about fresh camera views. The answer goes back to the voice as text,
// which it says in its own words. The points are for the AR layer only: the coach never hears
// coordinates (docs/coach-plan.md, the perception boundary).

export type SceneAnswer = Pick<SceneAskResponse, 'hazard' | 'answer' | 'refs'>;

/** Port: the smart model, asked about what the camera sees. */
export interface SceneAsker {
  readonly model: string;
  ask(request: SceneAskRequest): Promise<SceneAnswer>;
}

/** The answer reaches the learner through the voice, so it stays short. */
export const MAX_ANSWER_CHARS = 300;
export const MAX_HAZARD_CHARS = 160;
export const MAX_REFS = 3;

export const SCENE_INSTRUCTION = [
  'You are the eyes of a voice tutor. The learner wears a headset camera, so the views show what ' +
    'they see, newest last. The tutor only gets a blurry glance every few seconds, so it asks you ' +
    'when it needs a sharp look: which object is which, where something is, whether something is ' +
    'safe, what went wrong, how to hold or use something.',
  '',
  '- `hazard`: first, whatever the question, look for a danger to the learner right now: something ' +
    'sharp, hot, spilled or unstable near their hands or where they work. Name it and where it ' +
    'is in a few words, or leave it empty when there is none.',
  '- `answer`: at most two short sentences of plain facts, which the tutor will put in its own ' +
    'words. Say where things are as the learner sees them (left, right, in front, in your hand), ' +
    'never as numbers. If the views do not show what was asked, say so, and what would help (for ' +
    'example "look further left"). Never guess.',
  `- \`refs\`: the things your answer points out, at most ${MAX_REFS}, located in the newest view. ` +
    '`id` is the material id when it is one of the listed materials, else null. `point` is the ' +
    '[y, x] of its center and `box_2d` is [ymin, xmin, ymax, xmax], integers from 0 to 1000, ' +
    'with the origin at the top left. Leave refs empty when the answer points at nothing visible.',
].join('\n');

function askText({ question, goal, step, objects, images }: SceneAskRequest): string {
  const lines: string[] = [];
  if (goal) lines.push(`Goal: ${goal}`);
  if (step) {
    const doneWhen = step.doneWhen?.trim();
    lines.push(`Step now: ${step.instruction}${doneWhen ? ` Done when: ${doneWhen}` : ''}`);
  }
  if (objects?.length) {
    lines.push(
      'Materials:',
      ...objects.map((o) => `- ${o.id}: ${o.label}${o.look ? ` (${o.look})` : ''}`),
    );
  }
  const count = images.length;
  lines.push(
    `Attached: ${count} camera view${count === 1 ? '' : 's'} from the learner's headset, newest last.`,
    `Question: ${question}`,
  );
  return lines.join('\n');
}

/** One user turn: the views first, then the lesson context and the question. */
export function sceneContents(request: SceneAskRequest): Content[] {
  const parts: Part[] = request.images.map((image) => ({
    inlineData: { mimeType: image.mimeType, data: image.data },
  }));
  parts.push({ text: askText(request) });
  return [{ role: 'user', parts }];
}

/** Structured output. Gemini has no maxLength, so the answer's limit is in words. */
export function sceneJsonSchema(): JsonSchema {
  const coords = (length: number, description: string): JsonSchema => ({
    type: 'array',
    items: { type: 'integer', minimum: 0, maximum: 1000 },
    minItems: length,
    maxItems: length,
    description,
  });
  return {
    type: 'object',
    properties: {
      hazard: {
        type: 'string',
        description: 'A danger near their hands or work, in a few words, or empty',
      },
      answer: {
        type: 'string',
        description: 'At most two short sentences (about 35 words), no coordinates',
      },
      refs: {
        type: 'array',
        maxItems: MAX_REFS,
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'What it is, in a few words' },
            id: { type: ['string', 'null'], description: 'A material id, or null' },
            point: coords(2, '[y, x] at its center, 0 to 1000'),
            box_2d: coords(4, '[ymin, xmin, ymax, xmax], 0 to 1000'),
          },
          required: ['label', 'id', 'point', 'box_2d'],
        },
      },
    },
    required: ['hazard', 'answer', 'refs'],
  };
}

/** Bracketed number lists, in case the model put a coordinate in the words the coach hears. */
const COORDINATES = /\s*\[\s*\d+(?:\.\d+)?(?:\s*,\s*\d+(?:\.\d+)?){1,3}\s*\]/g;
const words = (text: string, max: number) => text.replace(COORDINATES, '').trim().slice(0, max);

/**
 * Reads the model's answer. Throws a readable Error when it is not JSON or has no answer. Refs
 * without a usable point are dropped, and an id that isn't one of `objectIds` becomes null.
 */
export function parseSceneAnswer(text: string, objectIds: readonly string[]): SceneAnswer {
  const json = parseModelJson(text);
  if (!json.ok) throw new Error(json.error);
  const value = json.value;
  if (!isRecord(value)) throw new Error('The closer look answer is not an object');
  if (typeof value.answer !== 'string' || !value.answer.trim()) {
    throw new Error('The closer look answer has no answer');
  }
  const known = new Set(objectIds);
  const refs: SceneRef[] = [];
  for (const raw of Array.isArray(value.refs) ? value.refs : []) {
    if (!isRecord(raw) || refs.length >= MAX_REFS) continue;
    const box = fromGeminiBox(raw.box_2d);
    const point = fromGeminiPoint(raw.point) ?? (box && boxCenter(box));
    if (!point) continue;
    const label = typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : 'object';
    const objectId = typeof raw.id === 'string' && known.has(raw.id) ? raw.id : null;
    refs.push({ label, objectId, point, box });
  }
  const hazard = typeof value.hazard === 'string' ? words(value.hazard, MAX_HAZARD_CHARS) : '';
  return {
    hazard: hazard || null,
    answer: words(value.answer, MAX_ANSWER_CHARS),
    refs,
  };
}

import type { Detection, LocateRequest } from '@clio/protocol';
import { type GenerateContentApi, thinkingConfig } from './gemini';
import { generateJson } from './gemini-planner';
import { isRecord, parseModelJson } from './model-json';
import type { JsonSchema } from './plan-schema';
import { fromGeminiDetection, type VisionLocator } from './vision';

// Object grounding with Gemini: one image plus a list of { id, query, phrase? }, answered through
// structured output in Gemini's native spatial convention (0..1000, y first), then converted.
// Gemini returns points and boxes; outlines come from a segmenting finder (CLIO_VISION_URL).
// On Robotics-ER 2 pointing is as accurate at minimal thinking as at high, in about a second, but
// it will point at a look-alike unless told an absent object is an answer too (docs/robotics-er.md).

/** One look. The headset looks again a few seconds later, so a slow answer is dropped. */
export const LOCATE_TIMEOUT_MS = 10_000;

type LocateObject = LocateRequest['objects'][number];

function uniqueById(objects: readonly LocateObject[]): LocateObject[] {
  const seen = new Set<string>();
  return objects.filter((o) => !seen.has(o.id) && seen.add(o.id));
}

export function locatePrompt(objects: readonly LocateObject[]): string {
  return [
    'Find each of these objects in the image:',
    ...objects.map((o) => `- ${o.id}${o.phrase ? ` (${o.phrase})` : ''}: ${o.query}`),
    '',
    'Return one entry per id. If the object is visible, set found to true, point to the [y, x] ' +
      'of the center of the visible, graspable part of the object, and box_2d to ' +
      '[ymin, xmin, ymax, xmax] around the visible object. Coordinates are integers from 0 to ' +
      '1000, normalized to the image height (y) and width (x), with the origin at the top left. ' +
      'If the object is not visible, set found to false and point and box_2d to null. Only ' +
      'report an object that is really in the image: never point at something else that just ' +
      'looks similar or could serve the same purpose. ' +
      'confidence is how sure you are, from 0 to 1, that the location is right.',
  ].join('\n');
}

export function locateJsonSchema(ids: readonly string[]): JsonSchema {
  const coords = (length: number, description: string): JsonSchema => ({
    type: ['array', 'null'],
    items: { type: 'integer', minimum: 0, maximum: 1000 },
    minItems: length,
    maxItems: length,
    description,
  });
  return {
    type: 'array',
    minItems: ids.length,
    maxItems: ids.length,
    items: {
      type: 'object',
      properties: {
        id: { type: 'string', enum: [...ids] },
        found: { type: 'boolean' },
        point: coords(2, '[y, x] at the center of the graspable part, 0 to 1000'),
        box_2d: coords(4, '[ymin, xmin, ymax, xmax], 0 to 1000'),
        confidence: { type: 'number', minimum: 0, maximum: 1 },
      },
      required: ['id', 'found', 'point', 'box_2d', 'confidence'],
    },
  };
}

export function createGeminiLocator(ai: GenerateContentApi, model: string): VisionLocator {
  return {
    async locate(request) {
      const objects = uniqueById(request.objects);
      const text = await generateJson(
        ai,
        {
          model,
          contents: [
            {
              role: 'user',
              parts: [
                { inlineData: { mimeType: request.image.mimeType, data: request.image.data } },
                { text: locatePrompt(objects) },
              ],
            },
          ],
          config: {
            responseMimeType: 'application/json',
            responseJsonSchema: locateJsonSchema(objects.map((o) => o.id)),
            ...thinkingConfig(model, 'minimal'),
          },
        },
        LOCATE_TIMEOUT_MS,
      );
      const json = parseModelJson(text);
      if (!json.ok) throw new Error(json.error);
      const entries = Array.isArray(json.value)
        ? json.value
        : isRecord(json.value) && Array.isArray(json.value.detections)
          ? json.value.detections
          : [];
      const detections = entries.map(fromGeminiDetection).filter((d): d is Detection => d !== null);
      return { detections, model };
    },
  };
}

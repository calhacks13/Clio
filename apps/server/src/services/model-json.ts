import { describeError } from '../log';

// Reading JSON that a model wrote. Structured output is raw JSON, but tolerate a markdown fence.

export type Json = Record<string, unknown>;

export const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function parseModelJson(
  text: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  const unfenced = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  try {
    return { ok: true, value: JSON.parse(unfenced) };
  } catch (error) {
    return { ok: false, error: `The response was not valid JSON: ${describeError(error)}` };
  }
}

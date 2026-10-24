import type { Context, MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { z } from 'zod';
import { invalidId, invalidJson, payloadTooLarge, validationFailed } from '../errors';
import { isSafeId } from '../ids';

// Small request helpers shared by the route modules.

/** Rejects bodies over `maxBytes` with a 413 ApiError (checked while the body streams in). */
export function limitBody(maxBytes: number): MiddlewareHandler {
  return bodyLimit({
    maxSize: maxBytes,
    onError: () => {
      throw payloadTooLarge(maxBytes);
    },
  });
}

/** Parses the JSON body with `schema`. An empty body counts as `{}` when `emptyAsObject`. */
export async function parseBody<S extends z.ZodType>(
  c: Context,
  schema: S,
  what: string,
  { emptyAsObject = false } = {},
): Promise<z.output<S>> {
  const text = await c.req.text();
  let raw: unknown;
  if (emptyAsObject && text.trim() === '') {
    raw = {};
  } else {
    try {
      raw = JSON.parse(text);
    } catch {
      throw invalidJson();
    }
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw validationFailed(what, parsed.error);
  return parsed.data;
}

/** A path parameter (or body field) that will become part of a file path. */
export function safeId(value: string | undefined, what: string): string {
  if (value === undefined || !isSafeId(value)) throw invalidId(what);
  return value;
}

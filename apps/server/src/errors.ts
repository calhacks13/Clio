import type { ApiError as ApiErrorBody } from '@clio/protocol';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { z } from 'zod';

// Every non-2xx response has the `ApiErrorSchema` body: { error: { code, message, details? } }.
// Routes throw these; the app's error handler turns them into responses.

export class ApiError extends Error {
  override name = 'ApiError';

  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }

  toBody(): ApiErrorBody {
    return errorBody(this.code, this.message, this.details);
  }
}

export function errorBody(code: string, message: string, details?: unknown): ApiErrorBody {
  return { error: details === undefined ? { code, message } : { code, message, details } };
}

const MAX_ISSUES = 50;

/** 400 with each zod issue as `{ path, message }`; the message names the first few. */
export function validationFailed(what: string, error: z.ZodError): ApiError {
  const issues = error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
  const shown = issues
    .slice(0, 3)
    .map((i) => `${i.path || '(root)'}: ${i.message}`)
    .join('; ');
  const more = issues.length > 3 ? ` (+${issues.length - 3} more)` : '';
  return new ApiError(400, 'validation_failed', `Invalid ${what}: ${shown}${more}`, {
    issues: issues.slice(0, MAX_ISSUES),
  });
}

export const invalidJson = () =>
  new ApiError(400, 'invalid_json', 'The request body is not valid JSON');

export const invalidId = (what: string) =>
  new ApiError(400, 'invalid_id', `Invalid ${what}: use letters, digits, ".", "_" or "-"`);

export const invalidName = (what: string) =>
  new ApiError(400, 'invalid_name', `Invalid ${what}: use letters, digits, ".", "_" or "-"`);

export const notFound = (message: string) => new ApiError(404, 'not_found', message);

export const payloadTooLarge = (maxBytes: number) =>
  new ApiError(413, 'payload_too_large', `The request body is larger than ${maxBytes} bytes`);

export const geminiNotConfigured = (feature: string) =>
  new ApiError(
    503,
    'gemini_not_configured',
    `${feature} is off: GEMINI_API_KEY is not set on the server`,
  );

export const upstreamFailed = (message: string, details?: unknown) =>
  new ApiError(502, 'upstream_failed', message, details);

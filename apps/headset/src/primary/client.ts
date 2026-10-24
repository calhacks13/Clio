import {
  ApiErrorSchema,
  type PrimaryRequest,
  type PrimaryResponse,
  PrimaryResponseSchema,
} from '@clio/protocol';
import { ApiRequestError } from '../adapters/net/api-client';

// POST /api/vision/primary: the server names the main object in a camera frame and outlines it.
// The answer is validated against the shared contract, like every ApiClient call.

export const PRIMARY_PATH = '/api/vision/primary';

export class PrimaryClient {
  constructor(
    private readonly base = '',
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  async ask(request: PrimaryRequest, signal?: AbortSignal): Promise<PrimaryResponse> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.base + PRIMARY_PATH, {
        method: 'POST',
        body: JSON.stringify(request),
        headers: { 'content-type': 'application/json' },
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      throw new ApiRequestError(
        `Network error: ${err instanceof Error ? err.message : String(err)}`,
        null,
        'network',
      );
    }
    if (!res.ok) {
      const body = ApiErrorSchema.safeParse(await res.json().catch(() => null));
      throw new ApiRequestError(
        body.success ? body.data.error.message : `${res.status} ${res.statusText}`.trim(),
        res.status,
        body.success ? body.data.error.code : 'http_error',
      );
    }
    return PrimaryResponseSchema.parse(await res.json());
  }
}

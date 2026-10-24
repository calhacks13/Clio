import {
  ApiErrorSchema,
  ApiPaths,
  type CoachTokenResponse,
  CoachTokenResponseSchema,
  type DemoClip,
  DemoClipSchema,
  type EpisodeBatchInput,
  EpisodeBatchResponseSchema,
  type EpisodeCreate,
  EpisodeCreateResponseSchema,
  type EpisodeFinish,
  EpisodeFinishResponseSchema,
  type HealthResponse,
  HealthResponseSchema,
  type LocateRequest,
  type LocateResponse,
  LocateResponseSchema,
  type PlanRequest,
  type PlanResponse,
  PlanResponseSchema,
  type Procedure,
  type ProcedureListResponse,
  ProcedureListResponseSchema,
  ProcedureSchema,
} from '@clio/protocol';
import type { z } from 'zod';

// Typed client for the laptop server. Every response is validated against the shared contract,
// so a server/headset mismatch fails loudly here instead of corrupting state.

export class ApiRequestError extends Error {
  override name = 'ApiRequestError';
  constructor(
    message: string,
    /** HTTP status, or null when the request never got a response. */
    readonly status: number | null,
    readonly code: string,
  ) {
    super(message);
  }
}

/** The server has an access key (CLIO_ACCESS_KEY) and this page was opened without ?key=…. */
export const isAccessDenied = (err: unknown): boolean =>
  err instanceof ApiRequestError && err.status === 401;

export class ApiClient {
  constructor(
    private readonly base = '',
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  health(): Promise<HealthResponse> {
    return this.request('GET', ApiPaths.health, undefined, HealthResponseSchema);
  }

  procedures(): Promise<ProcedureListResponse> {
    return this.request('GET', ApiPaths.procedures, undefined, ProcedureListResponseSchema);
  }

  procedure(id: string): Promise<Procedure> {
    return this.request('GET', ApiPaths.procedure(id), undefined, ProcedureSchema);
  }

  plan(request: PlanRequest): Promise<PlanResponse> {
    return this.request('POST', ApiPaths.plans, request, PlanResponseSchema);
  }

  locate(request: LocateRequest): Promise<LocateResponse> {
    return this.request('POST', ApiPaths.visionLocate, request, LocateResponseSchema);
  }

  coachToken(model?: string): Promise<CoachTokenResponse> {
    return this.request(
      'POST',
      ApiPaths.coachToken,
      model ? { model } : {},
      CoachTokenResponseSchema,
    );
  }

  async createEpisode(meta: EpisodeCreate): Promise<string> {
    return (await this.request('POST', ApiPaths.episodes, meta, EpisodeCreateResponseSchema))
      .episodeId;
  }

  async appendBatch(episodeId: string, batch: EpisodeBatchInput): Promise<void> {
    await this.request(
      'POST',
      ApiPaths.episodeBatches(episodeId),
      batch,
      EpisodeBatchResponseSchema,
    );
  }

  async finishEpisode(episodeId: string, finish: EpisodeFinish): Promise<void> {
    await this.request(
      'POST',
      ApiPaths.episodeFinish(episodeId),
      finish,
      EpisodeFinishResponseSchema,
    );
  }

  /** A recorded demo clip, or null if none exists for this step. */
  async clip(procedureId: string, stepId: string): Promise<DemoClip | null> {
    try {
      return await this.request(
        'GET',
        ApiPaths.clip(procedureId, stepId),
        undefined,
        DemoClipSchema,
      );
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 404) return null;
      throw err;
    }
  }

  async putMedia(episodeId: string, name: string, body: Blob): Promise<void> {
    const res = await this.send('PUT', ApiPaths.episodeMedia(episodeId, name), body, body.type);
    if (!res.ok) throw await this.failure(res);
  }

  private async request<T>(
    method: string,
    path: string,
    body: unknown,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const res = await this.send(
      method,
      path,
      body === undefined ? undefined : JSON.stringify(body),
      'application/json',
    );
    if (!res.ok) throw await this.failure(res);
    return schema.parse(await res.json());
  }

  private async send(
    method: string,
    path: string,
    body: BodyInit | undefined,
    contentType: string,
  ): Promise<Response> {
    try {
      return await this.fetchImpl(this.base + path, {
        method,
        ...(body === undefined ? {} : { body, headers: { 'content-type': contentType } }),
      });
    } catch (err) {
      throw new ApiRequestError(
        `Network error: ${err instanceof Error ? err.message : String(err)}`,
        null,
        'network',
      );
    }
  }

  private async failure(res: Response): Promise<ApiRequestError> {
    let parsed: z.infer<typeof ApiErrorSchema> | null = null;
    try {
      const r = ApiErrorSchema.safeParse(await res.json());
      if (r.success) parsed = r.data;
    } catch {
      // not JSON
    }
    return new ApiRequestError(
      parsed?.error.message ?? `${res.status} ${res.statusText}`.trim(),
      res.status,
      parsed?.error.code ?? 'http_error',
    );
  }
}

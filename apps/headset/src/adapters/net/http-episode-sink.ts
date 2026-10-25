import type { EpisodeBatchInput, EpisodeCreate, EpisodeFinish } from '@clio/protocol';
import { type EpisodeSink, SinkError } from '../../domain/recording/sink';
import { type ApiClient, ApiRequestError } from './api-client';

/** No response, a server error, a timeout or rate limiting: worth retrying. A 4xx is not. */
const retriable = (status: number | null) =>
  status === null || status >= 500 || status === 408 || status === 429;

async function delivering<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApiRequestError) throw new SinkError(err.message, retriable(err.status));
    throw new SinkError(err instanceof Error ? err.message : String(err), true);
  }
}

/** EpisodeSink over the laptop server's HTTP API. */
export class HttpEpisodeSink implements EpisodeSink {
  constructor(private readonly api: ApiClient) {}

  create(meta: EpisodeCreate): Promise<string> {
    return delivering(() => this.api.createEpisode(meta));
  }

  append(episodeId: string, batch: EpisodeBatchInput): Promise<void> {
    return delivering(() => this.api.appendBatch(episodeId, batch));
  }

  putMedia(episodeId: string, name: string, body: Blob): Promise<void> {
    return delivering(() => this.api.putMedia(episodeId, name, body));
  }

  finish(episodeId: string, finish: EpisodeFinish): Promise<void> {
    return delivering(() => this.api.finishEpisode(episodeId, finish));
  }
}

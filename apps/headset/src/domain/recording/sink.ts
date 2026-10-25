import {
  type EpisodeBatch,
  type EpisodeBatchInput,
  EpisodeBatchSchema,
  type EpisodeCreate,
  type EpisodeFinish,
} from '@clio/protocol';

/** Port: where episodes go (the laptop server in production). */
export interface EpisodeSink {
  /** Creates the episode and returns the id the server assigned. */
  create(meta: EpisodeCreate): Promise<string>;
  append(episodeId: string, batch: EpisodeBatchInput): Promise<void>;
  /** Stores a file in the episode's media/ (a room scan GLB, a keyframe JPEG). */
  putMedia(episodeId: string, name: string, body: Blob): Promise<void>;
  finish(episodeId: string, finish: EpisodeFinish): Promise<void>;
}

/** A failed delivery. `retriable` is false when retrying cannot help (e.g. a 400). */
export class SinkError extends Error {
  override name = 'SinkError';
  constructor(
    message: string,
    readonly retriable: boolean,
  ) {
    super(message);
  }
}

export interface StoredEpisode {
  id: string;
  meta: EpisodeCreate;
  batches: EpisodeBatch[];
  /** media/<name>, in the order they arrived. */
  media: Map<string, Blob>;
  finish: EpisodeFinish | null;
}

/** The server's rule for media names (apps/server/src/ids.ts): no slashes, dots first or "..". */
const SAFE_MEDIA_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** In-memory sink for tests, offline runs and synthetic episodes. Validates like the server. */
export class MemoryEpisodeSink implements EpisodeSink {
  readonly episodes = new Map<string, StoredEpisode>();
  private counter = 0;

  async create(meta: EpisodeCreate): Promise<string> {
    const id = `mem-${++this.counter}`;
    this.episodes.set(id, { id, meta, batches: [], media: new Map(), finish: null });
    return id;
  }

  async append(episodeId: string, batch: EpisodeBatchInput): Promise<void> {
    this.get(episodeId).batches.push(EpisodeBatchSchema.parse(batch));
  }

  async putMedia(episodeId: string, name: string, body: Blob): Promise<void> {
    if (!SAFE_MEDIA_NAME.test(name)) throw new SinkError(`invalid media name ${name}`, false);
    this.get(episodeId).media.set(name, body);
  }

  async finish(episodeId: string, finish: EpisodeFinish): Promise<void> {
    this.get(episodeId).finish = finish;
  }

  /** The single stored episode (test convenience). */
  only(): StoredEpisode {
    const [first, ...rest] = this.episodes.values();
    if (!first || rest.length > 0)
      throw new Error(`expected 1 episode, have ${this.episodes.size}`);
    return first;
  }

  private get(id: string): StoredEpisode {
    const ep = this.episodes.get(id);
    if (!ep) throw new SinkError(`unknown episode ${id}`, false);
    return ep;
  }
}

import type { EpisodeDetailResponse, EpisodeEvent, EpisodeSummary, Vec3 } from '@clio/protocol';
import { episodeTails, getEpisode, listEpisodes } from './api';
import { detectionOutline } from './detection-outline';
import {
  type Detection,
  EpisodeData,
  episodeDuration,
  isRecording,
  upperBound,
} from './episode-data';
import { type LogEntry, logEntry } from './event-log';
import {
  byId,
  EpisodeList,
  type EpisodeRow,
  LessonPanel,
  Timeline,
  type TimelineMark,
} from './panel';
import { EpisodeScene } from './scene';

// The laptop viewer (/viewer.html): replays a recorded episode, or follows one live while the
// headset uploads it over the cable. Episodes are listed newest first and the newest opens by
// itself. An unfinished episode is polled for new lines every half second (only the bytes appended
// since the last read), and the view follows its newest frame until the user scrubs.

const LIST_EVERY_MS = 2000;
const POLL_EVERY_MS = 500;
const TRAIL_MS = 3000;
/** An unfinished episode counts as live while its line counts grew this recently. */
const LIVE_GROWTH_MS = 15_000;
const DEFAULT_WORKSPACE: [number, number] = [0.6, 0.4];

interface Session {
  id: string;
  detail: EpisodeDetailResponse;
  data: EpisodeData;
  tails: ReturnType<typeof episodeTails>;
  abort: AbortController;
  t: number;
  following: boolean;
  playing: boolean;
  /** Bumped whenever new records arrive, so derived views know to refresh. */
  version: number;
  marks: { version: number; marks: TimelineMark[] };
}

const scene = new EpisodeScene(byId('view'));
const list = new EpisodeList(byId('episode-list'), byId('list-note'), (id) => {
  followNewest = id === episodes?.[0]?.episodeId;
  void open(id);
});
const panel = new LessonPanel(byId('title'), byId('step-index'), byId('instruction'), byId('log'));
const timeline = new Timeline(
  {
    play: byId('play'),
    live: byId('live'),
    scrub: byId('scrub'),
    fill: byId('fill'),
    marks: byId('marks'),
    clock: byId('clock'),
    duration: byId('duration'),
  },
  { scrub, togglePlay, goLive },
);

/** Null until the first listing arrives. */
let episodes: EpisodeSummary[] | null = null;
/** Open each new episode as it appears, until the user picks an older one. */
let followNewest = true;
let session: Session | null = null;
let opening: { id: string; abort: AbortController } | null = null;
/** Per episode: its line count at the last listing, and when that count last changed. */
const growth = new Map<string, { lines: number; at: number }>();
const logCache = new WeakMap<EpisodeEvent, LogEntry | null>();
const outlineCache = new WeakMap<Detection, Vec3[]>();
let panelKey = '';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const latest = (s: Session) => s.data.lastFrameT ?? s.data.endT;
const finished = (s: Session) => s.detail.summary.finished;

async function open(id: string): Promise<void> {
  // The address names an episode only when the user picked it: a reload while following the newest
  // has to keep following.
  history.replaceState(
    null,
    '',
    followNewest ? location.pathname : `?episode=${encodeURIComponent(id)}`,
  );
  if (session?.id === id || opening?.id === id) return;
  session?.abort.abort();
  opening?.abort.abort();
  session = null;
  const abort = new AbortController();
  opening = { id, abort };
  scene.reset();
  panelKey = '';
  panel.setTitle('Loading');
  panel.setStep(null, null);
  panel.setLog([]);
  try {
    const detail = await getEpisode(id, abort.signal);
    const s: Session = {
      id,
      detail,
      data: new EpisodeData(detail.meta),
      tails: episodeTails(id),
      abort,
      t: 0,
      following: !detail.summary.finished,
      playing: false,
      version: 0,
      marks: { version: -1, marks: [] },
    };
    await readNew(s);
    if (abort.signal.aborted) return;
    opening = null;
    session = s;
    s.t = s.following ? latest(s) : (s.data.frames[0]?.t ?? 0);
    scene.setWorkspace(detail.meta.plan?.workspace.size ?? DEFAULT_WORKSPACE);
    panel.setTitle(detail.meta.procedure?.title ?? 'Free recording');
    renderList();
    if (!finished(s)) void poll(s);
  } catch (err) {
    if (abort.signal.aborted) return;
    opening = null;
    panel.setTitle('Could not open this episode');
    console.warn(`viewer: episode ${id}`, err);
  }
}

/**
 * Reads what each channel gained since the last read. Each channel keeps what it got even when
 * another fails (a tail has already moved past its records); the failed one is read again next time.
 */
async function readNew(s: Session): Promise<void> {
  const { signal } = s.abort;
  const results = await Promise.allSettled([
    s.tails.frames.read(signal),
    s.tails.events.read(signal),
    s.tails.objects.read(signal),
  ]);
  const got = (r: PromiseSettledResult<unknown[]>) => (r.status === 'fulfilled' ? r.value : []);
  const [frames, events, objects] = results;
  s.data.addFrames(got(frames));
  s.data.addEvents(got(events));
  s.data.addObjects(got(objects));
  if (results.some((r) => got(r).length > 0)) s.version++;
  const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failed) throw failed.reason;
}

/** Follows an unfinished episode until it finishes (one last read then) or another one opens. */
async function poll(s: Session): Promise<void> {
  while (session === s) {
    await sleep(POLL_EVERY_MS);
    if (session !== s) return;
    const done = finished(s);
    try {
      await readNew(s);
    } catch (err) {
      if (s.abort.signal.aborted) return;
      console.warn(`viewer: reading ${s.id}`, err);
      continue;
    }
    if (done) return;
  }
}

async function refreshList(): Promise<void> {
  let listed: EpisodeSummary[];
  try {
    listed = await listEpisodes();
  } catch (err) {
    list.setNote('Server unreachable', true);
    console.warn('viewer: listing episodes', err);
    return;
  }
  episodes = listed;
  const now = Date.now();
  for (const e of listed) {
    const lines = e.frameCount + e.eventCount;
    const seen = growth.get(e.episodeId);
    if (!seen) growth.set(e.episodeId, { lines, at: 0 });
    else if (seen.lines !== lines) growth.set(e.episodeId, { lines, at: now });
  }
  renderList();

  const newest = listed[0]?.episodeId;
  if (newest && followNewest && newest !== (session?.id ?? opening?.id)) void open(newest);

  // The headset finished the open episode: fetch its finish; poll() does the last read.
  const s = session;
  if (s && !finished(s) && listed.find((e) => e.episodeId === s.id)?.finished) {
    try {
      const detail = await getEpisode(s.id, s.abort.signal);
      if (session !== s) return;
      s.detail = detail;
      s.following = false;
      s.playing = false;
    } catch (err) {
      if (!s.abort.signal.aborted) console.warn(`viewer: finishing ${s.id}`, err);
    }
  }
}

function renderList(): void {
  if (episodes) list.render(episodes.map(rowOf), session?.id ?? opening?.id ?? null);
}

function rowOf(e: EpisodeSummary): EpisodeRow {
  const live = isLive(e);
  return {
    id: e.episodeId,
    name: e.procedureId ? humanize(e.procedureId) : 'Free recording',
    when: new Date(e.createdAt).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }),
    status: statusOf(e, live),
    live,
  };
}

function isLive(e: EpisodeSummary): boolean {
  if (e.finished) return false;
  const now = Date.now();
  if (session?.id === e.episodeId && isRecording(session.detail.meta, session.data.endT, now)) {
    return true;
  }
  const seen = growth.get(e.episodeId);
  return seen !== undefined && now - seen.at < LIVE_GROWTH_MS;
}

function statusOf(e: EpisodeSummary, live: boolean): string {
  if (live) return 'Live';
  if (!e.finished) return 'Unfinished';
  const duration = e.durationMs === null ? '' : minutes(e.durationMs);
  if (e.outcome === 'aborted') return `Stopped ${duration}`.trim();
  if (e.outcome === 'interrupted') return `Interrupted ${duration}`.trim();
  return duration || 'Finished';
}

/** `m:ss` */
function minutes(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function humanize(id: string): string {
  const words = id.replace(/[-_]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// ---- timeline controls ---------------------------------------------------------------------------

function scrub(t: number): void {
  if (!session) return;
  session.following = false;
  session.playing = false;
  session.t = t;
}

function togglePlay(): void {
  const s = session;
  if (!s) return;
  if (s.following || s.playing) {
    s.following = false;
    s.playing = false;
    return;
  }
  const duration = episodeDuration(s.data, s.detail.finish?.durationMs ?? null);
  if (finished(s) && s.t >= duration) s.t = 0;
  s.playing = true;
}

function goLive(): void {
  if (!session || finished(session)) return;
  session.following = true;
  session.playing = false;
}

window.addEventListener('keydown', (e) => {
  const target = e.target as HTMLElement | null;
  if (e.code !== 'Space' || target?.closest('button, input, select, textarea')) return;
  e.preventDefault();
  togglePlay();
});

// ---- per animation frame -------------------------------------------------------------------------

function present(s: Session, duration: number): void {
  const { data, t } = s;
  scene.update({
    frame: data.frameAt(t),
    trail: data.headTrail(t, TRAIL_MS),
    objects: data.objectsAt(t),
    detections: data.detectionsAt(t).map((detection) => ({
      detection,
      outline: outlineOf(detection, data),
    })),
  });

  timeline.update({
    t,
    duration,
    playing: s.playing || s.following,
    live: !finished(s),
    following: s.following,
  });
  timeline.setMarks(marksOf(s), duration);

  const count = upperBound(data.events, t);
  const key = `${s.id}:${s.version}:${count}`;
  if (key === panelKey) return;
  panelKey = key;
  panel.setStep(data.stepAt(t), data.meta.plan?.steps.length ?? null);
  panel.setLog(logUntil(data.events, count));
}

function logUntil(events: readonly EpisodeEvent[], count: number): LogEntry[] {
  const entries: LogEntry[] = [];
  for (const event of events.slice(0, count)) {
    let entry = logCache.get(event);
    if (entry === undefined) {
      entry = logEntry(event);
      logCache.set(event, entry);
    }
    if (entry) entries.push(entry);
  }
  return entries;
}

function marksOf(s: Session): TimelineMark[] {
  if (s.marks.version !== s.version) {
    const marks: TimelineMark[] = [];
    for (const e of s.data.events) {
      if (e.type === 'step.entered') marks.push({ t: e.t, kind: 'step' });
      if (e.type === 'mistake.detected') marks.push({ t: e.t, kind: 'mistake' });
    }
    s.marks = { version: s.version, marks };
  }
  return s.marks.marks;
}

/** Lifted once per detection; null (not cached) while the frame it was captured on is missing. */
function outlineOf(detection: Detection, data: EpisodeData): Vec3[] | null {
  const cached = outlineCache.get(detection);
  if (cached) return cached;
  const head = data.headAtCapture(detection);
  const outline = head ? detectionOutline(detection, head) : null;
  if (outline) outlineCache.set(detection, outline);
  return outline;
}

let last = performance.now();
function tick(now: number): void {
  const dt = Math.min(100, now - last);
  last = now;
  const s = session;
  if (s) {
    const duration = episodeDuration(s.data, s.detail.finish?.durationMs ?? null);
    if (s.following) {
      s.t = latest(s);
    } else if (s.playing) {
      s.t = Math.min(duration, s.t + dt);
      // Playback stops at the end of a finished episode, and hands over to live at the live edge.
      if (s.t >= duration) {
        s.playing = false;
        s.following = !finished(s);
      }
    }
    present(s, duration);
  }
  scene.render();
  requestAnimationFrame(tick);
}

async function listLoop(): Promise<void> {
  await refreshList();
  setTimeout(() => void listLoop(), LIST_EVERY_MS);
}

scene.setWorkspace(DEFAULT_WORKSPACE);
const requested = new URLSearchParams(location.search).get('episode');
if (requested) {
  followNewest = false;
  void open(requested);
}
void listLoop();
requestAnimationFrame(tick);

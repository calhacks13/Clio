import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PassthroughCamera } from '../../src/adapters/camera/passthrough-camera';

// The camera runs against a fake video, canvas and media stream: just enough DOM for open() and
// the JPEG encoder. Each encode records when it happened and how wide it was.

interface FakeVideo {
  readyState: number;
  videoWidth: number;
  videoHeight: number;
  muted: boolean;
  playsInline: boolean;
  srcObject: unknown;
  play(): Promise<void>;
}

function fakeDom() {
  const video: FakeVideo = {
    readyState: 4,
    videoWidth: 1280,
    videoHeight: 960,
    muted: false,
    playsInline: false,
    srcObject: null,
    play: async () => {},
  };
  const encodes: { at: number; width: number; height: number }[] = [];
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage: () => {} }),
    toDataURL: () => {
      encodes.push({ at: Date.now(), width: canvas.width, height: canvas.height });
      return `data:image/jpeg;base64,JPEG${encodes.length}`;
    },
  };
  const stream = {
    getVideoTracks: () => [{ getSettings: () => ({ width: 1280, height: 960 }) }],
    getTracks: () => [],
  };
  vi.stubGlobal('document', {
    createElement: (tag: string) => (tag === 'video' ? video : canvas),
  });
  vi.stubGlobal('navigator', {
    userAgent: 'test',
    mediaDevices: { getUserMedia: async () => stream },
  });
  return { video, encodes };
}

async function openCamera(): Promise<PassthroughCamera> {
  const camera = await PassthroughCamera.open();
  if (!camera) throw new Error('camera did not open');
  return camera;
}

describe('PassthroughCamera.snapshots', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 10_000 });
    vi.spyOn(console, 'info').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('takes up to max frames at 1024 px, the first at once and then about 400 ms apart', async () => {
    const { encodes } = fakeDom();
    const camera = await openCamera();
    const shots = camera.snapshots(3);
    expect(encodes.map((e) => e.at)).toEqual([10_000]);
    await vi.advanceTimersByTimeAsync(800);
    expect(await shots).toEqual([
      { mimeType: 'image/jpeg', data: 'JPEG1' },
      { mimeType: 'image/jpeg', data: 'JPEG2' },
      { mimeType: 'image/jpeg', data: 'JPEG3' },
    ]);
    expect(encodes.map((e) => e.at)).toEqual([10_000, 10_400, 10_800]);
    expect(encodes.map((e) => [e.width, e.height])).toEqual([
      [1024, 768],
      [1024, 768],
      [1024, 768],
    ]);
  });

  it('answers a single frame at once, without waiting', async () => {
    fakeDom();
    const camera = await openCamera();
    expect(await camera.snapshots(1)).toEqual([{ mimeType: 'image/jpeg', data: 'JPEG1' }]);
    expect(await camera.snapshots(0)).toEqual([]);
  });

  it('returns fewer frames when the video is not ready', async () => {
    const { video, encodes } = fakeDom();
    const camera = await openCamera();
    const shots = camera.snapshots(3);
    video.readyState = 1;
    await vi.advanceTimersByTimeAsync(800);
    expect(await shots).toEqual([{ mimeType: 'image/jpeg', data: 'JPEG1' }]);
    expect(encodes).toHaveLength(1);

    const none = camera.snapshots(3);
    expect(await none).toEqual([]);
  });

  it('sends the coach 1024 px snapshots, as sharp as the planner frames', async () => {
    const { encodes } = fakeDom();
    const camera = await openCamera();
    expect(await camera.snapshot()).toBe('JPEG1');
    expect(encodes[0]?.width).toBe(1024);
  });
});

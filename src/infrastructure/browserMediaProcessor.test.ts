import { METADATA_TIMEOUT_MS, browserMediaProcessor } from './browserMediaProcessor';

interface FakeVideo {
  preload: string; muted: boolean; src: string; duration: number; videoWidth: number; videoHeight: number;
  onloadedmetadata: (() => void) | null; onerror: (() => void) | null;
  removeAttribute: ReturnType<typeof vi.fn>; load: ReturnType<typeof vi.fn>;
}

function setup() {
  const video: FakeVideo = {
    preload: '', muted: false, src: '', duration: NaN, videoWidth: 0, videoHeight: 0,
    onloadedmetadata: null, onerror: null, removeAttribute: vi.fn(), load: vi.fn(),
  };
  vi.spyOn(document, 'createElement').mockReturnValue(video as unknown as HTMLVideoElement);
  const create = vi.fn(() => 'blob:fake');
  const revoke = vi.fn();
  vi.stubGlobal('URL', { createObjectURL: create, revokeObjectURL: revoke });
  return { video, create, revoke };
}
const file = new File(['x'], 'a.mp4', { type: 'video/mp4' });

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('browserMediaProcessor', () => {
  it('reads metadata and revokes the object URL', async () => {
    const { video, revoke } = setup();
    const p = browserMediaProcessor.extractMetadata(file);
    video.duration = 42; video.videoWidth = 1280; video.videoHeight = 720;
    video.onloadedmetadata?.();
    await expect(p).resolves.toMatchObject({ availability: 'available', source: 'browser', durationSeconds: 42, width: 1280, height: 720 });
    expect(revoke).toHaveBeenCalledWith('blob:fake');
  });
  it('reports unsupported-by-browser (not a failure) when the browser cannot decode the file', async () => {
    const { video, revoke } = setup();
    const p = browserMediaProcessor.extractMetadata(file);
    video.onerror?.();
    await expect(p).resolves.toMatchObject({ availability: 'unavailable', unavailableReason: 'unsupported-by-browser' });
    expect(revoke).toHaveBeenCalled();
  });
  it('reports a timeout as unavailable metadata and still cleans up', async () => {
    vi.useFakeTimers();
    const { revoke } = setup();
    const p = browserMediaProcessor.extractMetadata(file);
    vi.advanceTimersByTime(METADATA_TIMEOUT_MS);
    await expect(p).resolves.toMatchObject({ availability: 'unavailable', unavailableReason: 'timeout' });
    expect(revoke).toHaveBeenCalledTimes(1);
  });
  it('flags malformed values from the media element', async () => {
    const { video } = setup();
    const p = browserMediaProcessor.extractMetadata(file);
    video.duration = Infinity;
    video.onloadedmetadata?.();
    await expect(p).resolves.toMatchObject({ availability: 'unavailable', unavailableReason: 'malformed' });
  });
  it('settles only once', async () => {
    const { video, revoke } = setup();
    const p = browserMediaProcessor.extractMetadata(file);
    video.duration = 5; video.videoWidth = 2; video.videoHeight = 2;
    video.onloadedmetadata?.();
    video.onerror?.();
    await p;
    expect(revoke).toHaveBeenCalledTimes(1);
  });
});

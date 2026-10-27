import { StrictMode } from 'react';
import { act, render } from '@testing-library/react';
import { FakeYTPlayer, fakeYTApi, SAMPLE_ID } from '@/test/youtube';
import { loadYouTubeIframeApi, YouTubeApiError } from '@/infrastructure/youtube/iframeApi';
import { YouTubePlayer, EMBED_HOST, READY_TIMEOUT_MS } from './YouTubePlayer';

vi.mock('@/infrastructure/youtube/iframeApi', async (orig) => ({ ...(await orig<typeof import('@/infrastructure/youtube/iframeApi')>()), loadYouTubeIframeApi: vi.fn() }));
const load = vi.mocked(loadYouTubeIframeApi);

const props = () => ({ onLoading: vi.fn(), onDriver: vi.fn(), onReady: vi.fn(), onError: vi.fn() });
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

beforeEach(() => { FakeYTPlayer.reset(); load.mockReset(); load.mockResolvedValue(fakeYTApi); });
afterEach(() => { vi.useRealTimers(); });

describe('YouTubePlayer', () => {
  it('creates the official player for exactly this id, privacy-enhanced, never autoplaying, with the page origin', async () => {
    const p = props();
    render(<YouTubePlayer videoId={SAMPLE_ID} {...p} />);
    await flush();
    expect(p.onLoading).toHaveBeenCalledTimes(1);
    expect(FakeYTPlayer.instances).toHaveLength(1);
    const o = FakeYTPlayer.last.options;
    expect(o.videoId).toBe(SAMPLE_ID);
    expect(o.host).toBe(EMBED_HOST);
    expect(EMBED_HOST).toBe('https://www.youtube-nocookie.com');
    expect(o.playerVars).toMatchObject({ enablejsapi: 1, origin: window.location.origin, autoplay: 0, playsinline: 1 });
    expect(Object.keys(o.playerVars ?? {}).sort()).toEqual(['autoplay', 'enablejsapi', 'fs', 'origin', 'playsinline', 'rel']);
  });

  it('is a labelled, keyboard-reachable region; nothing is drawn over the player', async () => {
    const { container } = render(<YouTubePlayer videoId={SAMPLE_ID} {...props()} />);
    await flush();
    const region = container.querySelector('[role=region]')!;
    expect(region.getAttribute('aria-label')).toBe('YouTube video player');
    expect(region.children).toHaveLength(1); // only the element the player replaced
  });

  it('reports ready (and gives the driver) only when the player says so, and titles the frame', async () => {
    const p = props();
    render(<YouTubePlayer videoId={SAMPLE_ID} {...p} />);
    await flush();
    expect(p.onReady).not.toHaveBeenCalled();
    expect(p.onDriver).not.toHaveBeenCalled();
    act(() => FakeYTPlayer.last.fireReady());
    expect(p.onReady).toHaveBeenCalledTimes(1);
    expect(p.onDriver).toHaveBeenCalledTimes(1);
    expect(p.onDriver.mock.calls[0]![0]).not.toBeNull();
    expect(FakeYTPlayer.last.iframe.getAttribute('title')).toBe('YouTube video player');
  });

  it('forwards player state and rate events to the driver', async () => {
    const p = props();
    render(<YouTubePlayer videoId={SAMPLE_ID} {...p} />);
    await flush();
    act(() => FakeYTPlayer.last.fireReady());
    const driver = p.onDriver.mock.calls[0]![0];
    act(() => FakeYTPlayer.last.fireState(1));
    expect(driver.surface.paused).toBe(false);
    act(() => FakeYTPlayer.last.fireState(2));
    expect(driver.surface.paused).toBe(true);
  });

  it.each([
    [2, 'invalid-parameter'], [5, 'html5-error'], [100, 'not-found-or-private'], [101, 'embedding-disabled'], [150, 'embedding-disabled'], [153, 'client-identification'], [42, 'unknown'],
  ] as const)('player error %i is reported as "%s"', async (code, kind) => {
    const p = props();
    render(<YouTubePlayer videoId={SAMPLE_ID} {...p} />);
    await flush();
    act(() => FakeYTPlayer.last.fireError(code));
    expect(p.onError).toHaveBeenCalledWith(kind);
    expect(p.onReady).not.toHaveBeenCalled();
  });

  it('API load failure → "network"; API load timeout → "timeout"; no player is created', async () => {
    const p = props();
    load.mockRejectedValueOnce(new YouTubeApiError('network'));
    const first = render(<YouTubePlayer videoId={SAMPLE_ID} {...p} />);
    await flush();
    expect(p.onError).toHaveBeenLastCalledWith('network');
    first.unmount();
    load.mockRejectedValueOnce(new YouTubeApiError('timeout'));
    render(<YouTubePlayer videoId={SAMPLE_ID} {...p} />);
    await flush();
    expect(p.onError).toHaveBeenLastCalledWith('timeout');
    expect(FakeYTPlayer.instances).toHaveLength(0);
  });

  it('gives up with "timeout" when the player never becomes ready (blocked or offline)', async () => {
    vi.useFakeTimers();
    const p = props();
    render(<YouTubePlayer videoId={SAMPLE_ID} {...p} />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { vi.advanceTimersByTime(READY_TIMEOUT_MS + 10); });
    expect(p.onError).toHaveBeenCalledWith('timeout');
  });

  it('a late "ready" after an error or unmount does nothing', async () => {
    const p = props();
    const { unmount } = render(<YouTubePlayer videoId={SAMPLE_ID} {...p} />);
    await flush();
    const player = FakeYTPlayer.last;
    unmount();
    act(() => player.fireReady());
    expect(p.onReady).not.toHaveBeenCalled();
  });

  it('never creates a player for an id that is not a valid video id', async () => {
    const p = props();
    for (const bad of ['', 'short', '../../etc/passwd', `${SAMPLE_ID}x`, '<script>aaaa']) render(<YouTubePlayer videoId={bad} {...p} />);
    await flush();
    expect(load).not.toHaveBeenCalled();
    expect(FakeYTPlayer.instances).toHaveLength(0);
  });

  it('unmounting destroys the player, empties the container and tells the owner the driver is gone', async () => {
    const p = props();
    const { unmount, container } = render(<YouTubePlayer videoId={SAMPLE_ID} {...p} />);
    await flush();
    act(() => FakeYTPlayer.last.fireReady());
    const player = FakeYTPlayer.last;
    unmount();
    expect(player.destroyed).toBe(true);
    expect(p.onDriver).toHaveBeenLastCalledWith(null);
    expect(container.querySelector('iframe')).toBeNull();
  });

  it('changing the video destroys the old player and builds exactly one new one', async () => {
    const p = props();
    const { rerender } = render(<YouTubePlayer videoId={SAMPLE_ID} {...p} />);
    await flush();
    const first = FakeYTPlayer.last;
    rerender(<YouTubePlayer videoId="aaaaaaaaaaa" {...p} />);
    await flush();
    expect(first.destroyed).toBe(true);
    expect(FakeYTPlayer.instances).toHaveLength(2);
    expect(FakeYTPlayer.last.options.videoId).toBe('aaaaaaaaaaa');
    expect(FakeYTPlayer.instances.filter((x) => !x.destroyed)).toHaveLength(1);
  });

  it('re-rendering with the same id does not create a second player', async () => {
    const p = props();
    const { rerender } = render(<YouTubePlayer videoId={SAMPLE_ID} {...p} />);
    await flush();
    rerender(<YouTubePlayer videoId={SAMPLE_ID} {...props()} />);
    rerender(<YouTubePlayer videoId={SAMPLE_ID} {...props()} />);
    await flush();
    expect(FakeYTPlayer.instances).toHaveLength(1);
  });

  it('React StrictMode (effects run twice in development) still leaves exactly one live player', async () => {
    const p = props();
    const { unmount } = render(<StrictMode><YouTubePlayer videoId={SAMPLE_ID} {...p} /></StrictMode>);
    await flush();
    expect(FakeYTPlayer.instances.filter((x) => !x.destroyed)).toHaveLength(1);
    unmount();
    expect(FakeYTPlayer.instances.filter((x) => !x.destroyed)).toHaveLength(0);
  });

  it('quickly switching away before the API finished loading never builds the old video', async () => {
    let resolve!: (v: typeof fakeYTApi) => void;
    load.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    const p = props();
    const { unmount } = render(<YouTubePlayer videoId={SAMPLE_ID} {...p} />);
    unmount();
    resolve(fakeYTApi);
    await flush();
    expect(FakeYTPlayer.instances).toHaveLength(0);
  });
});

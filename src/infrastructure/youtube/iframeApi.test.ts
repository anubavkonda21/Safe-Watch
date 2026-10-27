import { API_LOAD_TIMEOUT_MS, IFRAME_API_SRC, IFRAME_SCRIPT_ID, loadYouTubeIframeApi, resetYouTubeIframeApiForTests, YouTubeApiError } from './iframeApi';

const scripts = () => document.querySelectorAll(`script#${IFRAME_SCRIPT_ID}`);
class FakePlayer {}
const announceApi = () => { window.YT = { Player: FakePlayer as never }; window.onYouTubeIframeAPIReady?.(); };

beforeEach(() => { resetYouTubeIframeApiForTests(); });
afterEach(() => { resetYouTubeIframeApiForTests(); vi.useRealTimers(); });

describe('loadYouTubeIframeApi', () => {
  it('injects the official script only when asked (nothing is loaded at import time)', () => {
    expect(scripts()).toHaveLength(0);
    void loadYouTubeIframeApi().catch(() => undefined);
    expect(scripts()).toHaveLength(1);
    const s = scripts()[0] as HTMLScriptElement;
    expect(s.src).toBe(IFRAME_API_SRC);
    expect(s.async).toBe(true);
  });

  it('concurrent callers share ONE script element and one promise', async () => {
    const a = loadYouTubeIframeApi();
    const b = loadYouTubeIframeApi();
    const c = loadYouTubeIframeApi();
    expect(a).toBe(b); expect(b).toBe(c);
    expect(scripts()).toHaveLength(1);
    announceApi();
    expect((await a).Player).toBe(FakePlayer);
  });

  it('resolves immediately, without adding a script, when the API is already on the page', async () => {
    window.YT = { Player: FakePlayer as never };
    expect((await loadYouTubeIframeApi()).Player).toBe(FakePlayer);
    expect(scripts()).toHaveLength(0);
  });

  it('a later call after success does not inject again', async () => {
    const first = loadYouTubeIframeApi();
    announceApi();
    await first;
    await loadYouTubeIframeApi();
    expect(scripts()).toHaveLength(1);
  });

  it('keeps and still calls a ready handler somebody else installed', async () => {
    const theirs = vi.fn();
    window.onYouTubeIframeAPIReady = theirs;
    const p = loadYouTubeIframeApi();
    announceApi();
    await p;
    expect(theirs).toHaveBeenCalledTimes(1);
  });

  it('a throwing foreign handler does not break loading', async () => {
    window.onYouTubeIframeAPIReady = () => { throw new Error('theirs'); };
    const p = loadYouTubeIframeApi();
    announceApi();
    await expect(p).resolves.toBeDefined();
  });

  it('a network failure rejects with kind "network", removes the script, and a retry can succeed', async () => {
    const p = loadYouTubeIframeApi();
    scripts()[0]!.dispatchEvent(new Event('error'));
    await expect(p).rejects.toMatchObject({ name: 'YouTubeApiError', kind: 'network' });
    expect(scripts()).toHaveLength(0);
    const retry = loadYouTubeIframeApi();
    expect(scripts()).toHaveLength(1);
    announceApi();
    await expect(retry).resolves.toBeDefined();
  });

  it('times out when the API never announces itself, then allows a retry', async () => {
    vi.useFakeTimers();
    const p = loadYouTubeIframeApi();
    const assertion = expect(p).rejects.toMatchObject({ kind: 'timeout' });
    await vi.advanceTimersByTimeAsync(API_LOAD_TIMEOUT_MS + 1);
    await assertion;
    expect(scripts()).toHaveLength(0);
    expect(window.onYouTubeIframeAPIReady).toBeUndefined();
    void loadYouTubeIframeApi().catch(() => undefined);
    expect(scripts()).toHaveLength(1);
  });

  it('an announcement without a usable Player is a failure, not a hang', async () => {
    const p = loadYouTubeIframeApi();
    window.YT = {};
    window.onYouTubeIframeAPIReady?.();
    await expect(p).rejects.toBeInstanceOf(YouTubeApiError);
  });

  it('only ever loads the one official address', () => {
    void loadYouTubeIframeApi().catch(() => undefined);
    expect(IFRAME_API_SRC).toBe('https://www.youtube.com/iframe_api');
    expect([...document.scripts].map((s) => s.src).filter((s) => /youtube|ytimg/.test(s))).toEqual([IFRAME_API_SRC]);
  });
});

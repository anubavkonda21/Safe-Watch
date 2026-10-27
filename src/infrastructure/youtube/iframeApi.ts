import type { YTNamespace } from './types';

/** The official loader address. Nothing else is ever loaded as a script for YouTube. */
export const IFRAME_API_SRC = 'https://www.youtube.com/iframe_api';
export const IFRAME_SCRIPT_ID = 'safewatch-youtube-iframe-api';
export const API_LOAD_TIMEOUT_MS = 15_000;

export class YouTubeApiError extends Error {
  constructor(readonly kind: 'network' | 'timeout') {
    super(kind);
    this.name = 'YouTubeApiError';
  }
}

let pending: Promise<YTNamespace> | null = null;

const ready = (): YTNamespace | null => {
  const yt = typeof window !== 'undefined' ? window.YT : undefined;
  return yt && typeof yt.Player === 'function' ? (yt as YTNamespace) : null;
};

/**
 * Loads the YouTube IFrame Player API, at most once per page, and only when called (so a page that never shows a YouTube video
 * never contacts YouTube). Concurrent callers share one promise and one script element. A failure removes the script and
 * clears the cache, so a later call can try again. An `onYouTubeIframeAPIReady` handler installed by someone else is kept and
 * still called.
 */
export function loadYouTubeIframeApi(timeoutMs: number = API_LOAD_TIMEOUT_MS): Promise<YTNamespace> {
  const already = ready();
  if (already) return Promise.resolve(already);
  if (pending) return pending;

  pending = new Promise<YTNamespace>((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady;
    let script = document.getElementById(IFRAME_SCRIPT_ID) as HTMLScriptElement | null;
    const created = script === null;
    const timer = setTimeout(() => fail('timeout'), timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      script?.removeEventListener('error', onError);
    }
    function fail(kind: 'network' | 'timeout') {
      cleanup();
      if (window.onYouTubeIframeAPIReady === onReady) window.onYouTubeIframeAPIReady = previous;
      script?.remove();
      pending = null;
      reject(new YouTubeApiError(kind));
    }
    function onReady() {
      try { previous?.(); } catch { /* someone else's handler must not break ours */ }
      const api = ready();
      if (!api) { fail('network'); return; }
      cleanup();
      resolve(api);
    }
    function onError() { fail('network'); }

    window.onYouTubeIframeAPIReady = onReady;
    if (created) {
      script = document.createElement('script');
      script.id = IFRAME_SCRIPT_ID;
      script.src = IFRAME_API_SRC;
      script.async = true;
    }
    script!.addEventListener('error', onError);
    if (created) document.head.appendChild(script!);
  });
  return pending;
}

/** Test hook: forgets the cached load so each test starts clean. Not used by the application. */
export function resetYouTubeIframeApiForTests(): void {
  pending = null;
  document.getElementById(IFRAME_SCRIPT_ID)?.remove();
  delete window.YT;
  delete window.onYouTubeIframeAPIReady;
}

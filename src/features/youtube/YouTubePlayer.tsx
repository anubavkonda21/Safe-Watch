import { useEffect, useRef } from 'react';
import { isYouTubeVideoId } from '@/domain/youtube/url';
import type { PlayerErrorKind } from '@/domain/youtube/sourceState';
import { loadYouTubeIframeApi, YouTubeApiError } from '@/infrastructure/youtube/iframeApi';
import { playerErrorKind, YouTubeDriver } from '@/infrastructure/youtube/youtubeDriver';
import type { YTPlayerLike } from '@/infrastructure/youtube/types';

/** The address YouTube serves privacy-enhanced embeds from. The video id is the only thing that varies. */
export const EMBED_HOST = 'https://www.youtube-nocookie.com';
/** If the player never says it is ready (blocked, offline, or broken), give up and tell the user. */
export const READY_TIMEOUT_MS = 20_000;

interface Props {
  videoId: string;
  onLoading: () => void;
  /** Called with the driver once the player can be controlled, and with null when it goes away. */
  onDriver: (driver: YouTubeDriver | null) => void;
  onReady: () => void;
  onError: (kind: PlayerErrorKind) => void;
}

/**
 * The official YouTube IFrame Player, created for exactly one video id and torn down when the id changes or the component goes
 * away: the player is destroyed, its listeners and timers are removed, and its element is emptied. The API script is loaded once
 * per page, and only when this component first mounts. SafeWatch adds nothing on top of the player (no overlay, no styling of
 * the frame's contents), keeps YouTube's own controls, and never autoplays.
 */
export function YouTubePlayer({ videoId, onLoading, onDriver, onReady, onError }: Props) {
  const host = useRef<HTMLDivElement | null>(null);
  const handlers = useRef({ onLoading, onDriver, onReady, onError });
  useEffect(() => { handlers.current = { onLoading, onDriver, onReady, onError }; });

  useEffect(() => {
    const container = host.current;
    if (!container || !isYouTubeVideoId(videoId)) return;
    let cancelled = false;
    let player: YTPlayerLike | null = null;
    let driver: YouTubeDriver | null = null;
    let readyTimer: ReturnType<typeof setTimeout> | null = null;
    const inner = document.createElement('div');
    container.replaceChildren(inner);
    handlers.current.onLoading();

    const fail = (kind: PlayerErrorKind) => { if (!cancelled) handlers.current.onError(kind); };

    loadYouTubeIframeApi().then((api) => {
      if (cancelled) return;
      readyTimer = setTimeout(() => fail('timeout'), READY_TIMEOUT_MS);
      player = new api.Player(inner, {
        videoId,
        host: EMBED_HOST,
        width: '100%',
        height: '100%',
        playerVars: { enablejsapi: 1, origin: window.location.origin, playsinline: 1, autoplay: 0, rel: 0, fs: 1 },
        events: {
          onReady: () => {
            if (cancelled || !driver) return;
            if (readyTimer) { clearTimeout(readyTimer); readyTimer = null; }
            try { player?.getIframe?.().setAttribute('title', 'YouTube video player'); } catch { /* the title is a courtesy */ }
            driver.onReady();
            handlers.current.onDriver(driver);
            handlers.current.onReady();
          },
          onStateChange: (e) => driver?.onStateChange(e.data),
          onPlaybackRateChange: () => driver?.onPlaybackRateChange(),
          onError: (e) => { if (readyTimer) { clearTimeout(readyTimer); readyTimer = null; } fail(playerErrorKind(e.data)); },
        },
      });
      driver = new YouTubeDriver(player);
    }).catch((e: unknown) => fail(e instanceof YouTubeApiError && e.kind === 'timeout' ? 'timeout' : 'network'));

    return () => {
      cancelled = true;
      if (readyTimer) clearTimeout(readyTimer);
      driver?.destroy();
      try { player?.destroy(); } catch { /* already gone */ }
      container.replaceChildren();
      handlers.current.onDriver(null);
    };
  }, [videoId]);

  return <div ref={host} className="sw-yt" role="region" aria-label="YouTube video player" />;
}

/**
 * The small part of the official YouTube IFrame Player API that SafeWatch uses (https://developers.google.com/youtube/iframe_api_reference).
 * Only documented methods appear here: playback position, state, rate, mute and seek. Nothing that reads audio, frames or
 * caption text exists in this API, and nothing here tries to.
 */
export interface YTPlayerLike {
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  getPlaybackRate(): number;
  isMuted(): boolean;
  mute(): void;
  unMute(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getIframe?(): HTMLIFrameElement;
  destroy(): void;
}

export interface YTPlayerEvent { target: YTPlayerLike; data?: number }

export interface YTPlayerOptions {
  videoId: string;
  host?: string;
  width?: string | number;
  height?: string | number;
  playerVars?: Record<string, string | number>;
  events?: {
    onReady?: (e: YTPlayerEvent) => void;
    onStateChange?: (e: YTPlayerEvent) => void;
    onPlaybackRateChange?: (e: YTPlayerEvent) => void;
    onError?: (e: YTPlayerEvent) => void;
  };
}

export interface YTNamespace {
  Player: new (element: HTMLElement, options: YTPlayerOptions) => YTPlayerLike;
}

/** Documented `getPlayerState()` / `onStateChange` values. */
export const YT_STATE = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 } as const;

declare global {
  interface Window {
    YT?: Partial<YTNamespace>;
    onYouTubeIframeAPIReady?: () => void;
  }
}

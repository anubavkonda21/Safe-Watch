import type { PlaybackSignal, PlaybackSurface } from '@/domain/playback/coordinator';
import { VideoSurface } from './videoSurface';

/**
 * Everything the playback hook needs from a player, whatever kind it is: a synchronous surface (position, rate, mute, seek) and a
 * stream of signals. The coordinator and the warning scheduler are written against this and know nothing about `<video>` or
 * YouTube. A driver never changes the player on its own: it only reports, and carries out the seek and mute it is asked for.
 */
export interface PlaybackDriver {
  readonly surface: PlaybackSurface;
  /** Subscribes to player signals. Returns the unsubscribe function. */
  listen(onSignal: (signal: PlaybackSignal) => void): () => void;
  /** True while the playhead is advancing (drives the per-frame loop). */
  isPlaying(): boolean;
}

const VIDEO_SIGNALS: Array<[string, PlaybackSignal]> = [
  ['timeupdate', 'timeupdate'], ['play', 'play'], ['playing', 'play'], ['pause', 'pause'], ['seeked', 'seeked'], ['ended', 'ended'], ['volumechange', 'volumechange'],
];

/** The CP8/CP9 driver: an HTMLVideoElement. Behaviour is unchanged from when the hook owned these listeners. */
export function createVideoDriver(video: HTMLVideoElement): PlaybackDriver {
  const surface = new VideoSurface(video);
  return {
    surface,
    isPlaying: () => !video.paused,
    listen(onSignal) {
      const listeners = VIDEO_SIGNALS.map(([name, signal]): [string, () => void] => [name, () => onSignal(signal)]);
      for (const [name, fn] of listeners) video.addEventListener(name, fn);
      return () => { for (const [name, fn] of listeners) video.removeEventListener(name, fn); };
    },
  };
}

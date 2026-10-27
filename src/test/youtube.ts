import type { YTNamespace, YTPlayerEvent, YTPlayerLike, YTPlayerOptions } from '@/infrastructure/youtube/types';

/**
 * A YouTube player that exists only as data: no network, no iframe, no clock. Tests drive it (state changes, errors, time) and
 * read back every command SafeWatch sent. It implements the same small documented surface as the real IFrame player.
 */
export class FakeYTPlayer implements YTPlayerLike {
  static instances: FakeYTPlayer[] = [];
  static reset() { FakeYTPlayer.instances = []; }
  static get last(): FakeYTPlayer { return FakeYTPlayer.instances[FakeYTPlayer.instances.length - 1]!; }

  time = 0;
  duration = 600;
  state = -1;
  rate = 1;
  muted = false;
  destroyed = false;
  seeks: Array<[number, boolean]> = [];
  muteCalls: Array<'mute' | 'unMute'> = [];
  throwOnRead = false;
  readonly iframe = document.createElement('iframe');

  constructor(readonly element: HTMLElement, readonly options: YTPlayerOptions) {
    FakeYTPlayer.instances.push(this);
  }

  private guard<T>(v: T): T { if (this.throwOnRead || this.destroyed) throw new Error('player is gone'); return v; }
  getCurrentTime() { return this.guard(this.time); }
  getDuration() { return this.guard(this.duration); }
  getPlayerState() { return this.guard(this.state); }
  getPlaybackRate() { return this.guard(this.rate); }
  isMuted() { return this.guard(this.muted); }
  mute() { this.guard(0); this.muted = true; this.muteCalls.push('mute'); }
  unMute() { this.guard(0); this.muted = false; this.muteCalls.push('unMute'); }
  seekTo(seconds: number, allowSeekAhead: boolean) { this.guard(0); this.seeks.push([seconds, allowSeekAhead]); this.time = seconds; }
  getIframe() { return this.iframe; }
  destroy() { this.destroyed = true; }

  // ── test controls ──
  private ev(data?: number): YTPlayerEvent { return { target: this, data }; }
  fireReady() { this.options.events?.onReady?.(this.ev()); }
  fireState(state: number) { this.state = state; this.options.events?.onStateChange?.(this.ev(state)); }
  fireRate(rate: number) { this.rate = rate; this.options.events?.onPlaybackRateChange?.(this.ev(rate)); }
  fireError(code: number) { this.options.events?.onError?.(this.ev(code)); }
}

export const fakeYTApi = { Player: FakeYTPlayer } as unknown as YTNamespace;

export const SAMPLE_ID = 'dQw4w9WgXcQ';
export const SAMPLE_URL = `https://www.youtube.com/watch?v=${SAMPLE_ID}`;

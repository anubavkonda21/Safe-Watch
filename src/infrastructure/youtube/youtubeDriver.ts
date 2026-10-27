import type { PlaybackSignal, PlaybackSurface } from '@/domain/playback/coordinator';
import type { PlayerErrorKind } from '@/domain/youtube/sourceState';
import type { PlaybackDriver } from '@/features/playback/driver';
import { YT_STATE, type YTPlayerLike } from './types';

/** How often the playhead is read. The YouTube player has no time-update event, so the position is polled (like a <video>'s ~4 per second). */
export const POLL_MS = 250;
/** A seek we asked for is "landed" when the playhead is this close to the target, or after SEEK_TIMEOUT_MS whatever happens. */
const SEEK_TOLERANCE_MS = 750;
const SEEK_TIMEOUT_MS = 1500;

/** Documented error codes (IFrame API reference): 2, 5, 100, 101, 150, 153. Anything else is "unknown". */
export function playerErrorKind(code: number | undefined): PlayerErrorKind {
  switch (code) {
    case 2: return 'invalid-parameter';
    case 5: return 'html5-error';
    case 100: return 'not-found-or-private';
    case 101: case 150: return 'embedding-disabled';
    case 153: return 'client-identification';
    default: return 'unknown';
  }
}

/**
 * Adapts the YouTube player to the PlaybackDriver the coordinator and the warning scheduler already use. It READS position, state,
 * rate and mute, and it carries out exactly two commands, both documented parts of the API: `seekTo` and `mute` / `unMute`.
 * It never touches the picture, the sound data, the controls, the branding or the advertisements.
 *
 * `paused` is true unless the player reports PLAYING, so buffering, cueing, ending and an unstarted video all count as "not
 * advancing" and nothing is scheduled against a playhead that is not moving. Seeks the page asks for are reported back as
 * `seeked` (the API has no such event); seeks the user makes are noticed by the coordinator as a jump between two readings.
 * Before the player is ready every reading is neutral (position 0, paused) and every command is ignored.
 */
export class YouTubeDriver implements PlaybackDriver, PlaybackSurface {
  readonly surface: PlaybackSurface = this;
  private ready = false;
  private state: number = YT_STATE.UNSTARTED;
  private readonly listeners = new Set<(s: PlaybackSignal) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastMuted: boolean | null = null;
  private pendingSeek: { targetMs: number; at: number } | null = null;
  private destroyed = false;

  constructor(private readonly player: YTPlayerLike, private readonly now: () => number = () => performance.now()) {}

  // ── PlaybackSurface ──
  get currentTimeMs(): number {
    if (!this.ready || this.destroyed) return 0;
    const t = this.read(() => this.player.getCurrentTime());
    return typeof t === 'number' && Number.isFinite(t) && t >= 0 ? Math.round(t * 1000) : 0;
  }
  get durationMs(): number | null {
    if (!this.ready || this.destroyed) return null;
    const d = this.read(() => this.player.getDuration());
    return typeof d === 'number' && Number.isFinite(d) && d > 0 ? Math.round(d * 1000) : null;
  }
  get paused(): boolean { return !this.ready || this.destroyed || this.state !== YT_STATE.PLAYING; }
  get playbackRate(): number {
    if (!this.ready || this.destroyed) return 1;
    const r = this.read(() => this.player.getPlaybackRate());
    return typeof r === 'number' && r > 0 && Number.isFinite(r) ? r : 1;
  }
  get muted(): boolean { return this.ready && !this.destroyed ? this.read(() => this.player.isMuted()) === true : false; }
  set muted(value: boolean) {
    if (!this.ready || this.destroyed) return;
    this.read(() => { if (value) this.player.mute(); else this.player.unMute(); });
  }
  seekToMs(ms: number): void {
    if (!this.ready || this.destroyed || !Number.isFinite(ms)) return;
    const duration = this.durationMs;
    const target = Math.max(0, duration === null ? ms : Math.min(ms, duration));
    this.pendingSeek = { targetMs: target, at: this.now() };
    this.read(() => this.player.seekTo(target / 1000, true));
  }

  // ── PlaybackDriver ──
  isPlaying(): boolean { return !this.paused; }
  listen(onSignal: (s: PlaybackSignal) => void): () => void {
    this.listeners.add(onSignal);
    this.startPolling();
    return () => { this.listeners.delete(onSignal); if (this.listeners.size === 0) this.stopPolling(); };
  }

  // ── events from the player (wired by the mount code) ──
  onReady(): void {
    if (this.destroyed) return;
    this.ready = true;
    this.lastMuted = this.muted;
    this.emit('timeupdate');
  }
  onStateChange(state: number | undefined): void {
    if (this.destroyed || typeof state !== 'number') return;
    this.state = state;
    if (state === YT_STATE.PLAYING) this.emit('play');
    else if (state === YT_STATE.ENDED) this.emit('ended');
    else this.emit('pause'); // paused, buffering, cued, unstarted: the playhead is not advancing
  }
  onPlaybackRateChange(): void { this.emit('timeupdate'); }

  destroy(): void {
    this.destroyed = true;
    this.stopPolling();
    this.listeners.clear();
    this.pendingSeek = null;
  }

  // ── internals ──
  /** A throwing player (for example one that was torn down) never breaks the page: the reading is just missing. */
  private read<T>(fn: () => T): T | undefined {
    try { return fn(); } catch { return undefined; }
  }
  private emit(s: PlaybackSignal): void {
    for (const l of [...this.listeners]) l(s);
  }
  private startPolling(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.poll(), POLL_MS);
  }
  private stopPolling(): void {
    if (this.timer !== null) { clearInterval(this.timer); this.timer = null; }
  }
  private poll(): void {
    if (!this.ready || this.destroyed) return;
    const muted = this.muted;
    if (this.lastMuted !== null && muted !== this.lastMuted) { this.lastMuted = muted; this.emit('volumechange'); } else this.lastMuted = muted;
    this.emit('timeupdate');
    if (this.pendingSeek) {
      const { targetMs, at } = this.pendingSeek;
      if (Math.abs(this.currentTimeMs - targetMs) <= SEEK_TOLERANCE_MS || this.now() - at > SEEK_TIMEOUT_MS) { this.pendingSeek = null; this.emit('seeked'); }
    }
  }
}

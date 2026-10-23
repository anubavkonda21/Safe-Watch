import type { PlaybackSurface } from '@/domain/playback/coordinator';

/**
 * The playback boundary: adapts an HTMLVideoElement to the coordinator's PlaybackSurface. Seconds become integer
 * milliseconds here and nowhere else; seeks are clamped to the media duration (a seek never goes beyond it).
 */
export class VideoSurface implements PlaybackSurface {
  constructor(private readonly el: HTMLVideoElement) {}

  get currentTimeMs(): number { return Math.round(this.el.currentTime * 1000); }

  get durationMs(): number | null {
    const d = this.el.duration;
    return Number.isFinite(d) && d > 0 ? Math.round(d * 1000) : null;
  }

  get paused(): boolean { return this.el.paused; }
  get playbackRate(): number { return this.el.playbackRate > 0 ? this.el.playbackRate : 1; }
  get muted(): boolean { return this.el.muted; }
  set muted(value: boolean) { this.el.muted = value; }

  seekToMs(ms: number): void {
    if (!Number.isFinite(ms)) return;
    const duration = this.durationMs;
    const clamped = Math.max(0, duration === null ? ms : Math.min(ms, duration));
    this.el.currentTime = clamped / 1000;
  }
}

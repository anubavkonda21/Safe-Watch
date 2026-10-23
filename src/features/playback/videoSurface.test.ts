import { installFakeVideo } from '@/test/media';
import { VideoSurface } from './videoSurface';

const surface = (duration = 60) => { const el = document.createElement('video'); const fake = installFakeVideo(el, duration); return { s: new VideoSurface(el), fake, el }; };

describe('VideoSurface (the only place seconds become milliseconds)', () => {
  it('reports the playhead and duration as integer milliseconds', () => {
    const { s, el } = surface(61.2345);
    el.currentTime = 9.9996;
    expect(s.currentTimeMs).toBe(10_000);
    expect(s.durationMs).toBe(61_235);
    expect(Number.isInteger(s.currentTimeMs) && Number.isInteger(s.durationMs!)).toBe(true);
  });
  it('treats an unknown, infinite or non-positive duration as unknown (null)', () => {
    for (const d of [Number.NaN, Number.POSITIVE_INFINITY, 0, -3]) {
      const el = document.createElement('video');
      installFakeVideo(el, d);
      expect(new VideoSurface(el).durationMs).toBeNull();
    }
  });
  it('seeks in seconds, clamped to [0, duration]: never beyond the media', () => {
    const { s, fake } = surface(60);
    s.seekToMs(12_500);
    s.seekToMs(70_000);
    s.seekToMs(-5);
    expect(fake.seeks).toEqual([12.5, 60, 0]);
  });
  it('ignores a non-finite seek', () => {
    const { s, fake } = surface(60);
    s.seekToMs(Number.NaN);
    s.seekToMs(Number.POSITIVE_INFINITY);
    expect(fake.seeks).toEqual([]);
  });
  it('reads and writes the muted flag and reads paused', () => {
    const { s, fake } = surface();
    expect(s.paused).toBe(true);
    s.muted = true;
    expect(fake.muted()).toBe(true);
    fake.play();
    expect(s.paused).toBe(false);
  });
});

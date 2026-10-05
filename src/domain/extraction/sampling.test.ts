import { DEFAULT_FRAME_SAMPLING, fitWithin, planFrameTimestamps } from './sampling';

const cfg = { intervalSeconds: 10, maxFrames: 300, maxWidth: 768, maxHeight: 768 };

describe('planFrameTimestamps', () => {
  it('samples the middle of each interval', () => {
    expect(planFrameTimestamps(30, cfg)).toEqual({ timestamps: [5, 15, 25], effectiveIntervalSeconds: 10 });
  });
  it('gives a video shorter than the interval one frame, inside the video', () => {
    expect(planFrameTimestamps(1, cfg)).toEqual({ timestamps: [0.5], effectiveIntervalSeconds: 1 });
    expect(planFrameTimestamps(0.04, cfg).timestamps).toEqual([0.02]);
  });
  it('divides a partial last interval equally so no timestamp falls past the end', () => {
    const plan = planFrameTimestamps(25, cfg); // ceil(25/10)=3 samples
    expect(plan.timestamps).toEqual([4.167, 12.5, 20.833]);
    expect(plan.timestamps.every((t) => t < 25)).toBe(true);
  });
  it('is deterministic: identical inputs give identical plans', () => {
    expect(planFrameTimestamps(1234.567, cfg)).toEqual(planFrameTimestamps(1234.567, cfg));
  });
  it('never exceeds maxFrames and stretches the interval to span the whole video', () => {
    const plan = planFrameTimestamps(3 * 3600, { ...cfg, intervalSeconds: 1, maxFrames: 100 });
    expect(plan.timestamps).toHaveLength(100);
    expect(plan.effectiveIntervalSeconds).toBe(108);
    expect(plan.timestamps[0]).toBe(54);
    expect(plan.timestamps.at(-1)).toBe(10746);
    expect(plan.timestamps.at(-1)!).toBeLessThan(3 * 3600);
  });
  it('bounds a pathological request (1 frame/ms on a 10 h video) to maxFrames', () => {
    const plan = planFrameTimestamps(36_000, { ...cfg, intervalSeconds: 0.001, maxFrames: 300 });
    expect(plan.timestamps.length).toBeLessThanOrEqual(300);
  });
  it('produces strictly increasing millisecond-precision timestamps inside the media', () => {
    const d = 1234.5678;
    const { timestamps } = planFrameTimestamps(d, cfg);
    timestamps.forEach((t, i) => {
      expect(Math.abs(t * 1000 - Math.round(t * 1000))).toBeLessThan(1e-6);
      expect(t).toBeLessThan(d);
      if (i > 0) expect(t).toBeGreaterThan(timestamps[i - 1]!);
    });
  });
  it('returns no frames for unknown or non-positive durations', () => {
    for (const d of [0, -5, NaN, Infinity]) expect(planFrameTimestamps(d, cfg).timestamps).toEqual([]);
  });
  it('exposes sensible defaults', () => {
    expect(DEFAULT_FRAME_SAMPLING).toEqual({ intervalSeconds: 10, maxFrames: 300, maxWidth: 768, maxHeight: 768 });
  });
});

describe('fitWithin', () => {
  it('shrinks 4K to the box preserving aspect ratio', () => {
    expect(fitWithin(3840, 2160, 768, 768)).toEqual({ width: 768, height: 432 });
  });
  it('handles portrait video', () => {
    expect(fitWithin(1080, 1920, 768, 768)).toEqual({ width: 432, height: 768 });
  });
  it('never upscales', () => {
    expect(fitWithin(160, 120, 768, 768)).toEqual({ width: 160, height: 120 });
  });
});

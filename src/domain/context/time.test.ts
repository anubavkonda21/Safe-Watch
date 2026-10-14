import { durationMs, gapMs, intervalsOverlap, isMs, isValidInterval, msToSeconds, toMs } from './time';

describe('media time', () => {
  it('converts fractional seconds to exact integer milliseconds', () => {
    expect(toMs(1.2)).toBe(1200);
    expect(toMs(0.1 + 0.2)).toBe(300); // 0.30000000000000004 would break exact comparisons
    expect(toMs(10.0005)).toBe(10001);
    expect(msToSeconds(1500)).toBe(1.5);
  });
  it('validates milliseconds and intervals', () => {
    for (const bad of [-1, 1.5, NaN, Infinity, '5', null, undefined, 2 ** 60]) expect(isMs(bad)).toBe(false);
    expect(isMs(0)).toBe(true);
    expect(isValidInterval({ startMs: 5, endMs: 5 })).toBe(true); // point observation
    expect(isValidInterval({ startMs: 6, endMs: 5 })).toBe(false);
    expect(isValidInterval({ startMs: -1, endMs: 5 })).toBe(false);
  });
  it('overlap includes touching ends; gap is the empty distance', () => {
    expect(intervalsOverlap({ startMs: 0, endMs: 10 }, { startMs: 10, endMs: 20 })).toBe(true);
    expect(intervalsOverlap({ startMs: 0, endMs: 10 }, { startMs: 11, endMs: 20 })).toBe(false);
    expect(gapMs({ startMs: 0, endMs: 10 }, { startMs: 25, endMs: 30 })).toBe(15);
    expect(gapMs({ startMs: 0, endMs: 10 }, { startMs: 5, endMs: 30 })).toBe(0);
    expect(durationMs({ startMs: 3, endMs: 10 })).toBe(7);
  });
});

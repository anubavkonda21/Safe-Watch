import { forwardTarget, SKIP_FORWARD_MS } from './seekForward';

describe('forwardTarget (+10 seconds)', () => {
  it('adds exactly ten seconds', () => {
    expect(SKIP_FORWARD_MS).toBe(10_000);
    expect(forwardTarget(5_000, 600_000)).toEqual({ targetMs: 15_000, moved: true });
    expect(forwardTarget(0, null)).toEqual({ targetMs: 10_000, moved: true });
  });

  it('keeps millisecond precision (no drift through repeated presses)', () => {
    let t = 1_234;
    for (let i = 0; i < 5; i++) t = forwardTarget(t, null)!.targetMs;
    expect(t).toBe(1_234 + 50_000);
  });

  it('never goes past the end when the length is known', () => {
    expect(forwardTarget(595_000, 600_000)).toEqual({ targetMs: 600_000, moved: true });
    expect(forwardTarget(600_000, 600_000)).toEqual({ targetMs: 600_000, moved: false });
  });

  it('never goes backward, even if the reading is beyond the length', () => {
    expect(forwardTarget(700_000, 600_000)).toEqual({ targetMs: 700_000, moved: false });
  });

  it('with an unknown or invalid length it still moves forward and does not invent a limit', () => {
    for (const d of [null, 0, -1, NaN, Infinity]) expect(forwardTarget(5_000, d as number | null)?.targetMs).toBe(15_000);
  });

  it('with an unknown or invalid position it does nothing (no guess)', () => {
    for (const c of [null, NaN, Infinity, -1]) expect(forwardTarget(c as number | null, 600_000)).toBeNull();
  });

  it('refuses a non-positive or invalid step', () => {
    for (const s of [0, -10_000, NaN]) expect(forwardTarget(5_000, 600_000, s)).toBeNull();
  });

  it('rounds a fractional reading to a whole millisecond first', () => {
    expect(forwardTarget(1_000.6, null)).toEqual({ targetMs: 11_001, moved: true });
  });
});

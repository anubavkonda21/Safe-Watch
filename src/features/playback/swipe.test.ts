import { dismissDistance, shouldDismiss, swipePhase, SWIPE_DISMISS_PX, SWIPE_START_PX } from './swipe';

describe('swipePhase', () => {
  it('a tiny movement is undecided (a tap or a click)', () => {
    expect(swipePhase(0, 0)).toBe('idle');
    expect(swipePhase(SWIPE_START_PX - 1, SWIPE_START_PX - 1)).toBe('idle');
  });
  it('a mostly horizontal movement is a swipe, in either direction', () => {
    expect(swipePhase(30, 2)).toBe('dragging');
    expect(swipePhase(-30, 5)).toBe('dragging');
  });
  it('a mostly vertical or diagonal movement is a scroll, not a swipe', () => {
    expect(swipePhase(2, 30)).toBe('ignored');
    expect(swipePhase(20, 20)).toBe('ignored');
    expect(swipePhase(-12, 40)).toBe('ignored');
  });
});

describe('shouldDismiss', () => {
  it('dismisses a long horizontal swipe, to the left or to the right', () => {
    expect(shouldDismiss(SWIPE_DISMISS_PX, 3, 600)).toBe(true);
    expect(shouldDismiss(-SWIPE_DISMISS_PX - 20, -8, 600)).toBe(true);
  });
  it('does not dismiss a short swipe', () => {
    expect(shouldDismiss(SWIPE_DISMISS_PX - 1, 0, 600)).toBe(false);
    expect(shouldDismiss(30, 0, 600)).toBe(false);
  });
  it('on a narrow card the distance is 30 % of its width (288 px → 86 → capped at 80)', () => {
    expect(dismissDistance(288)).toBe(80);
    expect(dismissDistance(200)).toBe(60);
    expect(shouldDismiss(61, 0, 200)).toBe(true);
    expect(shouldDismiss(59, 0, 200)).toBe(false);
  });
  it('a long drag that is mostly vertical never dismisses', () => {
    expect(shouldDismiss(90, 80, 600)).toBe(false);
    expect(shouldDismiss(0, 200, 600)).toBe(false);
  });
  it('an unknown card width falls back to the fixed distance', () => {
    expect(dismissDistance(NaN)).toBe(SWIPE_DISMISS_PX);
    expect(dismissDistance(0)).toBe(SWIPE_DISMISS_PX);
  });
});

/**
 * Swipe-to-dismiss, as a pure decision. A gesture is a horizontal drag of the pointer over the warning: far enough, and mostly
 * sideways, it dismisses; anything else is not a swipe (a tap, a vertical scroll, a short wobble) and does nothing.
 */
export const SWIPE_START_PX = 10; // how far the pointer must travel before the gesture is treated as a drag at all
export const SWIPE_DISMISS_PX = 80; // distance that dismisses (or 30 % of the card, if that is smaller)
export const SWIPE_DISMISS_FRACTION = 0.3;
export const SWIPE_DIRECTION_RATIO = 1.5; // horizontal travel must be at least this many times the vertical travel

export type SwipePhase = 'idle' | 'dragging' | 'ignored';

/** Decides what a movement of (dx, dy) from the start point means. */
export function swipePhase(dx: number, dy: number): SwipePhase {
  const ax = Math.abs(dx); const ay = Math.abs(dy);
  if (ax < SWIPE_START_PX && ay < SWIPE_START_PX) return 'idle';
  return ax >= ay * SWIPE_DIRECTION_RATIO && ax >= SWIPE_START_PX ? 'dragging' : 'ignored';
}

/** The distance at which releasing dismisses, for a card `widthPx` wide. */
export function dismissDistance(widthPx: number): number {
  const w = Number.isFinite(widthPx) && widthPx > 0 ? widthPx : Infinity;
  return Math.min(SWIPE_DISMISS_PX, SWIPE_DISMISS_FRACTION * w);
}

/** On release: does this drag dismiss the warning? */
export function shouldDismiss(dx: number, dy: number, widthPx: number): boolean {
  return swipePhase(dx, dy) === 'dragging' && Math.abs(dx) >= dismissDistance(widthPx);
}

/**
 * Canonical media time for context reasoning: INTEGER MILLISECONDS on the
 * original media timeline (never wall-clock time). Evidence arrives as
 * fractional seconds; converting once at the boundary keeps every later
 * comparison exact, so grouping can never depend on float rounding.
 */
export type Ms = number;

export const toMs = (seconds: number): Ms => Math.round(seconds * 1000);
export const msToSeconds = (ms: Ms): number => ms / 1000;

export interface MsInterval {
  startMs: Ms;
  /** Equal to `startMs` for a point observation. */
  endMs: Ms;
}

export const isMs = (v: unknown): v is Ms => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
export const isValidInterval = (i: MsInterval): boolean => isMs(i.startMs) && isMs(i.endMs) && i.endMs >= i.startMs;
export const durationMs = (i: MsInterval): Ms => i.endMs - i.startMs;
/** Intervals overlap when they share at least one instant (touching ends count: 10–11 and 11–12 overlap at 11). */
export const intervalsOverlap = (a: MsInterval, b: MsInterval): boolean => a.startMs <= b.endMs && b.startMs <= a.endMs;
/** Empty distance between two intervals; 0 when they overlap or touch. */
export const gapMs = (a: MsInterval, b: MsInterval): Ms => Math.max(0, Math.max(a.startMs, b.startMs) - Math.min(a.endMs, b.endMs));

import type { Ms } from '../context/time';

/** The size of the "skip forward" button. A plain, fixed step: it is not tied to any finding. */
export const SKIP_FORWARD_MS: Ms = 10_000;

export interface ForwardTarget {
  /** Where the playhead should go. Never before `currentMs`, never past the duration when it is known. */
  targetMs: Ms;
  /** False when the playhead is already at (or past) the end, so there is nowhere to go. */
  moved: boolean;
}

/**
 * Where "+10 seconds" lands. Pure: the step is added to the current position, clamped to the media length when it is known, and it
 * never moves the playhead backward (so a stale or out-of-range reading cannot send the viewer back). An unknown or invalid
 * position gives no move at all instead of a guess.
 */
export function forwardTarget(currentMs: number | null, durationMs: number | null, stepMs: Ms = SKIP_FORWARD_MS): ForwardTarget | null {
  if (currentMs === null || !Number.isFinite(currentMs) || currentMs < 0) return null;
  if (!Number.isFinite(stepMs) || stepMs <= 0) return null;
  const now = Math.round(currentMs);
  const known = durationMs !== null && Number.isFinite(durationMs) && durationMs > 0;
  const raw = now + Math.round(stepMs);
  const targetMs = known ? Math.min(raw, Math.round(durationMs)) : raw;
  const clamped = Math.max(targetMs, now); // never backward
  return { targetMs: clamped, moved: clamped > now };
}

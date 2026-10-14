import type { ContextEvent } from '@/domain/context/contextEvent';

export interface Placed {
  event: ContextEvent;
  /** Row of the timeline: events that overlap in time sit on different rows. */
  lane: number;
  /** Percent of the timeline width. */
  left: number;
  width: number;
}

const MIN_WIDTH = 1.5;

/**
 * Places events on a proportional timeline. Pure and deterministic: events
 * (already in chronological order) take the first row whose last event has
 * ended; a point or very short event gets a minimum width so it can be seen and tapped.
 */
export function layoutTimeline(events: readonly ContextEvent[], durationMs: number | null): { placed: Placed[]; lanes: number; totalMs: number } {
  const lastEnd = events.reduce((m, e) => Math.max(m, e.endMs), 0);
  const totalMs = Math.max(1, durationMs ?? 0, lastEnd);
  const laneEnds: number[] = [];
  const placed = events.map((event): Placed => {
    const free = laneEnds.findIndex((end) => end < event.startMs);
    const lane = free === -1 ? laneEnds.length : free;
    laneEnds[lane] = event.endMs;
    const rawLeft = (event.startMs / totalMs) * 100;
    const width = Math.min(100, Math.max(MIN_WIDTH, ((event.endMs - event.startMs) / totalMs) * 100));
    // An event at the very end is pulled back so its minimum width still fits on the track.
    const left = Math.min(rawLeft, 100 - width);
    return { event, lane, left: Number(left.toFixed(3)), width: Number(width.toFixed(3)) };
  });
  return { placed, lanes: Math.max(1, laneEnds.length), totalMs };
}

import { correlateEvidence } from '@/domain/context/correlate';
import { speech, subtitle, visual } from '@/test/context';
import { layoutTimeline } from './contextLayout';

const events = (items: Parameters<typeof correlateEvidence>[0]['evidence']) => correlateEvidence({ evidence: items }).events;

describe('layoutTimeline', () => {
  it('places events proportionally on the media duration', () => {
    const { placed, totalMs } = layoutTimeline(events([speech('a', 10, 20), speech('b', 60, 70)]), 100_000);
    expect(totalMs).toBe(100_000);
    expect(placed.map((p) => [p.left, p.width, p.lane])).toEqual([[10, 10, 0], [60, 10, 0]]);
  });
  it('gives points a visible minimum width and never lets an event leave the track', () => {
    const { placed } = layoutTimeline(events([visual('a', 0), visual('b', 100)]), 100_000);
    expect(placed[0]!.width).toBeGreaterThanOrEqual(1.5);
    expect(placed[1]!.left + placed[1]!.width).toBeLessThanOrEqual(100.0001);
  });
  it('puts events that overlap in time on different rows (long evidence beside the events inside it)', () => {
    const { placed, lanes } = layoutTimeline(events([subtitle('long', 10, 40), visual('v1', 12), visual('v2', 25)]), 60_000);
    expect(placed.map((p) => p.lane)).toEqual([0, 1, 1]);
    expect(lanes).toBe(2);
  });
  it('falls back to the last event when the duration is unknown or too short, and survives no events', () => {
    expect(layoutTimeline(events([speech('a', 0, 30)]), null).totalMs).toBe(30_000);
    expect(layoutTimeline(events([speech('a', 0, 30)]), 10_000).totalMs).toBe(30_000);
    expect(layoutTimeline([], null)).toEqual({ placed: [], lanes: 1, totalMs: 1 });
  });
  it('is deterministic', () => {
    const e = events([speech('a', 1, 2), visual('b', 1.5), speech('c', 30, 31)]);
    expect(layoutTimeline(e, 60_000)).toEqual(layoutTimeline(e, 60_000));
  });
});

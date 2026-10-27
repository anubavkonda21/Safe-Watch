import { overrideKeyOf } from '../playback/planning';
import type { SafetyFinding } from '../safety/finding';

/**
 * When findings come from captions the user adds WHILE watching, some of them are found after playback has already reached or
 * passed them. They must not be presented as advance warnings. Each finding remembers the playhead position (ms) at the moment
 * it was first found, and its outcome is judged against that:
 *   advance  found before playback began, or at least `leadMs` before it starts: a normal warning can be given;
 *   late     found less than `leadMs` before it starts: the warning comes late, with less notice than configured;
 *   missed   found after it had already started: no warning is possible (the scheduler never warns about a begun finding).
 * Pure; the keys are the same occurrence keys the playback choices use, so they survive a change of the phrase list.
 */
export type DiscoveryOutcome = 'advance' | 'late' | 'missed';

export function discoveryOutcome(startMs: number, foundAtMs: number, leadMs: number): DiscoveryOutcome {
  if (startMs <= foundAtMs) return 'missed';
  // Found before playback began: nothing could have been warned any earlier. A finding closer to the start of the video than the
  // lead time is simply early in the video, not found late (its warning shows the real time left, as for any local file).
  if (foundAtMs <= 0) return 'advance';
  return startMs - foundAtMs < leadMs ? 'late' : 'advance';
}

/** Adds the findings not seen before, stamped with the playhead position now. Findings already known keep their first stamp. */
export function recordDiscoveries(known: ReadonlyMap<string, number>, findings: readonly SafetyFinding[], playheadMs: number): Map<string, number> {
  const next = new Map(known);
  const at = Number.isFinite(playheadMs) && playheadMs > 0 ? Math.round(playheadMs) : 0;
  for (const f of findings) {
    const key = overrideKeyOf(f);
    if (!next.has(key)) next.set(key, at);
  }
  return next;
}

export interface DiscoverySummary { advance: number; late: number; missed: number }

export function summarizeDiscoveries(known: ReadonlyMap<string, number>, findings: readonly SafetyFinding[], leadMs: number): DiscoverySummary {
  const out: DiscoverySummary = { advance: 0, late: 0, missed: 0 };
  for (const f of findings) {
    const at = known.get(overrideKeyOf(f));
    if (at === undefined) continue;
    out[discoveryOutcome(f.startMs, at, leadMs)] += 1;
  }
  return out;
}

export function describeDiscovery(s: DiscoverySummary, leadSeconds: number): string | null {
  const parts: string[] = [];
  if (s.missed > 0) parts.push(`${s.missed} ${s.missed === 1 ? 'finding was' : 'findings were'} found after playback had already reached ${s.missed === 1 ? 'it' : 'them'}, so no warning is possible for ${s.missed === 1 ? 'it' : 'them'}.`);
  if (s.late > 0) parts.push(`${s.late} ${s.late === 1 ? 'finding was' : 'findings were'} found less than ${leadSeconds} seconds before ${s.late === 1 ? 'it starts' : 'they start'}, so ${s.late === 1 ? 'its warning is' : 'their warnings are'} late.`);
  return parts.length === 0 ? null : parts.join(' ');
}

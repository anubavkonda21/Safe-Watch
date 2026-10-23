import type { FindingActionView } from '../playback/actions';
import type { Ms } from '../context/time';

/**
 * A heads-up is about a MOMENT, not a single finding: findings whose action intervals overlap or touch are one group and get one
 * warning (so the user is never shown a stack of alerts), and the group remembers every finding it covers.
 */
export interface WarningMember {
  findingId: string;
  /** Identity of the occurrence (stable across term-list changes): the key the user's choices are stored under. */
  overrideKey: string;
  term: string | null;
  uncertain: boolean;
  /** `none`, `mute` or `skip` (ignored findings are never warned about). */
  choice: 'none' | 'mute' | 'skip';
}

export interface WarningGroup {
  /** The member keys joined: stable while the same findings are in the group, so state survives re-renders and new analyses. */
  id: string;
  /** The first moment a player would act (the action interval's start): the warning is about this. */
  startMs: Ms;
  endMs: Ms;
  members: WarningMember[];
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Builds the groups worth warning about. Excluded, always: unavailable findings (invalid, zero-length, outside the media,
 * unsupported category), findings the user ignored, and anything without a valid interval. Pure and deterministic.
 */
export function buildWarningGroups(views: readonly FindingActionView[]): WarningGroup[] {
  const eligible = views
    .filter((v) => v.candidate.availability === 'available' && v.state !== 'unavailable' && v.state !== 'ignored')
    .filter((v) => Number.isSafeInteger(v.candidate.startMs) && Number.isSafeInteger(v.candidate.endMs) && v.candidate.endMs > v.candidate.startMs && v.candidate.startMs >= 0)
    .sort((a, b) => a.candidate.startMs - b.candidate.startMs || a.candidate.endMs - b.candidate.endMs || cmp(a.candidate.overrideKey, b.candidate.overrideKey));
  const groups: Array<{ startMs: Ms; endMs: Ms; members: WarningMember[] }> = [];
  for (const v of eligible) {
    const c = v.candidate;
    const member: WarningMember = { findingId: c.findingId, overrideKey: c.overrideKey, term: c.term, uncertain: c.findingStatus === 'uncertain', choice: v.choice === 'mute' || v.choice === 'skip' ? v.choice : 'none' };
    const last = groups[groups.length - 1];
    if (last && c.startMs <= last.endMs) { last.endMs = Math.max(last.endMs, c.endMs); last.members.push(member); } else groups.push({ startMs: c.startMs, endMs: c.endMs, members: [member] });
  }
  return groups.map((g) => ({ ...g, id: g.members.map((m) => m.overrideKey).join('||') }));
}

import { view } from '@/test/warnings';
import { buildWarningGroups } from './groups';

const v = (key: string, startMs: number, endMs: number, over: Parameters<typeof view>[0] = {}, choice: Parameters<typeof view>[1] = 'none', state: Parameters<typeof view>[2] = 'none') =>
  view({ overrideKey: key, findingId: `f-${key}`, term: key, startMs, endMs, ...over }, choice, state);

describe('buildWarningGroups: what is worth a warning', () => {
  it('excludes unavailable findings of every kind, ignored findings and invalid intervals', () => {
    const groups = buildWarningGroups([
      v('zero', 5_000, 5_000, { availability: 'unavailable', unavailableReason: 'zero-length' }, 'none', 'unavailable'),
      v('outside', 90_000, 91_000, { availability: 'unavailable', unavailableReason: 'outside-media' }, 'none', 'unavailable'),
      v('unsupported', 10_000, 11_000, { availability: 'unavailable', unavailableReason: 'unsupported-category' }, 'none', 'unavailable'),
      v('invalid', 10_000, 11_000, { availability: 'unavailable', unavailableReason: 'invalid-finding' }, 'none', 'unavailable'),
      v('ignored', 20_000, 21_000, {}, 'ignore', 'ignored'),
      v('inverted', 9_000, 8_000),
      v('negative', -5, 500),
      v('fractional', 1000.5, 2000),
      v('empty', 7_000, 7_000),
      v('ok', 30_000, 31_000),
    ]);
    expect(groups.map((g) => g.id)).toEqual(['ok']);
  });
  it('includes undecided, muted, skipped and uncertain findings (a warning is a heads-up, not an action)', () => {
    const groups = buildWarningGroups([v('a', 10_000, 11_000), v('b', 20_000, 21_000, {}, 'mute', 'enabled'), v('c', 30_000, 31_000, {}, 'skip', 'off'), v('d', 40_000, 41_000, { findingStatus: 'uncertain' })]);
    expect(groups.map((g) => [g.id, g.members[0]!.choice, g.members[0]!.uncertain])).toEqual([['a', 'none', false], ['b', 'mute', false], ['c', 'skip', false], ['d', 'none', true]]);
  });
  it('plans nothing without findings', () => { expect(buildWarningGroups([])).toEqual([]); });
});

describe('buildWarningGroups: overlap and adjacency', () => {
  it('merges overlapping and directly adjacent intervals into ONE group that remembers every finding', () => {
    const groups = buildWarningGroups([v('a', 10_000, 12_000), v('b', 11_000, 14_000), v('c', 14_000, 15_000), v('d', 20_000, 21_000)]);
    expect(groups.map((g) => [g.startMs, g.endMs, g.members.map((m) => m.findingId)])).toEqual([[10_000, 15_000, ['f-a', 'f-b', 'f-c']], [20_000, 21_000, ['f-d']]]);
  });
  it('keeps a one-millisecond gap as two groups', () => {
    expect(buildWarningGroups([v('a', 10_000, 11_000), v('b', 11_001, 12_000)])).toHaveLength(2);
  });
  it('findings at the same timestamp are one group', () => {
    expect(buildWarningGroups([v('a', 10_000, 11_000), v('b', 10_000, 11_000), v('c', 10_000, 10_500)])).toHaveLength(1);
  });
  it('is deterministic whatever the input order, and the id is stable across re-plans', () => {
    const items = [v('a', 10_000, 12_000), v('b', 11_000, 14_000), v('c', 30_000, 31_000)];
    expect(buildWarningGroups([...items].reverse())).toEqual(buildWarningGroups(items));
    expect(buildWarningGroups(items)[0]!.id).toBe(buildWarningGroups(items.map((x) => ({ ...x, choice: 'skip' as const })))[0]!.id);
  });
  it('the group starts at the first action interval start, which is when a player would act', () => {
    const [g] = buildWarningGroups([v('a', 9_850, 10_750, {}, 'none')]);
    expect(g!.startMs).toBe(9_850);
  });
});

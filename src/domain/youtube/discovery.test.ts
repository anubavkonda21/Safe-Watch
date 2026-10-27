import { analysisWith, finding } from '@/test/safetyFindings';
import { describeDiscovery, discoveryOutcome, recordDiscoveries, summarizeDiscoveries } from './discovery';

describe('discoveryOutcome', () => {
  it('advance: found at least the lead time before the start', () => {
    expect(discoveryOutcome(30_000, 0, 20_000)).toBe('advance');
    expect(discoveryOutcome(30_000, 10_000, 20_000)).toBe('advance'); // exactly the lead: still on time
  });
  it('late: found closer than the lead time, but before it starts', () => {
    expect(discoveryOutcome(30_000, 10_001, 20_000)).toBe('late');
    expect(discoveryOutcome(30_000, 29_999, 20_000)).toBe('late');
  });
  it('missed: found once it had started or passed (never presented as a warning)', () => {
    expect(discoveryOutcome(30_000, 30_000, 20_000)).toBe('missed');
    expect(discoveryOutcome(30_000, 45_000, 20_000)).toBe('missed');
  });
  it('found before playback began is never "late", even for a finding closer to the start than the lead time', () => {
    expect(discoveryOutcome(9_000, 0, 20_000)).toBe('advance'); // found as early as possible: it is just early in the video
    expect(discoveryOutcome(0, 0, 20_000)).toBe('missed'); // a finding that starts at 0 is already under way
  });
  it('honours a different lead time (found while playing)', () => {
    expect(discoveryOutcome(30_000, 1_000, 40_000)).toBe('late');
    expect(discoveryOutcome(30_000, 1_000, 10_000)).toBe('advance');
  });
});

describe('recordDiscoveries / summarizeDiscoveries', () => {
  const a = finding({ id: 'f1', startMs: 30_000, endMs: 32_000 });
  const b = finding({ id: 'f2', startMs: 50_000, endMs: 52_000 });

  it('stamps new findings with the playhead and never changes an earlier stamp', () => {
    const first = recordDiscoveries(new Map(), [a], 5_000);
    const second = recordDiscoveries(first, [a, b], 40_000);
    expect([...second.values()]).toEqual([5_000, 40_000]);
  });

  it('a finding found before playback started is stamped 0 (everything is in advance)', async () => {
    const analysis = await analysisWith([a, b]);
    const known = recordDiscoveries(new Map(), analysis.findings, 0);
    expect(summarizeDiscoveries(known, analysis.findings, 20_000)).toEqual({ advance: 2, late: 0, missed: 0 });
    expect(summarizeDiscoveries(known, analysis.findings, 60_000)).toEqual({ advance: 2, late: 0, missed: 0 }); // even with a long lead
  });

  it('counts advance, late and missed separately, and ignores findings it has no stamp for', async () => {
    const analysis = await analysisWith([a, b]);
    const known = recordDiscoveries(new Map(), analysis.findings, 40_000); // 30 s one is behind us, the 50 s one is 10 s away
    expect(summarizeDiscoveries(known, analysis.findings, 20_000)).toEqual({ advance: 0, late: 1, missed: 1 });
    expect(summarizeDiscoveries(new Map(), analysis.findings, 20_000)).toEqual({ advance: 0, late: 0, missed: 0 });
  });

  it('survives a change of the phrase list: the key is the occurrence, not the finding id', () => {
    const renumbered = finding({ id: 'other-id', startMs: 30_000, endMs: 32_000 });
    const known = recordDiscoveries(new Map(), [a], 1_000);
    expect(recordDiscoveries(known, [renumbered], 50_000)).toEqual(known);
  });
});

describe('describeDiscovery', () => {
  it('says nothing when everything was found in advance', () => {
    expect(describeDiscovery({ advance: 3, late: 0, missed: 0 }, 20)).toBeNull();
  });
  it('reports missed and late findings in plain words, with the configured lead time', () => {
    expect(describeDiscovery({ advance: 0, late: 0, missed: 1 }, 20)).toBe('1 finding was found after playback had already reached it, so no warning is possible for it.');
    expect(describeDiscovery({ advance: 0, late: 2, missed: 2 }, 20)).toMatch(/2 findings were found after playback had already reached them.*2 findings were found less than 20 seconds before they start, so their warnings are late\./);
  });
});

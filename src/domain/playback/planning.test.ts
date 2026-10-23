import type { SafetyAnalysis, SafetyFinding } from '@/domain/safety/finding';
import { analysisWith, finding } from '@/test/safetyFindings';
import { safetyFor } from '@/test/safetyAnalysis';
import { PLAYBACK_POLICY, overrideKeyOf, planCandidates, timingQualityOf } from './planning';

const plan = async (findings: SafetyFinding[], durationMs: number | null = 60_000, status: SafetyAnalysis['status'] = 'ready') => planCandidates({ mediaId: 'm', analysis: await analysisWith(findings, status), durationMs });

describe('planCandidates: intervals', () => {
  it('uses the CP7 finding as is and adds only the documented margin for word timing', async () => {
    const [c] = await plan([finding()]);
    expect(c).toMatchObject({ id: 'pa-sf-flagged-terms-0000', mediaId: 'm', findingId: 'sf-flagged-terms-0000', category: 'flagged-terms', findingStatus: 'detected', term: 'Darn', availability: 'available', unavailableReason: null });
    expect([c!.findingStartMs, c!.findingEndMs]).toEqual([10_000, 10_500]);
    expect([c!.startMs, c!.endMs]).toEqual([10_000 - PLAYBACK_POLICY.word.beforeMs, 10_500 + PLAYBACK_POLICY.word.afterMs]);
    expect(c!.timing).toMatchObject({ quality: 'word', startApproximate: true, endApproximate: true, marginBeforeMs: 150, marginAfterMs: 250 });
  });
  it('subtitle cues are exact (no margin) and say they cover the whole line; speech-only coarse timing is a whole segment', async () => {
    const cue = finding({ warnings: ['coarse-timing'], evidence: [{ ...finding().evidence[0]!, modality: 'subtitle', kind: 'subtitle', sourceConfidence: null }] });
    const seg = finding({ id: 'sf-flagged-terms-0001', warnings: ['coarse-timing'] });
    const [a, b] = await plan([cue, seg]);
    expect(timingQualityOf(cue)).toBe('cue');
    expect(a).toMatchObject({ startMs: 10_000, endMs: 10_500, timing: { quality: 'cue', startApproximate: false, endApproximate: false } });
    expect(a!.timing.note).toMatch(/exact as written.*whole line/);
    expect(b).toMatchObject({ startMs: 10_000, endMs: 10_500, timing: { quality: 'segment', endApproximate: true } });
    expect(b!.timing.note).toMatch(/whole recognized segment/);
  });
  it('a finding supported by both speech and a subtitle uses cue timing (its interval is the cue)', async () => {
    const both = finding({ warnings: ['coarse-timing'], evidence: [finding().evidence[0]!, { ...finding().evidence[0]!, evidenceId: 'e2', modality: 'subtitle', kind: 'subtitle', sourceConfidence: null }] });
    expect(timingQualityOf(both)).toBe('cue');
  });
  it('clamps the margin at 0 and at the media end (unambiguous), and nowhere else', async () => {
    const [start, end] = await plan([finding({ startMs: 50, endMs: 400 }), finding({ id: 'sf-flagged-terms-0001', startMs: 59_700, endMs: 59_900 })], 60_000);
    expect(start).toMatchObject({ startMs: 0, endMs: 650 });
    expect(end).toMatchObject({ startMs: 59_550, endMs: 60_000 });
  });
  it('without a known duration there is no upper clamp', async () => {
    const [c] = await plan([finding({ startMs: 59_700, endMs: 59_900 })], null);
    expect(c!.endMs).toBe(60_150);
  });
  it('is deterministic and does not mutate the analysis', async () => {
    const analysis = await analysisWith([finding()]);
    const before = JSON.stringify(analysis);
    const a = planCandidates({ mediaId: 'm', analysis, durationMs: 60_000 });
    const b = planCandidates({ mediaId: 'm', analysis, durationMs: 60_000 });
    expect(a).toEqual(b);
    expect(JSON.stringify(analysis)).toBe(before);
  });
});

describe('planCandidates: what is NOT actionable (never repaired, never invented)', () => {
  it.each([
    ['a zero-length interval', { startMs: 5000, endMs: 5000 }, 'zero-length'],
    ['an interval entirely outside the media', { startMs: 70_000, endMs: 71_000 }, 'outside-media'],
    ['an interval that starts exactly at the media end', { startMs: 60_000, endMs: 60_500 }, 'outside-media'],
    ['an inverted interval', { startMs: 9000, endMs: 5000 }, 'invalid-finding'],
    ['a negative start', { startMs: -5, endMs: 500 }, 'invalid-finding'],
    ['a fractional start', { startMs: 5000.5, endMs: 6000 }, 'invalid-finding'],
    ['a non-finite end', { endMs: Number.POSITIVE_INFINITY }, 'invalid-finding'],
    ['a NaN start', { startMs: Number.NaN }, 'invalid-finding'],
    ['another taxonomy version', { taxonomyVersion: 'old' }, 'invalid-finding'],
    ['no evidence', { evidence: [] }, 'invalid-finding'],
    ['an unsupported category', { category: 'violence' as never }, 'unsupported-category'],
  ])('%s is unavailable with its reason, and keeps the finding’s own times', async (_n, over, reason) => {
    const f = finding(over as Partial<SafetyFinding>);
    const [c] = await plan([f]);
    expect(c).toMatchObject({ availability: 'unavailable', unavailableReason: reason });
    expect([c!.startMs, c!.endMs]).toEqual([f.startMs, f.endMs]);
  });
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5])('an invalid media duration (%s) makes every candidate unavailable', async (d) => {
    const cs = await plan([finding(), finding({ id: 'sf-flagged-terms-0001', startMs: 20_000, endMs: 21_000 })], d);
    expect(cs.every((c) => c.availability === 'unavailable' && c.unavailableReason === 'invalid-duration')).toBe(true);
  });
  it('one bad finding does not hide the good ones', async () => {
    const cs = await plan([finding({ startMs: 5000, endMs: 5000 }), finding({ id: 'sf-flagged-terms-0001', startMs: 8000, endMs: 8500 })]);
    expect(cs.map((c) => c.availability)).toEqual(['unavailable', 'available']);
  });
  it('plans nothing while the analysis is pending, missing, or has no findings', async () => {
    expect(planCandidates({ mediaId: 'm', analysis: null, durationMs: 1000 })).toEqual([]);
    expect(await plan([finding()], 60_000, 'pending')).toEqual([]);
    expect(await plan([])).toEqual([]);
  });
  it('plans a partial analysis (its findings are real) and carries uncertainty and warnings through', async () => {
    const [c] = await plan([finding({ status: 'uncertain', warnings: ['low-source-confidence', 'subtitle-disagrees'] })], 60_000, 'partial');
    expect(c).toMatchObject({ availability: 'available', findingStatus: 'uncertain', warnings: ['low-source-confidence', 'subtitle-disagrees'] });
  });
});

describe('override key', () => {
  it('identifies the occurrence (category, range, term) and survives renumbering of the finding id', () => {
    const a = finding({ id: 'sf-flagged-terms-0000' });
    const b = finding({ id: 'sf-flagged-terms-0007' });
    expect(overrideKeyOf(a)).toBe(overrideKeyOf(b));
    expect(overrideKeyOf(a)).not.toBe(overrideKeyOf(finding({ startMs: 10_001 })));
    expect(overrideKeyOf(a)).not.toBe(overrideKeyOf(finding({ attributes: { term: 'other', matchMode: 'x', matchedText: 'x' } })));
    expect(overrideKeyOf(finding({ attributes: { term: 'DARN', matchMode: 'x', matchedText: 'x' } }))).toBe(overrideKeyOf(finding({ attributes: { term: 'darn', matchMode: 'y', matchedText: 'y' } })));
  });
});

describe('real findings from the CP7 classifier', () => {
  it('plans the real findings of the shared fixtures and none of them is unsupported', async () => {
    const analysis = await safetyFor('m', [['safe watch', 'phrase'], ['written', 'case-insensitive']]);
    const cs = planCandidates({ mediaId: 'm', analysis, durationMs: 24_000 });
    expect(cs.length).toBe(analysis.findings.length);
    expect(cs.every((c) => c.availability === 'available' && c.category === 'flagged-terms')).toBe(true);
  });
});

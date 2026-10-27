import { createCustomFilter, type CustomFilter } from '../text/customFilter';
import { validateSafetyAnalysis } from '../safety/finding';
import { planCandidates } from '../playback/planning';
import { analyzeCaptions, youTubeMediaId } from './analysis';
import { parseCaptionFile } from './captions';

const term = (phrase: string, mode: 'exact' | 'word-boundary' | 'phrase' = 'phrase', enabled = true): CustomFilter => {
  const r = createCustomFilter(phrase, mode, [], { id: `t-${phrase}`, now: '2026-01-01T00:00:00.000Z' });
  if (!r.ok) throw new Error('bad test term');
  return { ...r.filter, enabled };
};
const ID = 'dQw4w9WgXcQ';
const captions = (srt: string) => { const p = parseCaptionFile(srt); if (!p.ok) throw new Error('bad captions'); return p.cues; };
const SRT = '1\n00:00:01,000 --> 00:00:03,000\nNothing to see here.\n\n2\n00:00:30,000 --> 00:00:33,000\nThe darn thing broke again.\n\n3\n00:01:10,000 --> 00:01:12,000\nDARN it, said Darn.\n';

describe('analyzeCaptions (user-provided captions for a YouTube video)', () => {
  it('finds the user’s phrase in the captions with exact cue times and ties it to subtitle evidence', async () => {
    const a = await analyzeCaptions({ videoId: ID, cues: captions(SRT), terms: [term('darn', 'word-boundary')], durationMs: 120_000 });
    expect(a.mediaId).toBe(youTubeMediaId(ID));
    expect(validateSafetyAnalysis(a)).toEqual([]);
    expect(a.findings.map((f) => [f.startMs, f.endMs, f.category])).toEqual([[30_000, 33_000, 'flagged-terms'], [70_000, 72_000, 'flagged-terms']].map(([s, e, c]) => [s, e, c]));
    for (const f of a.findings) {
      expect(new Set(f.evidence.map((e) => e.modality))).toEqual(new Set(['subtitle'])); // never speech, never visual
      expect(f.attributes?.term.toLowerCase()).toBe('darn');
    }
  });

  it('is PARTIAL by construction: speech and visual inputs are reported as not available', async () => {
    const a = await analyzeCaptions({ videoId: ID, cues: captions(SRT), terms: [term('darn', 'word-boundary')], durationMs: 120_000 });
    expect(a.status).toBe('partial');
    expect(a.inputs).toEqual({ speech: 'not-enabled', subtitles: 'used', visual: 'not-enabled' });
    const flagged = a.categories.find((c) => c.category === 'flagged-terms')!;
    expect(flagged.modalities.evaluated).toEqual(['subtitle']);
    expect(flagged.modalities.missing).toContain('speech');
  });

  it('keeps unsupported categories unsupported and never produces findings for them', async () => {
    const a = await analyzeCaptions({ videoId: ID, cues: captions(SRT), terms: [term('darn', 'word-boundary')], durationMs: null });
    for (const id of ['sexual-content', 'violence', 'graphic-injury', 'drug-content']) {
      const c = a.categories.find((x) => x.category === id)!;
      expect(c.support).toBe('unsupported');
      expect(c.findingCount).toBe(0);
    }
    expect(a.findings.every((f) => f.category === 'flagged-terms')).toBe(true);
  });

  it('with no enabled terms there are no findings and nothing is claimed as evaluated', async () => {
    const none = await analyzeCaptions({ videoId: ID, cues: captions(SRT), terms: [], durationMs: 120_000 });
    expect(none.findings).toEqual([]);
    const off = await analyzeCaptions({ videoId: ID, cues: captions(SRT), terms: [term('darn', 'word-boundary', false)], durationMs: 120_000 });
    expect(off.findings).toEqual([]);
  });

  it('a phrase that is not in the captions is not a finding (and "absent" is not "safe": the text only covers the captions)', async () => {
    const a = await analyzeCaptions({ videoId: ID, cues: captions(SRT), terms: [term('unicorn', 'word-boundary')], durationMs: 120_000 });
    expect(a.findings).toEqual([]);
    expect(a.status).toBe('partial');
  });

  it('the same input always gives the same result', async () => {
    const run = () => analyzeCaptions({ videoId: ID, cues: captions(SRT), terms: [term('darn', 'word-boundary')], durationMs: 120_000 });
    expect(await run()).toEqual(await run());
  });

  it('feeds the existing playback planner: cue-timed findings become actionable candidates with exact timing', async () => {
    const a = await analyzeCaptions({ videoId: ID, cues: captions(SRT), terms: [term('darn', 'word-boundary')], durationMs: 120_000 });
    const candidates = planCandidates({ mediaId: a.mediaId, analysis: a, durationMs: 120_000 });
    expect(candidates).toHaveLength(2);
    expect(candidates.every((c) => c.availability === 'available' && c.timing.quality === 'cue')).toBe(true);
  });

  it('rejects anything that is not a valid video id (the id names the analysis)', async () => {
    await expect(analyzeCaptions({ videoId: '../etc/passwd', cues: [], terms: [], durationMs: null })).rejects.toThrow();
  });
});

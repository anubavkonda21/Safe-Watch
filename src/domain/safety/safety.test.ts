import { buildContextAnalysis, type ContextAnalysis } from '@/domain/context/contextAnalysis';
import { createCustomFilter, type CustomFilter, type MatchMode } from '@/domain/text/customFilter';
import type { TextEvent } from '@/domain/text/textEvent';
import { readyTextAnalysis } from '@/test/textAnalysis';
import { readyVisual } from '@/test/visualAnalysis';
import { shuffled } from '@/test/context';
import { analyzeSafety, DEFAULT_CLASSIFIERS } from './analyze';
import type { CategoryResult, SafetyClassifier } from './classifier';
import { FlaggedTermClassifier } from './flaggedTerms';
import { validateFinding, validateSafetyAnalysis, type SafetyFinding } from './finding';
import { CATEGORY_IDS, TAXONOMY, TAXONOMY_VERSION, categoryById, isCategoryId } from './taxonomy';

const term = (phrase: string, mode: MatchMode = 'word-boundary', enabled = true): CustomFilter => {
  const r = createCustomFilter(phrase, mode, [], { id: `t-${phrase}-${mode}`, now: '2026-01-01T00:00:00.000Z' });
  if (!r.ok) throw new Error(r.reason);
  return { ...r.filter, enabled };
};
const ctx = (text = readyTextAnalysis('m')): ContextAnalysis => buildContextAnalysis({ mediaId: 'm', extractionStatus: 'completed', mediaDurationSeconds: 24, text, visual: readyVisual('m'), frameStepSeconds: 3 });

describe('taxonomy', () => {
  it('is versioned and covers every category with its definition, limits and real support status', () => {
    expect(TAXONOMY_VERSION).toBe('safewatch-taxonomy-1');
    expect(TAXONOMY.map((c) => c.id)).toEqual([...CATEGORY_IDS]);
    for (const c of TAXONOMY) { expect(c.label.length).toBeGreaterThan(5); for (const k of ['positive', 'notPositive', 'limitations'] as const) expect(c[k].length).toBeGreaterThan(20); }
    expect(isCategoryId('violence')).toBe(true);
    expect(isCategoryId('safe')).toBe(false);
  });
  it('claims only what exists: flagged terms is implemented for text; every visual or semantic category is unsupported and says why', () => {
    expect(TAXONOMY.filter((c) => c.support === 'implemented').map((c) => c.id)).toEqual(['flagged-terms']);
    expect(categoryById('flagged-terms').modalities).toEqual(['speech', 'subtitle']);
    for (const c of TAXONOMY.filter((x) => x.id !== 'flagged-terms')) {
      expect(c.support).toBe('unsupported');
      expect(c.modalities).toEqual([]);
      expect(c.blocker).toMatch(/.{40}/);
    }
    expect(categoryById('flagged-terms').blocker).toBeNull();
  });
  it('does not treat object labels or people as evidence of any category', () => {
    for (const id of ['sexual-content', 'violence', 'graphic-injury', 'drug-content'] as const) expect(categoryById(id).limitations + categoryById(id).notPositive).toMatch(/not|never|alone|only|without/i);
    expect(categoryById('violence').notPositive).toMatch(/weapon/i);
    expect(categoryById('sexual-content').notPositive).toMatch(/person/i);
    expect(categoryById('drug-content').notPositive).toMatch(/educational/i);
  });
});

const finding = (over: Partial<SafetyFinding> = {}): SafetyFinding => ({
  id: 'sf-flagged-terms-0000', category: 'flagged-terms', taxonomyVersion: TAXONOMY_VERSION, startMs: 1000, endMs: 2000, status: 'detected', rawScore: null, calibratedProbability: null,
  evidence: [{ evidenceId: 'e', modality: 'speech', kind: 'speech', startMs: 1000, endMs: 2000, sourceId: 'aud-0', contextEventId: null, sourceConfidence: 0.9 }],
  explanation: 'x', warnings: [], classifier: { id: 'c', version: '1', kind: 'rule-based' }, attributes: null, ...over,
});

describe('finding contract validation (rejects, never repairs)', () => {
  it('accepts a valid finding', () => { expect(validateFinding(finding())).toEqual([]); });
  it.each([
    ['inverted range', { startMs: 2000, endMs: 1000 }, 'invalid time range'],
    ['negative start', { startMs: -1 }, 'invalid time range'],
    ['fractional ms', { startMs: 1000.5 }, 'invalid time range'],
    ['NaN end', { endMs: NaN }, 'invalid time range'],
    ['unknown category', { category: 'safe' as never }, 'unknown category'],
    ['other taxonomy version', { taxonomyVersion: 'old' }, 'taxonomy version mismatch'],
    ['no evidence', { evidence: [] }, 'no evidence'],
    ['status outside the contract', { status: 'unsupported' as never }, 'invalid status'],
    ['uncertain without a reason', { status: 'uncertain' as const }, 'uncertain without a reason'],
    ['calibrated probability without a raw score', { calibratedProbability: 0.7 }, 'calibrated probability without a raw score'],
    ['probability above 1', { rawScore: 3, calibratedProbability: 1.5 }, 'invalid calibratedProbability'],
    ['empty explanation', { explanation: '' }, 'missing explanation'],
  ])('%s', (_n, over, problem) => { expect(validateFinding(finding(over as Partial<SafetyFinding>))).toContain(problem); });
  it('requires evidence to lie inside the finding and its source confidence to be a probability', () => {
    expect(validateFinding(finding({ evidence: [{ ...finding().evidence[0]!, endMs: 3000 }] })).join()).toContain('outside the finding');
    expect(validateFinding(finding({ evidence: [{ ...finding().evidence[0]!, sourceConfidence: 7 }] })).join()).toContain('invalid source confidence');
  });
});

describe('FlaggedTermClassifier', () => {
  const run = (terms: CustomFilter[], text = readyTextAnalysis('m'), context = ctx(text)) => analyzeSafety({ mediaId: 'm', context, text, terms });

  it('finds a term in the real CP4 fixture with evidence references, the source confidence and the context event that holds it', async () => {
    const a = await run([term('safe watch', 'phrase')]);
    expect(a.status).toBe('ready');
    const f = a.findings[0]!;
    expect(f).toMatchObject({ id: 'sf-flagged-terms-0000', category: 'flagged-terms', taxonomyVersion: TAXONOMY_VERSION, status: 'detected', rawScore: null, calibratedProbability: null });
    expect(f.classifier).toEqual({ id: 'flagged-terms-matcher', version: '1', kind: 'rule-based' });
    expect(f.evidence.map((e) => e.modality).sort()).toEqual(['speech', 'subtitle']);
    expect(f.evidence.find((e) => e.modality === 'speech')).toMatchObject({ sourceConfidence: expect.any(Number), contextEventId: 'ctx-0000' });
    expect(f.evidence.find((e) => e.modality === 'subtitle')!.sourceConfidence).toBeNull();
    expect(f.explanation).toContain('“safe watch”');
    expect(validateSafetyAnalysis(a)).toEqual([]);
  });
  it('never turns evidence it did not read into a finding: visual observations, people and OCR text are ignored', async () => {
    const a = await run([term('STOP', 'exact'), term('person'), term('living room', 'phrase')]);
    expect(a.findings).toEqual([]);
    expect(a.categories.find((c) => c.category === 'flagged-terms')).toMatchObject({ evaluation: 'evaluated', findingCount: 0 });
  });
  it('lists the WHOLE taxonomy: unsupported categories are reported as not supported, never as clean', async () => {
    const a = await run([term('safe watch', 'phrase')]);
    expect(a.categories.map((c) => c.category)).toEqual([...CATEGORY_IDS]);
    for (const c of a.categories.filter((x) => x.category !== 'flagged-terms')) expect(c).toMatchObject({ support: 'unsupported', evaluation: 'not-supported', reason: 'no-classifier', findingCount: 0 });
    expect(a.categories.find((c) => c.category === 'flagged-terms')).toMatchObject({ support: 'implemented', evaluation: 'evaluated', modalities: { evaluated: ['speech', 'subtitle'], missing: [] } });
  });
  it('abstains instead of returning a clean result when there are no terms, or every term is disabled', async () => {
    for (const terms of [[], [term('safe watch', 'phrase', false)]]) {
      const a = await run(terms);
      expect(a.status).toBe('not-evaluated');
      expect(a.categories.find((c) => c.category === 'flagged-terms')).toMatchObject({ evaluation: 'abstained', reason: 'no-terms-configured' });
      expect(a.termCount).toBe(0);
    }
  });
  it('is deterministic and independent of evidence order', async () => {
    const t = readyTextAnalysis('m');
    const terms = [term('safe watch', 'phrase'), term('sentence', 'case-insensitive')];
    const base = JSON.stringify(await run(terms, t));
    for (let i = 0; i < 3; i++) expect(JSON.stringify(await run(terms, t))).toBe(base);
    for (const seed of [1, 2, 3]) {
      const mixed = { ...t, timeline: shuffled(t.timeline, seed) };
      expect(JSON.stringify(await run(terms, mixed, ctx(t)))).toBe(base);
    }
  });
  it('does not mutate the evidence or the terms', async () => {
    const t = readyTextAnalysis('m');
    const c = ctx(t);
    const terms = [term('safe watch', 'phrase')];
    const before = JSON.stringify([t, c, terms]);
    await run(terms, t, c);
    expect(JSON.stringify([t, c, terms])).toBe(before);
  });
  it('findings are chronological with deterministic ids', async () => {
    const a = await run([term('test', 'case-insensitive'), term('sentence', 'case-insensitive'), term('only', 'case-insensitive')]);
    expect(a.findings.length).toBeGreaterThan(1);
    expect(a.findings.map((f) => f.startMs)).toEqual([...a.findings.map((f) => f.startMs)].sort((x, y) => x - y));
    expect(new Set(a.findings.map((f) => f.id)).size).toBe(a.findings.length);
  });
  it('reports a truncated match list instead of hiding it', async () => {
    const events: TextEvent[] = Array.from({ length: 10_050 }, (_, i) => ({ id: `sub-${i}`, source: 'subtitle', startSeconds: i, endSeconds: i + 0.5, text: 'darn', language: null, trackId: 'sub-0', streamIndex: 1, confidence: null, words: null, evidence: 'subtitle-only' }));
    const text = { ...readyTextAnalysis('m'), timeline: events };
    const a = await analyzeSafety({ mediaId: 'm', context: ctx(text), text, terms: [term('darn')] });
    expect(a.warnings).toContainEqual({ code: 'findings-truncated', count: 10_000 });
  });
});

describe('analyzeSafety orchestration', () => {
  const text = readyTextAnalysis('m');
  const failing: SafetyClassifier = { info: { id: 'broken', version: '1', kind: 'model' }, categories: ['violence'], classify: () => { throw new Error('model crashed at /secret/path'); } };
  const bad: SafetyClassifier = {
    info: { id: 'bad', version: '1', kind: 'model' }, categories: ['violence'],
    classify: (): CategoryResult[] => [{ category: 'violence', evaluation: 'evaluated', reason: null, modalities: { evaluated: ['visual'], missing: [] }, warnings: [], findings: [finding({ category: 'violence', startMs: 5000, endMs: 1000 }), finding({ id: 'sf-violence-0001', category: 'violence', startMs: 1000, endMs: 2000 })] }],
  };
  const async1: SafetyClassifier = { info: { id: 'async', version: '1', kind: 'model' }, categories: ['violence'], classify: async () => [{ category: 'violence', evaluation: 'evaluated', reason: null, modalities: { evaluated: ['visual'], missing: [] }, warnings: [], findings: [] }] };

  it('is pending (no findings, nothing evaluated) while the evidence steps run', async () => {
    const pending = buildContextAnalysis({ mediaId: 'm', extractionStatus: 'processing', mediaDurationSeconds: 5, text: null, visual: null, frameStepSeconds: null });
    const a = await analyzeSafety({ mediaId: 'm', context: pending, text: null, terms: [term('x')] });
    expect(a).toMatchObject({ status: 'pending', findings: [] });
    expect(a.categories).toHaveLength(CATEGORY_IDS.length);
  });
  it('partial: text inputs missing makes the result partial and names what is missing', async () => {
    const failedText = { ...text, status: 'failed' as const, timeline: [] };
    const a = await analyzeSafety({ mediaId: 'm', context: buildContextAnalysis({ mediaId: 'm', extractionStatus: 'completed', mediaDurationSeconds: 5, text: failedText, visual: readyVisual('m'), frameStepSeconds: 3 }), text: failedText, terms: [term('x')] });
    expect(a.status).toBe('not-evaluated');
    expect(a.categories.find((c) => c.category === 'flagged-terms')).toMatchObject({ evaluation: 'abstained', reason: 'text-unavailable', modalities: { evaluated: [], missing: ['speech', 'subtitle'] } });
  });
  it('a classifier that throws is an abstention with a fixed reason: never an empty clean result, and its error text is not exposed', async () => {
    const a = await analyzeSafety({ mediaId: 'm', context: ctx(text), text, terms: [term('safe watch', 'phrase')], classifiers: [...DEFAULT_CLASSIFIERS, failing] });
    expect(a.categories.find((c) => c.category === 'violence')).toMatchObject({ evaluation: 'abstained', reason: 'classifier-failed', findingCount: 0 });
    expect(JSON.stringify(a)).not.toMatch(/secret|crashed/);
    expect(a.findings.every((f) => f.category === 'flagged-terms')).toBe(true);
  });
  it('rejects findings that break the contract and counts them: no silent repair', async () => {
    const a = await analyzeSafety({ mediaId: 'm', context: ctx(text), text, terms: [term('x')], classifiers: [bad] });
    expect(a.findings.map((f) => f.id)).toEqual(['sf-violence-0001']);
    expect(a.warnings).toContainEqual({ code: 'invalid-finding', count: 1 });
  });
  it('supports an asynchronous, model-backed classifier behind the same port', async () => {
    const a = await analyzeSafety({ mediaId: 'm', context: ctx(text), text, terms: [], classifiers: [async1] });
    expect(a.categories.find((c) => c.category === 'violence')).toMatchObject({ evaluation: 'evaluated' });
    expect(a.classifiers.map((c) => c.id)).toEqual(['async']);
  });
  it('a category that is not supported cannot carry findings, and the report must cover the taxonomy', async () => {
    const a = await analyzeSafety({ mediaId: 'm', context: ctx(text), text, terms: [term('safe watch', 'phrase')] });
    const forged = { ...a, categories: a.categories.map((c) => (c.category === 'violence' ? { ...c, evaluation: 'evaluated' as const } : c)) };
    expect(validateSafetyAnalysis(forged).join()).toContain('unsupported category reported as evaluated');
    expect(validateSafetyAnalysis({ ...a, categories: a.categories.slice(1) }).join()).toContain('does not cover the taxonomy');
  });
  it('contains no overall score or verdict', async () => {
    const a = await analyzeSafety({ mediaId: 'm', context: ctx(text), text, terms: [term('safe watch', 'phrase')] });
    expect(Object.keys(a).sort()).toEqual(['categories', 'classifiers', 'durationMs', 'findings', 'inputs', 'mediaId', 'policy', 'status', 'taxonomyVersion', 'termCount', 'warnings']);
    expect(Object.keys(a.findings[0]!).sort()).toEqual(['attributes', 'calibratedProbability', 'category', 'classifier', 'endMs', 'evidence', 'explanation', 'id', 'rawScore', 'startMs', 'status', 'taxonomyVersion', 'warnings']);
    expect(a.findings[0]).toMatchObject({ rawScore: null, calibratedProbability: null }); // nothing is presented as a probability: none was measured
    expect(new FlaggedTermClassifier().info.kind).toBe('rule-based');
  });
});

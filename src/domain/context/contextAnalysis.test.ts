import { createTextAnalysis, type TextAnalysis } from '@/domain/text/textAnalysis';
import { failVisual, unavailableVisual } from '@/domain/vision/visualAnalysis';
import { processingTextAnalysis, readyTextAnalysis } from '@/test/textAnalysis';
import { processingVisual, readyVisual } from '@/test/visualAnalysis';
import { buildContextAnalysis, unavailableContext, validateContextAnalysis, type ContextSource } from './contextAnalysis';

const src = (over: Partial<ContextSource> = {}): ContextSource => ({ mediaId: 'm', extractionStatus: 'completed', mediaDurationSeconds: 24, text: readyTextAnalysis('m'), visual: readyVisual('m'), frameStepSeconds: 3, ...over });
const failedText = (): TextAnalysis => ({ ...createTextAnalysis('m', 'x'), status: 'failed', issues: [{ code: 'provider-failed', stage: 'timeline', fatal: true, trackId: null }] });
const noSpeechText = (skip: 'speech-disabled' | 'not-selected'): TextAnalysis => {
  const t = readyTextAnalysis('m');
  return { ...t, speech: [{ ...t.speech[0]!, status: 'skipped', skipReason: skip, transcript: null }], timeline: t.timeline.filter((e) => e.source === 'subtitle') };
};

describe('buildContextAnalysis: all modalities', () => {
  it('correlates the speech, subtitle and visual evidence of the earlier stages into one timeline', () => {
    const a = buildContextAnalysis(src());
    expect(a).toMatchObject({ mediaId: 'm', status: 'ready', inputs: { speech: 'used', subtitles: 'used', visual: 'used' }, warnings: [], durationMs: 24_000 });
    expect(validateContextAnalysis(a)).toEqual([]);
    expect(a.events.length).toBeGreaterThan(0);
    expect(a.counts).toMatchObject({ eventCount: a.events.length, invalidEvidence: 0, duplicateEvidence: 0 });
    expect([...new Set(a.events.flatMap((e) => e.sources))].sort()).toEqual(['speech', 'subtitle', 'visual']);
    expect(a.events[0]).toMatchObject({ corroboration: 'multi-source' });
  });
  it('is deterministic: the same inputs give an identical result every time', () => {
    const first = JSON.stringify(buildContextAnalysis(src()));
    for (let i = 0; i < 5; i++) expect(JSON.stringify(buildContextAnalysis(src()))).toBe(first);
  });
  it('is a pure function of the evidence: it does not mutate its inputs', () => {
    const s = src();
    const before = JSON.stringify(s);
    buildContextAnalysis(s);
    expect(JSON.stringify(s)).toBe(before);
  });
});

describe('graceful degradation (a missing modality is reported, never faked)', () => {
  it('visual analysis failed: speech and subtitle context still works and the gap is a warning', () => {
    const a = buildContextAnalysis(src({ visual: failVisual(processingVisual('m', 'preparing'), { code: 'inference-failed', stage: 'provider', fatal: true, count: 1 }, 'x') }));
    expect(a).toMatchObject({ status: 'partial', inputs: { speech: 'used', subtitles: 'used', visual: 'failed' }, warnings: [{ code: 'visual-failed', count: 1 }] });
    expect(a.events.length).toBeGreaterThan(0);
    expect(a.events.every((e) => !e.sources.includes('visual'))).toBe(true);
  });
  it('visual analysis not enabled is reported as not-enabled, distinct from failed', () => {
    expect(buildContextAnalysis(src({ visual: unavailableVisual('m', 'x', 'provider-unavailable') }))).toMatchObject({ status: 'partial', inputs: { visual: 'not-enabled' }, warnings: [{ code: 'visual-not-enabled' }] });
    expect(buildContextAnalysis(src({ visual: null }))).toMatchObject({ status: 'partial', inputs: { visual: 'not-enabled' } });
  });
  it('speech not enabled (subtitles and visual only) still correlates, with a warning', () => {
    const a = buildContextAnalysis(src({ text: noSpeechText('speech-disabled') }));
    expect(a).toMatchObject({ status: 'partial', inputs: { speech: 'not-enabled', subtitles: 'used', visual: 'used' }, warnings: [{ code: 'speech-not-enabled' }] });
    expect(a.events.some((e) => e.sources.includes('subtitle') && e.sources.includes('visual'))).toBe(true);
  });
  it('a speech track that was simply not selected is not a degradation', () => {
    expect(buildContextAnalysis(src({ text: noSpeechText('not-selected') }))).toMatchObject({ status: 'ready', inputs: { speech: 'empty' }, warnings: [] });
  });
  it('text analysis failed: visual context still works and both text inputs are reported failed', () => {
    const a = buildContextAnalysis(src({ text: failedText() }));
    expect(a).toMatchObject({ status: 'partial', inputs: { speech: 'failed', subtitles: 'failed', visual: 'used' } });
    expect(a.warnings.map((w) => w.code)).toEqual(['speech-failed', 'subtitles-failed']);
    expect(a.events.every((e) => e.sources.length === 1 && e.sources[0] === 'visual')).toBe(true);
  });
  it('every modality failed is unavailable, not an empty success', () => {
    const a = buildContextAnalysis(src({ text: failedText(), visual: unavailableVisual('m', 'x', 'timeout') }));
    expect(a).toMatchObject({ status: 'unavailable', events: [] });
    expect(a.warnings.length).toBeGreaterThan(0);
  });
  it('a failed extraction is unavailable', () => {
    expect(buildContextAnalysis(src({ extractionStatus: 'failed', text: null, visual: null }))).toMatchObject({ status: 'unavailable', events: [], inputs: { speech: 'failed', subtitles: 'failed', visual: 'failed' } });
  });
  it('a stage that found nothing is "empty" and a clean no-evidence result, not a failure', () => {
    const emptyText: TextAnalysis = { ...readyTextAnalysis('m'), speech: [], timeline: [] };
    const emptyVisual = { ...readyVisual('m'), observations: [], frames: [] };
    expect(buildContextAnalysis(src({ text: emptyText, visual: emptyVisual }))).toMatchObject({ status: 'ready', inputs: { speech: 'empty', subtitles: 'empty', visual: 'empty' }, events: [], warnings: [{ code: 'no-evidence' }] });
  });
  it('a subtitle track that could not be read is a subtitles failure', () => {
    const t = readyTextAnalysis('m');
    const a = buildContextAnalysis(src({ text: { ...t, timeline: t.timeline.filter((e) => e.source === 'speech'), issues: [{ code: 'subtitle-unavailable', stage: 'timeline', fatal: false, trackId: 'sub-0' }] } }));
    expect(a).toMatchObject({ status: 'partial', inputs: { subtitles: 'failed' } });
  });
});

describe('pending', () => {
  it.each([
    ['extraction still running', { extractionStatus: 'processing' as const }],
    ['text analysis in progress', { text: processingTextAnalysis('m', 'speech-processing') }],
    ['visual analysis in progress', { visual: processingVisual('m', 'analyzing-frames', { framesDone: 1, framesTotal: 5 }) }],
    ['no text analysis yet', { text: null }],
  ])('%s: pending with no events (never a partial guess)', (_n, over) => {
    expect(buildContextAnalysis(src(over))).toMatchObject({ status: 'pending', events: [] });
  });
  it('reports which input is still pending', () => {
    expect(buildContextAnalysis(src({ visual: processingVisual('m', 'preparing') })).inputs).toMatchObject({ speech: 'used', visual: 'pending' });
  });
});

describe('malformed upstream data', () => {
  it('rejects bad evidence, counts it as a warning and still builds the rest', () => {
    const v = readyVisual('m');
    const broken = { ...v, observations: [...v.observations, { ...v.observations[0]!, id: 'vis-bad', timestampSeconds: NaN }, { ...v.observations[0]!, id: 'vis-bad2', timestampSeconds: -4 }] };
    const a = buildContextAnalysis(src({ visual: broken }));
    expect(a.counts.invalidEvidence).toBe(2);
    expect(a.warnings).toContainEqual({ code: 'invalid-evidence', count: 2 });
    expect(validateContextAnalysis(a)).toEqual([]);
  });
});

describe('unavailableContext and validation', () => {
  it('is an honest failure value', () => {
    expect(unavailableContext('m')).toMatchObject({ status: 'unavailable', events: [] });
  });
  it('flags structurally broken analyses', () => {
    const a = buildContextAnalysis(src());
    const e = a.events[0]!;
    expect(validateContextAnalysis({ ...a, events: [{ ...e, members: [] }] })).toContain('ctx-0000: no members');
    expect(validateContextAnalysis({ ...a, events: [e, { ...e }] }).join()).toContain('duplicate event id');
    expect(validateContextAnalysis({ ...a, counts: { ...a.counts, eventCount: 99 } })).toContain('eventCount mismatch');
    expect(validateContextAnalysis({ ...a, events: [{ ...e, sources: ['speech'], corroboration: 'single-source' }, ...a.events.slice(1)] }).join()).toContain('sources');
  });
});

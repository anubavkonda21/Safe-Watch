import {
  InvalidTextAnalysisTransitionError, canTransitionTextAnalysis, completeTextAnalysis, createTextAnalysis, failTextAnalysis,
  queueTextAnalysis, setTextAnalysisPhase, startTextAnalysis, toTextAnalysisState, unavailableTextAnalysis,
} from './textAnalysis';

const NOW = '2026-01-01T00:00:00.000Z';
const result = { speech: [], timeline: [], alignment: { links: [], counts: { both: 0, speechOnly: 0, subtitleOnly: 0 } }, provider: null, issues: [], metrics: { durationMs: 5, speechMs: 3, audioSeconds: 2 } };

describe('text analysis lifecycle', () => {
  it('starts not_started with no evidence', () => {
    expect(createTextAnalysis('m', NOW)).toMatchObject({ status: 'not_started', phase: null, speech: [], timeline: [], alignment: null, provider: null, issues: [], completedAt: null });
  });
  it('not_started → queued → processing → ready, with phases', () => {
    const p = startTextAnalysis(queueTextAnalysis(createTextAnalysis('m', NOW)), NOW);
    expect(p).toMatchObject({ status: 'processing', phase: 'preparing', startedAt: NOW });
    const ready = completeTextAnalysis(setTextAnalysisPhase(setTextAnalysisPhase(p, 'speech-processing'), 'building-timeline'), result, NOW);
    expect(ready).toMatchObject({ status: 'ready', phase: null, completedAt: NOW });
    expect(toTextAnalysisState(ready)).toEqual({ status: 'ready', phase: null });
  });
  it('phases only exist while processing', () => {
    expect(() => setTextAnalysisPhase(createTextAnalysis('m', NOW), 'preparing')).toThrow(InvalidTextAnalysisTransitionError);
  });
  it('failure discards partial evidence and keeps the structured issue', () => {
    const p = startTextAnalysis(queueTextAnalysis({ ...createTextAnalysis('m', NOW), timeline: [{} as never] }), NOW);
    const f = failTextAnalysis(p, { code: 'timeout', stage: 'speech', fatal: true, trackId: null }, NOW);
    expect(f).toMatchObject({ status: 'failed', timeline: [], speech: [], alignment: null, issues: [{ code: 'timeout' }] });
  });
  it.each([['not_started', 'processing'], ['not_started', 'ready'], ['queued', 'ready'], ['ready', 'failed'], ['ready', 'processing'], ['failed', 'queued']] as const)('forbids %s → %s', (a, b) => {
    expect(canTransitionTextAnalysis(a, b)).toBe(false);
  });
  it('ready means text evidence exists, nothing more: no safety fields at all', () => {
    const keys = Object.keys(createTextAnalysis('m', NOW));
    expect(keys.join(',')).not.toMatch(/safe|score|verdict|risk|block/i);
  });
  it('builds a client-side failed stand-in', () => {
    expect(unavailableTextAnalysis('m', NOW, 'server-unreachable')).toMatchObject({ status: 'failed', issues: [{ code: 'server-unreachable', fatal: true }] });
  });
});

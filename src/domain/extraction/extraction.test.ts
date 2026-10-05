import {
  InvalidExtractionTransitionError, canTransitionExtraction, completeExtraction, createExtraction, failExtraction,
  queueExtraction, setExtractionPhase, startExtraction, toExtractionState, type ExtractionMetrics,
} from './extraction';

const NOW = '2026-01-01T00:00:00.000Z';
const LATER = '2026-01-01T00:00:05.000Z';
const metrics: ExtractionMetrics = { durationMs: 5000, stageMs: { audio: 1, subtitles: 2, frames: 3 }, toolProcesses: 4, outputBytes: 10 };
const result = { audio: [], subtitles: [], frames: null, warnings: [], metrics };

describe('extraction lifecycle', () => {
  it('starts not_started, with empty assets and no phase', () => {
    expect(createExtraction('m1', NOW)).toMatchObject({ mediaId: 'm1', status: 'not_started', phase: null, audio: [], subtitles: [], frames: null, errors: [], completedAt: null });
  });
  it('not_started → queued → processing → completed', () => {
    const q = queueExtraction(createExtraction('m', NOW));
    expect(q.status).toBe('queued');
    const p = startExtraction(q, NOW);
    expect(p).toMatchObject({ status: 'processing', phase: 'preparing', startedAt: NOW });
    const c = completeExtraction(setExtractionPhase(p, 'finalizing'), result, LATER);
    expect(c).toMatchObject({ status: 'completed', phase: null, completedAt: LATER, metrics });
  });
  it('tracks phases only while processing', () => {
    const p = startExtraction(queueExtraction(createExtraction('m', NOW)), NOW);
    expect(setExtractionPhase(p, 'sampling-frames').phase).toBe('sampling-frames');
    expect(() => setExtractionPhase(createExtraction('m', NOW), 'preparing')).toThrow(InvalidExtractionTransitionError);
  });
  it('failure discards partial assets and records the structured issue', () => {
    const p = startExtraction(queueExtraction({ ...createExtraction('m', NOW), audio: [{ id: 'partial' } as never] }), NOW);
    const f = failExtraction(p, { code: 'timeout', stage: 'frames', fatal: true, streamIndex: null }, LATER);
    expect(f).toMatchObject({ status: 'failed', phase: null, audio: [], subtitles: [], frames: null, errors: [{ code: 'timeout', fatal: true }] });
  });
  it('can fail while queued (e.g. queue full)', () => {
    const f = failExtraction(queueExtraction(createExtraction('m', NOW)), { code: 'server-busy', stage: 'queue', fatal: true, streamIndex: null }, NOW);
    expect(f.status).toBe('failed');
  });
  it.each([
    ['not_started', 'processing'], ['not_started', 'completed'], ['queued', 'completed'], ['completed', 'failed'],
    ['completed', 'processing'], ['failed', 'queued'], ['failed', 'completed'], ['processing', 'queued'],
  ] as const)('forbids %s → %s', (from, to) => {
    expect(canTransitionExtraction(from, to)).toBe(false);
  });
  it('is independent of media and analysis state', () => {
    const e = createExtraction('m', NOW);
    expect(Object.keys(e)).not.toContain('analysis');
    expect(toExtractionState(e)).toEqual({ status: 'not_started', phase: null });
  });
});

import { ANALYSIS_STATUSES, NOT_STARTED, canTransitionAnalysis } from './job';

describe('analysis job lifecycle', () => {
  it('starts as not_started and is independent of media status', () => {
    expect(NOT_STARTED).toEqual({ status: 'not_started' });
  });
  it('allows the forward path and retry after failure', () => {
    expect(canTransitionAnalysis('not_started', 'queued')).toBe(true);
    expect(canTransitionAnalysis('queued', 'processing')).toBe(true);
    expect(canTransitionAnalysis('processing', 'completed')).toBe(true);
    expect(canTransitionAnalysis('processing', 'failed')).toBe(true);
    expect(canTransitionAnalysis('failed', 'queued')).toBe(true);
  });
  it('forbids skipping and leaving terminal completion', () => {
    expect(canTransitionAnalysis('not_started', 'processing')).toBe(false);
    expect(canTransitionAnalysis('not_started', 'completed')).toBe(false);
    for (const s of ANALYSIS_STATUSES) expect(canTransitionAnalysis('completed', s)).toBe(false);
  });
});

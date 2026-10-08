import type { VisualObservation } from './observation';
import {
  InvalidVisualTransitionError, canTransitionVisual, completeVisual, compareFrames, createVisualAnalysis, failVisual, queueVisual, setVisualPhase,
  startVisual, toVisualState, validateVisualAnalysis, unavailableVisual, type VisualFrame, type VisualResult,
} from './visualAnalysis';

const T = '2026-01-01T00:00:00.000Z';
const frame = (i: number, t: number, over: Partial<VisualFrame> = {}): VisualFrame => ({
  frameId: `frm-0000${i}`, index: i, timestampSeconds: t, width: 640, height: 360, format: 'jpeg', status: 'analyzed', error: null, skipReason: null, observationCount: 0, processingMs: 10, ...over,
});
const obs = (f: VisualFrame, n: number, over: Partial<VisualObservation> = {}): VisualObservation => ({
  id: `vis-${f.frameId}-${n}`, frameId: f.frameId, frameIndex: f.index, timestampSeconds: f.timestampSeconds, type: 'classification', label: 'outdoor', confidence: 0.8, region: null, attributes: null, provider: 'p', model: 'm', ...over,
});
const result = (frames: VisualFrame[], observations: VisualObservation[]): VisualResult => ({ frames, observations, provider: { name: 'p', model: 'm' }, issues: [], metrics: { durationMs: 5, providerMs: 3, batches: 1 } });
const processing = () => startVisual(queueVisual(createVisualAnalysis('m1', T)), T);

describe('visual lifecycle', () => {
  it('moves not_started → queued → processing → ready', () => {
    const a = createVisualAnalysis('m1', T);
    expect(toVisualState(a)).toEqual({ status: 'not_started', phase: null, progress: null });
    expect(queueVisual(a).status).toBe('queued');
    const p = setVisualPhase(processing(), 'analyzing-frames', { framesDone: 2, framesTotal: 5 });
    expect(toVisualState(p)).toEqual({ status: 'processing', phase: 'analyzing-frames', progress: { framesDone: 2, framesTotal: 5 } });
    const f = frame(0, 1);
    const done = completeVisual(p, result([f], [obs(f, 0)]), T);
    expect(done).toMatchObject({ status: 'ready', phase: null, progress: null, completedAt: T });
    expect(done.counts).toEqual({ analyzedFrameCount: 1, skippedFrameCount: 0, failedFrameCount: 0, observationCount: 1 });
  });
  it('rejects illegal transitions, including leaving terminal states', () => {
    const ready = completeVisual(processing(), result([], []), T);
    expect(() => queueVisual(ready)).toThrow(InvalidVisualTransitionError);
    expect(() => startVisual(createVisualAnalysis('m', T), T)).toThrow(InvalidVisualTransitionError);
    expect(() => setVisualPhase(createVisualAnalysis('m', T), 'preparing')).toThrow(InvalidVisualTransitionError);
    expect(canTransitionVisual('failed', 'queued')).toBe(false);
    expect(canTransitionVisual('queued', 'failed')).toBe(true);
  });
  it('failure discards partial evidence and records the structured issue', () => {
    const failed = failVisual(processing(), { code: 'timeout', stage: 'provider', fatal: true, count: 3 }, T, { durationMs: 1, providerMs: 1, batches: 1 });
    expect(failed).toMatchObject({ status: 'failed', frames: [], observations: [], provider: null });
    expect(failed.issues).toEqual([{ code: 'timeout', stage: 'provider', fatal: true, count: 3 }]);
  });
  it('the client stand-in is a failed analysis with a fatal issue', () => {
    expect(unavailableVisual('m', T, 'server-unreachable')).toMatchObject({ status: 'failed', issues: [{ code: 'server-unreachable', fatal: true }] });
  });
  it('contains no safety fields at all', () => {
    const keys = JSON.stringify(Object.keys(createVisualAnalysis('m', T)));
    for (const forbidden of ['safety', 'score', 'verdict', 'severity', 'risk', 'action']) expect(keys).not.toContain(forbidden);
  });
});

describe('completeVisual', () => {
  it('orders frames and observations chronologically and counts outcomes', () => {
    const f1 = frame(1, 20); const f0 = frame(0, 10); const skipped = frame(2, 30, { status: 'skipped', skipReason: 'over-limit' }); const failed = frame(3, 40, { status: 'failed', error: 'invalid-frame' });
    const done = completeVisual(processing(), result([f1, f0, skipped, failed], [obs(f1, 0), obs(f0, 0)]), T);
    expect(done.frames.map((f) => f.index)).toEqual([0, 1, 2, 3]);
    expect(done.observations.map((o) => o.frameId)).toEqual(['frm-00000', 'frm-00001']);
    expect(done.counts).toEqual({ analyzedFrameCount: 2, skippedFrameCount: 1, failedFrameCount: 1, observationCount: 2 });
  });
  it('orders frames sharing a timestamp by index, then id', () => {
    const a = frame(1, 5); const b = frame(0, 5);
    expect([a, b].sort(compareFrames).map((f) => f.index)).toEqual([0, 1]);
  });
});

describe('validateVisualAnalysis', () => {
  const ok = () => { const f = frame(0, 5, { observationCount: 1 }); return completeVisual(processing(), result([f], [obs(f, 0)]), T); };
  it('accepts a consistent analysis', () => { expect(validateVisualAnalysis(ok(), 10)).toEqual([]); });
  it('flags timestamps outside the media', () => { expect(validateVisualAnalysis(ok(), 4)).toContain('frame frm-00000: timestamp outside the media'); });
  it('flags observations that point at unknown frames or drift from their frame time', () => {
    const a = ok();
    expect(validateVisualAnalysis({ ...a, observations: [{ ...a.observations[0]!, frameId: 'frm-99999' }] })).toContain('observation vis-frm-00000-0: unknown frame');
    expect(validateVisualAnalysis({ ...a, observations: [{ ...a.observations[0]!, timestampSeconds: 6 }] })).toContain('observation vis-frm-00000-0: timestamp differs from its frame');
  });
  it('flags duplicate ids, bad confidence, count drift, failed frames without errors', () => {
    const a = ok(); const o = a.observations[0]!;
    expect(validateVisualAnalysis({ ...a, observations: [o, o], counts: { ...a.counts, observationCount: 2 } })).toContain('duplicate observation id vis-frm-00000-0');
    expect(validateVisualAnalysis({ ...a, observations: [{ ...o, confidence: 2 }] })).toContain('observation vis-frm-00000-0: confidence out of range');
    expect(validateVisualAnalysis({ ...a, counts: { ...a.counts, observationCount: 9 } })).toContain('observationCount mismatch');
    expect(validateVisualAnalysis({ ...a, frames: [frame(0, 5, { status: 'failed', error: null })], observations: [], counts: { ...a.counts, observationCount: 0 } })).toContain('frame frm-00000: failed without an error');
  });
});

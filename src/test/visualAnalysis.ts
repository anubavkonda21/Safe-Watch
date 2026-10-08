import type { VisualObservation } from '@/domain/vision/observation';
import { completeVisual, createVisualAnalysis, queueVisual, setVisualPhase, startVisual, type VisualAnalysis, type VisualFrame, type VisualPhase, type VisualProgress } from '@/domain/vision/visualAnalysis';

const T = '2026-01-01T00:00:00.000Z';

export const visualFrame = (index: number, timestampSeconds: number, over: Partial<VisualFrame> = {}): VisualFrame => ({
  frameId: `frm-${String(index).padStart(5, '0')}`, index, timestampSeconds, width: 640, height: 480, format: 'jpeg', status: 'analyzed', error: null, skipReason: null, observationCount: 0, processingMs: 120, ...over,
});

export const visualObservation = (frame: VisualFrame, n: number, over: Partial<VisualObservation> = {}): VisualObservation => ({
  id: `vis-${frame.frameId}-${n}`, frameId: frame.frameId, frameIndex: frame.index, timestampSeconds: frame.timestampSeconds, type: 'classification', label: 'living_room',
  confidence: 0.68, region: null, attributes: null, provider: 'apple-vision', model: 'vision-framework', ...over,
});

export const processingVisual = (mediaId: string, phase: VisualPhase | null, progress: VisualProgress | null = null): VisualAnalysis =>
  phase ? setVisualPhase(startVisual(queueVisual(createVisualAnalysis(mediaId, T)), T), phase, progress) : queueVisual(createVisualAnalysis(mediaId, T));

/** Two analysed frames (a living room; a person with a box and a street sign with OCR text) and one frame that could not be read. */
export const readyVisual = (mediaId: string): VisualAnalysis => {
  const f0 = visualFrame(0, 1.5, { observationCount: 2 });
  const f1 = visualFrame(1, 4.5, { observationCount: 3 });
  const f2 = visualFrame(2, 7.5, { status: 'failed', error: 'invalid-frame', processingMs: null });
  const observations = [
    visualObservation(f0, 0, { label: 'living_room', confidence: 0.68 }),
    visualObservation(f0, 1, { label: 'furniture', confidence: 0.6 }),
    visualObservation(f1, 0, { type: 'object', label: 'person', confidence: 0.82, region: { x: 0.55, y: 0.12, width: 0.15, height: 0.37 } }),
    visualObservation(f1, 1, { type: 'text', label: 'text', confidence: 1, region: { x: 0.1, y: 0.4, width: 0.5, height: 0.1 }, attributes: { text: 'STOP' } }),
    visualObservation(f1, 2, { label: 'street_sign', confidence: 0.77 }),
  ];
  return completeVisual(processingVisual(mediaId, 'building-timeline'), {
    frames: [f0, f1, f2], observations, provider: { name: 'apple-vision', model: 'vision-framework' }, issues: [{ code: 'invalid-frame', stage: 'frames', fatal: false, count: 1 }],
    metrics: { durationMs: 450, providerMs: 400, batches: 1 },
  }, T);
};

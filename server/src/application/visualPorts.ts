import type { RawObservation } from '@/domain/vision/observation';
import type { VisualErrorCode } from '@/domain/vision/visualAnalysis';

/** Failure of visual analysis, classified. Never carries provider output, command lines, paths or stack traces. */
export class VisionError extends Error {
  readonly code: VisualErrorCode;
  constructor(code: VisualErrorCode) {
    super(code);
    this.name = 'VisionError';
    this.code = code;
  }
}

/** One frame to analyse. `path` is a server-generated local path, valid only inside the storage callback that produced it. */
export interface VisionFrameInput {
  frameId: string;
  path: string;
}

export interface VisionFrameResult {
  frameId: string;
  /** Null when the frame was analysed; otherwise why it was not. */
  error: Extract<VisualErrorCode, 'invalid-frame' | 'inference-failed'> | null;
  width: number | null;
  height: number | null;
  /** Provider-reported time for this frame. */
  elapsedMs: number | null;
  /** Untrusted until normalised by the domain. */
  observations: RawObservation[];
}

export interface VisionRequest {
  /** Aborts the analysis and must stop any inference process it started. */
  signal: AbortSignal;
  minConfidence: number;
  maxLabelsPerFrame: number;
}

/**
 * Port: turns frames into raw, provider-neutral visual observations
 * (labels, localised objects, recognised text). The application never
 * depends on which model, runtime or API is behind it. It reports what it
 * SEES; it never judges. Adapters throw `VisionError` for batch-level
 * failures and report per-frame failures in the result, so one bad frame
 * cannot take down its neighbours.
 */
export interface VisualAnalysisProvider {
  /** Labels for the analysis metadata (no paths, no versions). */
  readonly info: { name: string; model: string };
  isAvailable(): Promise<boolean>;
  analyze(frames: readonly VisionFrameInput[], request: VisionRequest): Promise<VisionFrameResult[]>;
}

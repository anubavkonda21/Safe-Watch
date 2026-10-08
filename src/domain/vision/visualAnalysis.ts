import { compareObservations, type VisualObservation } from './observation';

/**
 * Visual analysis: the evidence-gathering stage for FRAMES, parallel to text
 * analysis for speech/subtitles. It reuses the frames the extraction stage
 * already produced (same ids, same media timestamps). `ready` means "visual
 * observations are available", NOT "the video was assessed": there is no
 * safety classification, score, verdict or action anywhere in this model.
 */
export const VISUAL_STATUSES = ['not_started', 'queued', 'processing', 'ready', 'failed'] as const;
export type VisualStatus = (typeof VISUAL_STATUSES)[number];

export const VISUAL_PHASES = ['preparing', 'analyzing-frames', 'building-timeline'] as const;
export type VisualPhase = (typeof VISUAL_PHASES)[number];

/** Real, measurable progress (frames done of frames to analyse). Only present while analysing frames. */
export interface VisualProgress {
  framesDone: number;
  framesTotal: number;
}

export interface VisualState {
  status: VisualStatus;
  phase: VisualPhase | null;
  progress: VisualProgress | null;
}

/**
 * Why a frame has no observations. Distinguishes the failing layer:
 *  - frame-missing       the frame file from extraction is not there (extraction/storage problem)
 *  - invalid-frame       the frame is not a decodable image of acceptable type/size/dimensions
 *  - inference-failed    the model ran and failed on this frame
 *  - provider-unavailable the model/runtime is not available
 *  - timeout / cancelled  the work was stopped
 *  - invalid-response    the provider returned something unusable
 *  - resource-limit      limits prevented analysis (frame too large, etc.)
 */
export type VisualErrorCode =
  | 'frame-missing'
  | 'invalid-frame'
  | 'inference-failed'
  | 'provider-unavailable'
  | 'timeout'
  | 'cancelled'
  | 'invalid-response'
  | 'resource-limit';

export type SkipReason = 'over-limit';

export interface VisualFrame {
  frameId: string;
  index: number;
  /** Media time of the frame (from extraction; never re-timed). */
  timestampSeconds: number;
  width: number;
  height: number;
  format: 'jpeg';
  status: 'analyzed' | 'failed' | 'skipped';
  error: VisualErrorCode | null;
  skipReason: SkipReason | null;
  observationCount: number;
  /** Time the provider reported for this frame, when it reported one. */
  processingMs: number | null;
}

export interface VisualIssue {
  code: VisualErrorCode | 'no-frames' | 'observations-dropped' | 'server-busy' | 'server-unreachable';
  stage: 'frames' | 'provider' | 'timeline' | 'queue';
  fatal: boolean;
  /** How many frames/observations the issue affected. */
  count: number;
}

export interface VisualMetrics {
  durationMs: number;
  /** Sum of provider batch times (wall clock inside the provider). */
  providerMs: number;
  batches: number;
}

export interface VisualCounts {
  analyzedFrameCount: number;
  skippedFrameCount: number;
  failedFrameCount: number;
  observationCount: number;
}

export interface VisualAnalysis {
  mediaId: string;
  status: VisualStatus;
  phase: VisualPhase | null;
  progress: VisualProgress | null;
  counts: VisualCounts;
  /** Every candidate frame with its outcome, ordered by media time then frame index. */
  frames: VisualFrame[];
  /** All observations in chronological order (see compareObservations). */
  observations: VisualObservation[];
  provider: { name: string; model: string } | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  issues: VisualIssue[];
  metrics: VisualMetrics | null;
}

export const EMPTY_COUNTS: VisualCounts = { analyzedFrameCount: 0, skippedFrameCount: 0, failedFrameCount: 0, observationCount: 0 };

export class InvalidVisualTransitionError extends Error {
  constructor(from: VisualStatus, to: VisualStatus) {
    super(`Illegal visual-analysis transition ${from} → ${to}`);
    this.name = 'InvalidVisualTransitionError';
  }
}

const ALLOWED: Record<VisualStatus, readonly VisualStatus[]> = {
  not_started: ['queued', 'failed'],
  queued: ['processing', 'failed'],
  processing: ['ready', 'failed'],
  ready: [],
  failed: [],
};

export const canTransitionVisual = (from: VisualStatus, to: VisualStatus) => ALLOWED[from].includes(to);

function move(a: VisualAnalysis, to: VisualStatus, patch: Partial<VisualAnalysis>): VisualAnalysis {
  if (!canTransitionVisual(a.status, to)) throw new InvalidVisualTransitionError(a.status, to);
  return { ...a, ...patch, status: to };
}

export const createVisualAnalysis = (mediaId: string, now: string): VisualAnalysis => ({
  mediaId, status: 'not_started', phase: null, progress: null, counts: EMPTY_COUNTS, frames: [], observations: [], provider: null,
  createdAt: now, startedAt: null, completedAt: null, issues: [], metrics: null,
});

export const queueVisual = (a: VisualAnalysis): VisualAnalysis => move(a, 'queued', { phase: null });
export const startVisual = (a: VisualAnalysis, now: string): VisualAnalysis => move(a, 'processing', { phase: 'preparing', startedAt: now });

export function setVisualPhase(a: VisualAnalysis, phase: VisualPhase, progress: VisualProgress | null = null): VisualAnalysis {
  if (a.status !== 'processing') throw new InvalidVisualTransitionError(a.status, 'processing');
  return { ...a, phase, progress };
}

export interface VisualResult {
  frames: VisualFrame[];
  observations: VisualObservation[];
  provider: VisualAnalysis['provider'];
  issues: VisualIssue[];
  metrics: VisualMetrics;
}

/** Orders frames by media time, then index, then id: duplicate timestamps stay deterministic. */
export const compareFrames = (a: Pick<VisualFrame, 'timestampSeconds' | 'index' | 'frameId'>, b: Pick<VisualFrame, 'timestampSeconds' | 'index' | 'frameId'>) =>
  a.timestampSeconds - b.timestampSeconds || a.index - b.index || (a.frameId < b.frameId ? -1 : a.frameId > b.frameId ? 1 : 0);

export function countsOf(frames: readonly VisualFrame[], observations: readonly VisualObservation[]): VisualCounts {
  return {
    analyzedFrameCount: frames.filter((f) => f.status === 'analyzed').length,
    skippedFrameCount: frames.filter((f) => f.status === 'skipped').length,
    failedFrameCount: frames.filter((f) => f.status === 'failed').length,
    observationCount: observations.length,
  };
}

export const completeVisual = (a: VisualAnalysis, r: VisualResult, now: string): VisualAnalysis =>
  move(a, 'ready', {
    phase: null, progress: null, frames: [...r.frames].sort(compareFrames), observations: [...r.observations].sort(compareObservations),
    counts: countsOf(r.frames, r.observations), provider: r.provider, issues: r.issues, metrics: r.metrics, completedAt: now,
  });

/** Failure discards partial evidence; only the structured issue and what was counted remain. */
export const failVisual = (a: VisualAnalysis, issue: VisualIssue, now: string, metrics: VisualMetrics | null = null): VisualAnalysis =>
  move(a, 'failed', { phase: null, progress: null, frames: [], observations: [], counts: EMPTY_COUNTS, provider: null, issues: [...a.issues, issue], metrics, completedAt: now });

export const toVisualState = (a: VisualAnalysis): VisualState => ({ status: a.status, phase: a.phase, progress: a.progress });

/** Structural checks consumers rely on. Returns problems (empty when valid). */
export function validateVisualAnalysis(a: VisualAnalysis, mediaDurationSeconds: number | null = null): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  const frameIds = new Set(a.frames.map((f) => f.frameId));
  for (let i = 1; i < a.frames.length; i++) if (compareFrames(a.frames[i - 1]!, a.frames[i]!) > 0) problems.push(`frame order: ${a.frames[i]!.frameId}`);
  for (const f of a.frames) {
    if (!(f.timestampSeconds >= 0) || (mediaDurationSeconds !== null && f.timestampSeconds > mediaDurationSeconds + 0.001)) problems.push(`frame ${f.frameId}: timestamp outside the media`);
    if (f.status === 'failed' && f.error === null) problems.push(`frame ${f.frameId}: failed without an error`);
    if (f.status !== 'analyzed' && f.observationCount > 0) problems.push(`frame ${f.frameId}: observations without analysis`);
  }
  for (let i = 0; i < a.observations.length; i++) {
    const o = a.observations[i]!;
    if (ids.has(o.id)) problems.push(`duplicate observation id ${o.id}`);
    ids.add(o.id);
    if (!frameIds.has(o.frameId)) problems.push(`observation ${o.id}: unknown frame`);
    const frame = a.frames.find((f) => f.frameId === o.frameId);
    if (frame && frame.timestampSeconds !== o.timestampSeconds) problems.push(`observation ${o.id}: timestamp differs from its frame`);
    if (o.confidence !== null && !(o.confidence >= 0 && o.confidence <= 1)) problems.push(`observation ${o.id}: confidence out of range`);
    if (i > 0 && compareObservations(a.observations[i - 1]!, o) > 0) problems.push(`observation order: ${o.id}`);
  }
  if (a.counts.observationCount !== a.observations.length) problems.push('observationCount mismatch');
  return problems;
}

/** Client-side stand-in when the state could not be read (e.g. the server became unreachable). */
export const unavailableVisual = (mediaId: string, now: string, code: VisualIssue['code']): VisualAnalysis => ({
  ...createVisualAnalysis(mediaId, now), status: 'failed', issues: [{ code, stage: 'queue', fatal: true, count: 0 }], completedAt: now,
});

/**
 * Analysis boundary. Media status (is the file stored and understood?) and
 * analysis status (has SafeWatch analysed its content?) are independent:
 * a video can be `media: ready` and `analysis: not_started`.
 *
 * Only the lifecycle is defined here. No analysis exists yet; later
 * checkpoints attach speech, subtitle and vision stages to AnalysisJob.
 */
export const ANALYSIS_STATUSES = ['not_started', 'queued', 'processing', 'completed', 'failed'] as const;
export type AnalysisStatus = (typeof ANALYSIS_STATUSES)[number];

/** The analysis state exposed alongside a media resource. */
export interface AnalysisState {
  status: AnalysisStatus;
}

export interface AnalysisJob {
  id: string;
  mediaId: string;
  status: AnalysisStatus;
  createdAt: string;
  updatedAt: string;
}

const TRANSITIONS: Record<AnalysisStatus, readonly AnalysisStatus[]> = {
  not_started: ['queued'],
  queued: ['processing', 'failed'],
  processing: ['completed', 'failed'],
  completed: [],
  failed: ['queued'], // retry
};

export function canTransitionAnalysis(from: AnalysisStatus, to: AnalysisStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export const NOT_STARTED: AnalysisState = { status: 'not_started' };

import type { Transcript } from '../speech/transcript';
import type { AlignmentLink } from './alignment';
import type { TextEvent } from './textEvent';

/**
 * Text analysis: the evidence-gathering stage that follows extraction.
 *
 *   MEDIA        uploaded → processing → ready
 *   EXTRACTION   not_started → queued → processing → completed
 *   TEXT         not_started → queued → processing → ready | failed      (this stage)
 *   SAFETY       not started (nothing decides whether media is safe)
 *
 * `ready` means "the text evidence timeline is available", NOT "analysis is
 * complete". Speech-to-text and subtitle text are collected; nothing
 * classifies, scores, mutes or censors.
 */
export const TEXT_ANALYSIS_STATUSES = ['not_started', 'queued', 'processing', 'ready', 'failed'] as const;
export type TextAnalysisStatus = (typeof TEXT_ANALYSIS_STATUSES)[number];

export const TEXT_ANALYSIS_PHASES = ['preparing', 'speech-processing', 'building-timeline'] as const;
export type TextAnalysisPhase = (typeof TEXT_ANALYSIS_PHASES)[number];

export interface TextAnalysisState {
  status: TextAnalysisStatus;
  phase: TextAnalysisPhase | null;
}

export type SpeechErrorCode =
  | 'unavailable'
  | 'timeout'
  | 'invalid-response'
  | 'unsupported-audio'
  | 'unsupported-language'
  | 'resource-limit'
  | 'provider-failed'
  | 'cancelled';

export type SpeechSkipReason = 'not-selected' | 'duplicate' | 'speech-disabled';

/** Outcome for one audio track. Nothing is dropped silently: skipped and failed tracks are listed with a reason. */
export interface SpeechTrackResult {
  audioTrackId: string;
  streamIndex: number;
  /** Language tag from the container (not from the model). */
  containerLanguage: string | null;
  status: 'completed' | 'failed' | 'skipped';
  skipReason: SpeechSkipReason | null;
  error: SpeechErrorCode | null;
  transcript: Transcript | null;
  /** Wall-clock time spent on this track. */
  processingMs: number | null;
}

export type TextAnalysisIssueCode = SpeechErrorCode | 'subtitle-unavailable' | 'no-text' | 'invalid-output' | 'server-busy' | 'server-unreachable';

export interface TextAnalysisIssue {
  code: TextAnalysisIssueCode;
  stage: 'speech' | 'timeline' | 'queue';
  fatal: boolean;
  trackId: string | null;
}

export interface TextAnalysisMetrics {
  durationMs: number;
  speechMs: number;
  /** Seconds of audio that were transcribed. */
  audioSeconds: number;
}

export interface TextAnalysis {
  mediaId: string;
  status: TextAnalysisStatus;
  phase: TextAnalysisPhase | null;
  speech: SpeechTrackResult[];
  /** Speech and subtitle text as one ordered timeline of events. */
  timeline: TextEvent[];
  alignment: { links: AlignmentLink[]; counts: { both: number; speechOnly: number; subtitleOnly: number } } | null;
  /** Which engine produced the transcripts (name and model only; never paths). Null when no speech was transcribed. */
  provider: { name: string; model: string } | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  issues: TextAnalysisIssue[];
  metrics: TextAnalysisMetrics | null;
}

export class InvalidTextAnalysisTransitionError extends Error {
  constructor(from: TextAnalysisStatus, to: TextAnalysisStatus) {
    super(`Illegal text-analysis transition ${from} → ${to}`);
    this.name = 'InvalidTextAnalysisTransitionError';
  }
}

const ALLOWED: Record<TextAnalysisStatus, readonly TextAnalysisStatus[]> = {
  not_started: ['queued', 'failed'],
  queued: ['processing', 'failed'],
  processing: ['ready', 'failed'],
  ready: [],
  failed: [],
};

export const canTransitionTextAnalysis = (from: TextAnalysisStatus, to: TextAnalysisStatus) => ALLOWED[from].includes(to);

function move(a: TextAnalysis, to: TextAnalysisStatus, patch: Partial<TextAnalysis>): TextAnalysis {
  if (!canTransitionTextAnalysis(a.status, to)) throw new InvalidTextAnalysisTransitionError(a.status, to);
  return { ...a, ...patch, status: to };
}

export const createTextAnalysis = (mediaId: string, now: string): TextAnalysis => ({
  mediaId, status: 'not_started', phase: null, speech: [], timeline: [], alignment: null, provider: null,
  createdAt: now, startedAt: null, completedAt: null, issues: [], metrics: null,
});

export const queueTextAnalysis = (a: TextAnalysis): TextAnalysis => move(a, 'queued', { phase: null });
export const startTextAnalysis = (a: TextAnalysis, now: string): TextAnalysis => move(a, 'processing', { phase: 'preparing', startedAt: now });

export function setTextAnalysisPhase(a: TextAnalysis, phase: TextAnalysisPhase): TextAnalysis {
  if (a.status !== 'processing') throw new InvalidTextAnalysisTransitionError(a.status, 'processing');
  return { ...a, phase };
}

export interface TextAnalysisResult {
  speech: SpeechTrackResult[];
  timeline: TextEvent[];
  alignment: NonNullable<TextAnalysis['alignment']>;
  provider: TextAnalysis['provider'];
  issues: TextAnalysisIssue[];
  metrics: TextAnalysisMetrics;
}

export const completeTextAnalysis = (a: TextAnalysis, r: TextAnalysisResult, now: string): TextAnalysis =>
  move(a, 'ready', { phase: null, ...r, completedAt: now });

/** Failure discards partial evidence; only the structured issue remains. */
export const failTextAnalysis = (a: TextAnalysis, issue: TextAnalysisIssue, now: string, metrics: TextAnalysisMetrics | null = null): TextAnalysis =>
  move(a, 'failed', { phase: null, speech: [], timeline: [], alignment: null, provider: null, issues: [...a.issues, issue], metrics, completedAt: now });

export const toTextAnalysisState = (a: TextAnalysis): TextAnalysisState => ({ status: a.status, phase: a.phase });

/** Client-side stand-in when the state could not be read (e.g. the server became unreachable). */
export const unavailableTextAnalysis = (mediaId: string, now: string, code: TextAnalysisIssueCode): TextAnalysis => ({
  ...createTextAnalysis(mediaId, now), status: 'failed', issues: [{ code, stage: 'queue', fatal: true, trackId: null }], completedAt: now,
});

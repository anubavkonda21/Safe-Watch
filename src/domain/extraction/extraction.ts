/**
 * Extraction: the deterministic step that turns an uploaded video into
 * normalised assets (audio, subtitle cues, sampled frames) for future
 * analysis. It is independent of both MEDIA status (is the file stored and
 * readable?) and ANALYSIS status (has SafeWatch analysed the content?):
 *
 *   MEDIA       uploaded → processing → ready | failed
 *   EXTRACTION  not_started → queued → processing → completed | failed
 *   ANALYSIS    not_started → queued → processing → completed | failed   (no analysis exists yet)
 *
 * Nothing here knows about FFmpeg, FFprobe or file system paths. Future AI
 * code receives AudioAsset, SubtitleCue and Frame values, never tool output.
 */
export const EXTRACTION_STATUSES = ['not_started', 'queued', 'processing', 'completed', 'failed'] as const;
export type ExtractionStatus = (typeof EXTRACTION_STATUSES)[number];

/** Phase-based progress. Percentages are never fabricated; only these phases are reported. */
export const EXTRACTION_PHASES = ['preparing', 'extracting-audio', 'extracting-subtitles', 'sampling-frames', 'finalizing'] as const;
export type ExtractionPhase = (typeof EXTRACTION_PHASES)[number];

/** Light-weight state included in every media resource. */
export interface ExtractionState {
  status: ExtractionStatus;
  phase: ExtractionPhase | null;
}

export type ExtractionErrorCode =
  | 'timeout'
  | 'limit-exceeded'
  | 'invalid-media'
  | 'extraction-failed'
  | 'invalid-output'
  | 'cancelled'
  | 'server-busy'
  | 'server-unreachable'
  | 'duration-unknown'
  | 'track-unavailable'
  | 'frame-unavailable';

export type ExtractionStage = 'audio' | 'subtitles' | 'frames' | 'finalizing' | 'queue';

/**
 * A problem found during extraction. `fatal` issues fail the extraction
 * (status `failed`); non-fatal ones are warnings on an otherwise completed
 * extraction (e.g. one unreadable subtitle track). Codes are fixed; tool
 * output is never included.
 */
export interface ExtractionIssue {
  code: ExtractionErrorCode;
  stage: ExtractionStage;
  fatal: boolean;
  streamIndex: number | null;
}

/** Stream flags shared by audio and subtitle tracks. Unknown flags are false, not guessed. */
export interface TrackDisposition {
  default: boolean;
  forced: boolean;
  original: boolean;
  hearingImpaired: boolean;
  commentary: boolean;
}

/** Analysis-friendly audio: 16 kHz mono 16-bit PCM in WAV (see SAFEWATCH_MEDIA_ARCHITECTURE.md). */
export const AUDIO_FORMAT = { container: 'wav', codec: 'pcm_s16le', sampleRate: 16000, channels: 1 } as const;

export interface AudioAsset {
  /** Stable within a media item: `aud-<ordinal>`. */
  id: string;
  ordinal: number;
  /** Index of the stream in the source container. */
  streamIndex: number;
  language: string | null;
  title: string | null;
  disposition: TrackDisposition;
  source: { codec: string | null; sampleRate: number | null; channels: number | null; bitRate: number | null };
  format: typeof AUDIO_FORMAT;
  durationSeconds: number;
  sizeBytes: number;
  /** Logical artifact name inside this media's extraction storage (not a file system path). Null for duplicates. */
  artifact: string | null;
  /** Set when this stream's decoded audio is bit-identical to an earlier track; its file is not stored twice. */
  duplicateOf: string | null;
}

export const SUBTITLE_KINDS = ['text', 'image', 'unknown'] as const;
export type SubtitleKind = (typeof SUBTITLE_KINDS)[number];

/** `unsupported`: image or unknown subtitle (no OCR is performed). `failed`: a text track that could not be read. */
export type TextExtraction = 'extracted' | 'unsupported' | 'failed';

export interface SubtitleCue {
  index: number;
  startSeconds: number;
  endSeconds: number;
  /** Untrusted plain text. Never interpret as HTML. */
  text: string;
}

export interface SubtitleTrack {
  id: string;
  ordinal: number;
  streamIndex: number;
  language: string | null;
  title: string | null;
  codec: string | null;
  kind: SubtitleKind;
  textExtraction: TextExtraction;
  disposition: TrackDisposition;
  cueCount: number;
  cues: SubtitleCue[];
}

export interface Frame {
  id: string;
  index: number;
  /** Requested sample time in seconds (millisecond precision). Deterministic for the same media and settings. */
  timestampSeconds: number;
  width: number;
  height: number;
  format: 'jpeg';
  sizeBytes: number;
  /** Logical artifact name inside this media's extraction storage (not a file system path). */
  artifact: string;
}

export interface FrameSamplingConfig {
  /** Requested distance between samples. */
  intervalSeconds: number;
  maxFrames: number;
  maxWidth: number;
  maxHeight: number;
}

export interface FrameSet {
  config: FrameSamplingConfig;
  /** Interval actually used: larger than requested when `maxFrames` would otherwise be exceeded. */
  effectiveIntervalSeconds: number;
  totalSizeBytes: number;
  frames: Frame[];
}

export interface ExtractionMetrics {
  durationMs: number;
  stageMs: { audio: number; subtitles: number; frames: number };
  toolProcesses: number;
  outputBytes: number;
}

export interface MediaExtraction {
  mediaId: string;
  status: ExtractionStatus;
  phase: ExtractionPhase | null;
  audio: AudioAsset[];
  subtitles: SubtitleTrack[];
  frames: FrameSet | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  errors: ExtractionIssue[];
  metrics: ExtractionMetrics | null;
}

export class InvalidExtractionTransitionError extends Error {
  constructor(from: ExtractionStatus, to: ExtractionStatus) {
    super(`Illegal extraction transition ${from} → ${to}`);
    this.name = 'InvalidExtractionTransitionError';
  }
}

const ALLOWED: Record<ExtractionStatus, readonly ExtractionStatus[]> = {
  not_started: ['queued', 'failed'],
  queued: ['processing', 'failed'],
  processing: ['completed', 'failed'],
  completed: [],
  failed: [],
};

export const canTransitionExtraction = (from: ExtractionStatus, to: ExtractionStatus) => ALLOWED[from].includes(to);

function move(e: MediaExtraction, to: ExtractionStatus, patch: Partial<MediaExtraction>): MediaExtraction {
  if (!canTransitionExtraction(e.status, to)) throw new InvalidExtractionTransitionError(e.status, to);
  return { ...e, ...patch, status: to };
}

export const createExtraction = (mediaId: string, now: string): MediaExtraction => ({
  mediaId, status: 'not_started', phase: null, audio: [], subtitles: [], frames: null,
  createdAt: now, startedAt: null, completedAt: null, errors: [], metrics: null,
});

export const queueExtraction = (e: MediaExtraction): MediaExtraction => move(e, 'queued', { phase: null });
export const startExtraction = (e: MediaExtraction, now: string): MediaExtraction => move(e, 'processing', { phase: 'preparing', startedAt: now });

export function setExtractionPhase(e: MediaExtraction, phase: ExtractionPhase): MediaExtraction {
  if (e.status !== 'processing') throw new InvalidExtractionTransitionError(e.status, 'processing');
  return { ...e, phase };
}

export interface ExtractionResult {
  audio: AudioAsset[];
  subtitles: SubtitleTrack[];
  frames: FrameSet | null;
  warnings: ExtractionIssue[];
  metrics: ExtractionMetrics;
}

export const completeExtraction = (e: MediaExtraction, r: ExtractionResult, now: string): MediaExtraction =>
  move(e, 'completed', { phase: null, audio: r.audio, subtitles: r.subtitles, frames: r.frames, errors: r.warnings, metrics: r.metrics, completedAt: now });

/** Failure discards partial assets: only the structured error remains. */
export const failExtraction = (e: MediaExtraction, issue: ExtractionIssue, now: string, metrics: ExtractionMetrics | null = null): MediaExtraction =>
  move(e, 'failed', { phase: null, audio: [], subtitles: [], frames: null, errors: [...e.errors, issue], metrics, completedAt: now });

export const toExtractionState = (e: MediaExtraction): ExtractionState => ({ status: e.status, phase: e.phase });

/** A client-side stand-in when the extraction state could not be read (e.g. the server became unreachable). */
export const unavailableExtraction = (mediaId: string, now: string, code: ExtractionErrorCode): MediaExtraction => ({
  ...createExtraction(mediaId, now),
  status: 'failed',
  errors: [{ code, stage: 'queue', fatal: true, streamIndex: null }],
  completedAt: now,
});

import {
  AUDIO_FORMAT, completeExtraction, failExtraction, queueExtraction, setExtractionPhase, startExtraction,
  type AudioAsset, type ExtractionErrorCode, type ExtractionIssue, type ExtractionPhase, type ExtractionStage,
  type Frame, type FrameSet, type SubtitleTrack,
} from '@/domain/extraction/extraction';
import { planFrameTimestamps } from '@/domain/extraction/sampling';
import { classifySubtitleCodec, normalizeCues } from '@/domain/extraction/subtitles';
import { validateExtraction } from '@/domain/extraction/validate';
import type { MediaRecord } from '../domain/mediaRecord';
import { ExtractionError } from './errors';
import type { ExtractionContext, MediaExtractor } from './extractionPorts';
import type { ExtractionLimits, StreamInventory } from './extractionTypes';
import type { Logger, MediaRepository, MediaStorage } from './ports';
import type { ProcessingQueue } from './processingQueue';

export interface ExtractionServiceDeps {
  storage: MediaStorage;
  repository: MediaRepository;
  extractor: MediaExtractor;
  queue: ProcessingQueue;
  logger: Logger;
  limits: ExtractionLimits;
  now?: () => number;
  /** Called after an extraction has completed (used to start text analysis). */
  onCompleted?: (mediaId: string, requestId?: string) => void;
}

/** What the media service needs from extraction. */
export interface ExtractionScheduler {
  schedule(mediaId: string, requestId?: string): void;
  /** Aborts a running extraction. Used before deleting or expiring media. */
  cancel(mediaId: string): void;
}

const iso = (ms: number) => new Date(ms).toISOString();
const issue = (code: ExtractionErrorCode, stage: ExtractionStage, fatal: boolean, streamIndex: number | null = null): ExtractionIssue => ({ code, stage, fatal, streamIndex });
const WAV_BYTES_PER_SECOND = AUDIO_FORMAT.sampleRate * AUDIO_FORMAT.channels * 2;

/**
 * Orchestrates deterministic extraction for a ready media item:
 * streams → audio → subtitles → frames → validated manifest. Policy lives
 * here (selection, deduplication, caps, limits, cleanup); FFmpeg lives behind
 * `MediaExtractor`. Extraction state is separate from media and analysis state.
 */
export class MediaExtractionService implements ExtractionScheduler {
  private readonly running = new Map<string, { controller: AbortController; reason: 'timeout' | 'cancelled' | null }>();
  private readonly now: () => number;

  constructor(private readonly deps: ExtractionServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  schedule(mediaId: string, requestId?: string): void {
    const { repository, queue, logger } = this.deps;
    const record = repository.get(mediaId);
    if (!record || record.asset.status !== 'ready' || record.extraction.status !== 'not_started') return;

    if (!queue.hasCapacity()) {
      repository.set({ ...record, extraction: failExtraction(record.extraction, issue('server-busy', 'queue', true), iso(this.now())) });
      logger.warn('extraction rejected', { op: 'extract', requestId, mediaId, status: 'failed', code: 'server-busy' });
      return;
    }
    repository.set({ ...record, extraction: queueExtraction(record.extraction) });
    void queue.run(() => this.run(mediaId, requestId)).catch((e) => logger.error('extraction job crashed', { op: 'extract', mediaId, reason: e instanceof Error ? e.name : 'unknown' }));
  }

  cancel(mediaId: string): void {
    const job = this.running.get(mediaId);
    if (!job) return;
    job.reason ??= 'cancelled';
    job.controller.abort();
  }

  private update(mediaId: string, change: (r: MediaRecord) => MediaRecord): MediaRecord {
    const record = this.deps.repository.get(mediaId);
    if (!record) throw new ExtractionError('cancelled'); // media deleted while extracting
    const next = change(record);
    this.deps.repository.set(next);
    return next;
  }

  private phase(mediaId: string, phase: ExtractionPhase) {
    this.update(mediaId, (r) => ({ ...r, extraction: setExtractionPhase(r.extraction, phase) }));
  }

  private async run(mediaId: string, requestId?: string): Promise<void> {
    const { repository, storage, logger, limits } = this.deps;
    const deps = this.deps;
    const queued = repository.get(mediaId);
    if (!queued || queued.extraction.status !== 'queued') return; // deleted or already handled while waiting
    const started = this.now();
    const controller = new AbortController();
    const job = { controller, reason: null as 'timeout' | 'cancelled' | null };
    this.running.set(mediaId, job);
    const timer = setTimeout(() => { job.reason ??= 'timeout'; controller.abort(); }, limits.timeoutMs);

    try {
      this.update(mediaId, (r) => ({ ...r, extraction: startExtraction(r.extraction, iso(started)) }));
      const result = await storage.withLocalFile(mediaId, (file) =>
        storage.withExtractionDir(mediaId, async (workspace) => {
          const ctx: ExtractionContext = { input: { ...file, container: queued.asset.container }, workspace, signal: controller.signal, limits, stats: { processes: 0 } };
          return this.extractAll(mediaId, ctx, queued.asset.metadata.durationSeconds);
        }),
      );
      const done = this.update(mediaId, (r) => ({ ...r, extraction: completeExtraction(r.extraction, { ...result, metrics: { ...result.metrics, durationMs: this.now() - started } }, iso(this.now())) }));
      deps.onCompleted?.(mediaId, requestId);
      logger.info('extraction completed', {
        op: 'extract', requestId, mediaId, status: 'completed', durationMs: this.now() - started,
        audioTracks: done.extraction.audio.length, subtitleTracks: done.extraction.subtitles.length,
        frames: done.extraction.frames?.frames.length ?? 0, toolProcesses: result.metrics.toolProcesses, outputBytes: result.metrics.outputBytes, warnings: done.extraction.errors.length,
      });
    } catch (e) {
      const code: ExtractionErrorCode = job.reason ?? (e instanceof ExtractionError ? e.code : 'extraction-failed');
      // Partial outputs never survive a failure, timeout or cancellation.
      await storage.deleteExtraction(mediaId).catch((err) => logger.error('extraction cleanup failed; will retry on sweep', { op: 'extract', mediaId, reason: err instanceof Error ? err.name : 'unknown' }));
      if (repository.get(mediaId)) {
        this.update(mediaId, (r) => ({ ...r, extraction: failExtraction(r.extraction, issue(code, stageOf(r.extraction.phase), true), iso(this.now())) }));
        logger.warn('extraction failed', { op: 'extract', requestId, mediaId, status: 'failed', code, durationMs: this.now() - started });
      }
    } finally {
      clearTimeout(timer);
      this.running.delete(mediaId);
    }
  }

  private async extractAll(mediaId: string, ctx: ExtractionContext, mediaDuration: number | null) {
    const { extractor } = this.deps;
    const warnings: ExtractionIssue[] = [];
    const stageMs = { audio: 0, subtitles: 0, frames: 0 };
    const timed = async <T>(stage: keyof typeof stageMs, fn: () => Promise<T>): Promise<T> => {
      const t = this.now();
      try { return await fn(); } finally { stageMs[stage] += this.now() - t; }
    };

    const inventory = await extractor.inspect(ctx.input, ctx.signal);
    const duration = inventory.durationSeconds ?? mediaDuration;

    this.phase(mediaId, 'extracting-audio');
    const audio = await timed('audio', () => this.extractAudioTracks(mediaId, ctx, inventory, duration, warnings));

    this.phase(mediaId, 'extracting-subtitles');
    const subtitles = await timed('subtitles', () => this.extractSubtitleTracks(ctx, inventory, warnings));

    this.phase(mediaId, 'sampling-frames');
    const frames = await timed('frames', () => this.sampleFrames(ctx, duration, warnings));

    this.phase(mediaId, 'finalizing');
    const outputBytes = audio.reduce((n, a) => n + (a.duplicateOf === null ? a.sizeBytes : 0), 0) + (frames?.totalSizeBytes ?? 0);
    const current = this.deps.repository.get(mediaId);
    if (!current) throw new ExtractionError('cancelled');
    const manifestCheck = validateExtraction({ ...current.extraction, audio, subtitles, frames }, duration);
    if (manifestCheck.length > 0) throw new ExtractionError('invalid-output');

    // +1: the inspection (ffprobe) run is not counted by the adapter's per-job counter.
    return { audio, subtitles, frames, warnings, metrics: { durationMs: 0, stageMs, toolProcesses: ctx.stats.processes + 1, outputBytes } };
  }

  /**
   * Selection policy: every audio stream is extracted, in container order, up
   * to `maxAudioTracks`; extra streams are reported as warnings, never dropped
   * silently. A stream whose decoded audio is bit-identical to an earlier one
   * is recorded (metadata preserved) but its file is not stored twice.
   */
  private async extractAudioTracks(mediaId: string, ctx: ExtractionContext, inv: StreamInventory, duration: number | null, warnings: ExtractionIssue[]): Promise<AudioAsset[]> {
    const { extractor, storage, limits } = this.deps;
    const assets: AudioAsset[] = [];
    const byHash = new Map<string, string>();
    let ordinal = 0;
    let usedBytes = 0; // total audio budget is shared by all tracks of this media item
    for (const stream of inv.audio) {
      if (ordinal >= limits.maxAudioTracks) {
        warnings.push(issue('limit-exceeded', 'audio', false, stream.streamIndex));
        continue;
      }
      const expected = (stream.durationSeconds ?? duration ?? 0) * WAV_BYTES_PER_SECOND;
      const remaining = limits.maxAudioBytes - usedBytes;
      if (expected > remaining) throw new ExtractionError('limit-exceeded');
      const id = `aud-${ordinal}`;
      // The adapter enforces the remaining budget on the actual output, not just the estimate.
      const out = await extractor.extractAudio({ ...ctx, limits: { ...limits, maxAudioBytes: remaining } }, stream, ordinal);
      const duplicateOf = byHash.get(out.sha256) ?? null;
      if (duplicateOf === null) { byHash.set(out.sha256, id); usedBytes += out.sizeBytes; }
      else await storage.deleteArtifact(mediaId, out.artifact);
      assets.push({
        id, ordinal, streamIndex: stream.streamIndex, language: stream.language, title: stream.title, disposition: stream.disposition,
        source: { codec: stream.codec, sampleRate: stream.sampleRate, channels: stream.channels, bitRate: stream.bitRate },
        format: AUDIO_FORMAT, durationSeconds: out.durationSeconds, sizeBytes: out.sizeBytes,
        artifact: duplicateOf === null ? out.artifact : null, duplicateOf,
      });
      ordinal += 1;
    }
    return assets;
  }

  /**
   * Every subtitle stream is listed. Text tracks are extracted to normalised,
   * timestamped cues; image-based tracks (PGS, DVD, DVB) and unknown codecs
   * are listed as `unsupported` (no OCR). A single unreadable text track is a
   * warning and does not fail the extraction.
   */
  private async extractSubtitleTracks(ctx: ExtractionContext, inv: StreamInventory, warnings: ExtractionIssue[]): Promise<SubtitleTrack[]> {
    const { extractor, limits } = this.deps;
    const tracks: SubtitleTrack[] = [];
    let ordinal = 0;
    for (const stream of inv.subtitles) {
      const kind = classifySubtitleCodec(stream.codec);
      const base = { id: `sub-${ordinal}`, ordinal, streamIndex: stream.streamIndex, language: stream.language, title: stream.title, codec: stream.codec, kind, disposition: stream.disposition };
      ordinal += 1;
      if (kind !== 'text') {
        tracks.push({ ...base, textExtraction: 'unsupported', cueCount: 0, cues: [] });
        continue;
      }
      try {
        const cues = normalizeCues(await extractor.extractSubtitleCues(ctx, stream));
        if (cues.length > limits.maxCues) throw new ExtractionError('limit-exceeded');
        tracks.push({ ...base, textExtraction: 'extracted', cueCount: cues.length, cues });
      } catch (e) {
        if (e instanceof ExtractionError && e.code === 'timeout') throw e;
        warnings.push(issue(e instanceof ExtractionError && e.code === 'limit-exceeded' ? 'limit-exceeded' : 'track-unavailable', 'subtitles', false, stream.streamIndex));
        tracks.push({ ...base, textExtraction: 'failed', cueCount: 0, cues: [] });
      }
    }
    return tracks;
  }

  /**
   * Frame sampling: timestamps come from the pure planner (equal intervals,
   * mid-interval, capped at maxFrames). Each frame is an independent fast-seek
   * decode, run sequentially so a job never runs more than one FFmpeg process
   * at a time. The running size is checked after every frame.
   */
  private async sampleFrames(ctx: ExtractionContext, duration: number | null, warnings: ExtractionIssue[]): Promise<FrameSet | null> {
    const { extractor, limits } = this.deps;
    const config = limits.frame;
    // Without a duration the video cannot be divided into intervals: sample only the first moment and say so.
    if (duration === null) warnings.push(issue('duration-unknown', 'frames', false));
    const plan = duration === null ? { timestamps: [0], effectiveIntervalSeconds: config.intervalSeconds } : planFrameTimestamps(duration, config);
    const frames: Frame[] = [];
    let total = 0;
    for (const timestamp of plan.timestamps) {
      const out = await extractor.sampleFrame(ctx, timestamp, frames.length);
      if (!out) { warnings.push(issue('frame-unavailable', 'frames', false)); continue; }
      total += out.sizeBytes;
      if (total > limits.maxFrameBytes) throw new ExtractionError('limit-exceeded');
      const index = frames.length;
      frames.push({ id: `frm-${String(index).padStart(5, '0')}`, index, timestampSeconds: timestamp, width: out.width, height: out.height, format: 'jpeg', sizeBytes: out.sizeBytes, artifact: out.artifact });
    }
    if (plan.timestamps.length > 0 && frames.length === 0) throw new ExtractionError('extraction-failed');
    return { config, effectiveIntervalSeconds: plan.effectiveIntervalSeconds, totalSizeBytes: total, frames };
  }
}

function stageOf(phase: ExtractionPhase | null): ExtractionStage {
  switch (phase) {
    case 'extracting-audio': return 'audio';
    case 'extracting-subtitles': return 'subtitles';
    case 'sampling-frames': return 'frames';
    case 'finalizing': return 'finalizing';
    default: return 'queue';
  }
}

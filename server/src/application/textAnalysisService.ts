import { completeTextAnalysis, failTextAnalysis, queueTextAnalysis, setTextAnalysisPhase, startTextAnalysis,
  type SpeechErrorCode, type SpeechTrackResult, type TextAnalysisIssue, type TextAnalysisIssueCode, type TextAnalysisPhase } from '@/domain/text/textAnalysis';
import { normalizeTranscription } from '@/domain/speech/normalize';
import { validateTranscript, type Transcript } from '@/domain/speech/transcript';
import { primaryLanguage, selectAudioTracks } from '@/domain/speech/trackSelection';
import { alignText } from '@/domain/text/alignment';
import { buildTimeline, eventsFromSubtitleTrack, eventsFromTranscript, type TextEvent } from '@/domain/text/textEvent';
import type { AudioAsset } from '@/domain/extraction/extraction';
import type { SpeechConfig } from '../config';
import type { Logger, MediaRepository, MediaStorage } from './ports';
import type { ProcessingQueue } from './processingQueue';
import { SpeechError, type SpeechToTextProvider } from './speechPorts';

export interface TextAnalysisLimits {
  /** Two-letter language to force, or `auto`. Also the preferred audio-track language. */
  language: string;
  timeoutMs: number;
  maxAudioBytes: number;
  maxDurationSeconds: number;
  maxTracks: number;
}

export interface TextAnalysisDeps {
  storage: MediaStorage;
  repository: MediaRepository;
  /** Null: speech-to-text is not configured; subtitle evidence is still collected. */
  speech: SpeechToTextProvider | null;
  queue: ProcessingQueue;
  logger: Logger;
  limits: TextAnalysisLimits;
  now?: () => number;
}

export const limitsFromConfig = (c: SpeechConfig): TextAnalysisLimits => ({ language: c.language, timeoutMs: c.timeoutMs, maxAudioBytes: c.maxAudioBytes, maxDurationSeconds: c.maxDurationSeconds, maxTracks: c.maxTracks });

const iso = (ms: number) => new Date(ms).toISOString();
const issue = (code: TextAnalysisIssueCode, stage: TextAnalysisIssue['stage'], fatal: boolean, trackId: string | null = null): TextAnalysisIssue => ({ code, stage, fatal, trackId });

/**
 * Collects TEXT EVIDENCE for a media item once extraction has completed:
 * speech transcripts (through the SpeechToTextProvider port) and the
 * subtitle cues from extraction, merged into one aligned timeline.
 * It decides nothing about safety. Runs on its own bounded queue, never
 * blocks uploads, and every temporary resource is released on any outcome.
 */
export class TextAnalysisService {
  private readonly running = new Map<string, { controller: AbortController; cancelled: boolean }>();
  private readonly now: () => number;

  constructor(private readonly deps: TextAnalysisDeps) {
    this.now = deps.now ?? Date.now;
  }

  schedule(mediaId: string, requestId?: string): void {
    const { repository, queue, logger } = this.deps;
    const record = repository.get(mediaId);
    if (!record || record.extraction.status !== 'completed' || record.text.status !== 'not_started') return;
    if (!queue.hasCapacity()) {
      repository.set({ ...record, text: failTextAnalysis(record.text, issue('server-busy', 'queue', true), iso(this.now())) });
      logger.warn('text analysis rejected', { op: 'text', requestId, mediaId, status: 'failed', code: 'server-busy' });
      return;
    }
    repository.set({ ...record, text: queueTextAnalysis(record.text) });
    void queue.run(() => this.run(mediaId, requestId)).catch((e) => logger.error('text analysis job crashed', { op: 'text', mediaId, reason: e instanceof Error ? e.name : 'unknown' }));
  }

  /** Aborts a running transcription (and its inference process). Used before media is deleted. */
  cancel(mediaId: string): void {
    const job = this.running.get(mediaId);
    if (!job) return;
    job.cancelled = true;
    job.controller.abort('cancelled');
  }

  private update(mediaId: string, change: (r: NonNullable<ReturnType<MediaRepository['get']>>) => NonNullable<ReturnType<MediaRepository['get']>>) {
    const record = this.deps.repository.get(mediaId);
    if (!record) throw new SpeechError('cancelled');
    this.deps.repository.set(change(record));
  }

  private phase(mediaId: string, phase: TextAnalysisPhase) {
    this.update(mediaId, (r) => ({ ...r, text: setTextAnalysisPhase(r.text, phase) }));
  }

  private async run(mediaId: string, requestId?: string): Promise<void> {
    const { repository, logger } = this.deps;
    const queued = repository.get(mediaId);
    if (!queued || queued.text.status !== 'queued') return;
    const started = this.now();
    const job = { controller: new AbortController(), cancelled: false };
    this.running.set(mediaId, job);
    try {
      this.update(mediaId, (r) => ({ ...r, text: startTextAnalysis(r.text, iso(started)) }));
      const extraction = queued.extraction;
      const issues: TextAnalysisIssue[] = [];

      this.phase(mediaId, 'speech-processing');
      const speechStarted = this.now();
      const { results, audioSeconds } = await this.transcribeTracks(mediaId, extraction.audio, job, issues);
      const speechMs = this.now() - speechStarted;

      this.phase(mediaId, 'building-timeline');
      const transcripts = results.flatMap((r) => (r.transcript ? [r.transcript] : []));
      const events: TextEvent[] = [
        ...transcripts.flatMap(eventsFromTranscript),
        ...extraction.subtitles.flatMap(eventsFromSubtitleTrack),
      ];
      const aligned = alignText(buildTimeline(events));
      if (aligned.events.length === 0) issues.push(issue('no-text', 'timeline', false));
      for (const t of extraction.subtitles) {
        if (t.kind === 'text' && t.textExtraction === 'failed') issues.push(issue('subtitle-unavailable', 'timeline', false, t.id));
      }

      const completed = this.now();
      this.update(mediaId, (r) => ({
        ...r,
        text: completeTextAnalysis(r.text, {
          speech: results, timeline: aligned.events, alignment: { links: aligned.links, counts: aligned.counts },
          provider: transcripts.length > 0 && this.deps.speech ? this.deps.speech.info : null,
          issues, metrics: { durationMs: completed - started, speechMs, audioSeconds },
        }, iso(completed)),
      }));
      logger.info('text analysis ready', {
        op: 'text', requestId, mediaId, status: 'ready', durationMs: completed - started, speechMs, audioSeconds,
        transcripts: transcripts.length, segments: transcripts.reduce((n, t) => n + t.segments.length, 0), events: aligned.events.length, warnings: issues.length,
      });
    } catch (e) {
      if (repository.get(mediaId)) {
        const code: TextAnalysisIssueCode = job.cancelled ? 'cancelled' : e instanceof SpeechError ? e.code : 'provider-failed';
        this.update(mediaId, (r) => ({ ...r, text: failTextAnalysis(r.text, issue(code, 'timeline', true), iso(this.now())) }));
        logger.warn('text analysis failed', { op: 'text', requestId, mediaId, status: 'failed', code, durationMs: this.now() - started });
      }
    } finally {
      this.running.delete(mediaId);
    }
  }

  private async transcribeTracks(mediaId: string, audio: readonly AudioAsset[], job: { controller: AbortController; cancelled: boolean }, issues: TextAnalysisIssue[]) {
    const { speech, storage, limits, logger } = this.deps;
    const preferred = limits.language === 'auto' ? null : limits.language;
    const selection = selectAudioTracks(audio, { preferredLanguage: preferred, maxTracks: limits.maxTracks });
    const results = new Map<string, SpeechTrackResult>();
    const base = (a: AudioAsset): Omit<SpeechTrackResult, 'status' | 'skipReason' | 'error' | 'transcript' | 'processingMs'> => ({ audioTrackId: a.id, streamIndex: a.streamIndex, containerLanguage: a.language });
    for (const s of selection.skipped) {
      const a = audio.find((x) => x.id === s.id)!;
      results.set(a.id, { ...base(a), status: 'skipped', skipReason: s.reason, error: null, transcript: null, processingMs: null });
    }

    let audioSeconds = 0;
    for (const id of selection.selected) {
      const asset = audio.find((x) => x.id === id)!;
      const fail = (error: SpeechErrorCode, processingMs: number | null = null) => {
        results.set(id, { ...base(asset), status: 'failed', skipReason: null, error, transcript: null, processingMs });
        issues.push(issue(error, 'speech', false, id));
      };
      if (!speech) {
        results.set(id, { ...base(asset), status: 'skipped', skipReason: 'speech-disabled', error: null, transcript: null, processingMs: null });
        continue;
      }
      if (job.cancelled) throw new SpeechError('cancelled');
      if (asset.durationSeconds > limits.maxDurationSeconds || asset.sizeBytes > limits.maxAudioBytes) { fail('resource-limit'); continue; }

      const t0 = this.now();
      // Per-track deadline plus job cancellation; the reason tells the adapter which one fired.
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort('timeout'), limits.timeoutMs);
      const signal = AbortSignal.any([job.controller.signal, deadline.signal]);
      try {
        const raw = await storage.withArtifactFile(mediaId, asset.artifact!, (file) =>
          speech.transcribe({ file, durationSeconds: asset.durationSeconds }, { language: preferred, signal }));
        let transcript: Transcript;
        try {
          transcript = normalizeTranscription(raw, { mediaId, audioTrackId: id, streamIndex: asset.streamIndex, durationSeconds: asset.durationSeconds, provider: speech.info });
        } catch {
          throw new SpeechError('invalid-response');
        }
        if (validateTranscript(transcript).length > 0) throw new SpeechError('invalid-response');
        audioSeconds += asset.durationSeconds;
        results.set(id, { ...base(asset), status: 'completed', skipReason: null, error: null, transcript, processingMs: this.now() - t0 });
        logger.info('speech track transcribed', { op: 'speech', mediaId, trackId: id, status: 'completed', durationMs: this.now() - t0, audioSeconds: asset.durationSeconds, segments: transcript.segments.length, language: transcript.language });
      } catch (e) {
        if (job.cancelled) throw new SpeechError('cancelled');
        const code: SpeechErrorCode = deadline.signal.aborted ? 'timeout' : e instanceof SpeechError ? e.code : 'provider-failed';
        fail(code, this.now() - t0);
        logger.warn('speech track failed', { op: 'speech', mediaId, trackId: id, status: 'failed', code, durationMs: this.now() - t0 });
      } finally {
        clearTimeout(timer);
      }
    }
    return { results: audio.map((a) => results.get(a.id)).filter((r): r is SpeechTrackResult => r !== undefined), audioSeconds };
  }
}

export { primaryLanguage };

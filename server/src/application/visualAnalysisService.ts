import { normalizeObservation, sortObservations, type VisualObservation } from '@/domain/vision/observation';
import {
  completeVisual, failVisual, queueVisual, setVisualPhase, startVisual,
  type VisualErrorCode, type VisualFrame, type VisualIssue, type VisualResult,
} from '@/domain/vision/visualAnalysis';
import type { Frame } from '@/domain/extraction/extraction';
import type { VisionConfig } from '../config';
import type { MediaRecord } from '../domain/mediaRecord';
import type { Logger, MediaRepository, MediaStorage } from './ports';
import type { ProcessingQueue } from './processingQueue';
import { VisionError, type VisionFrameResult, type VisualAnalysisProvider } from './visualPorts';

export type VisualLimits = Pick<VisionConfig, 'timeoutMs' | 'maxFrames' | 'batchSize' | 'maxFrameBytes' | 'minConfidence' | 'maxLabelsPerFrame' | 'maxObservationsPerFrame'>;

export interface VisualAnalysisDeps {
  storage: MediaStorage;
  repository: MediaRepository;
  /** Null: visual analysis is not configured. */
  provider: VisualAnalysisProvider | null;
  queue: ProcessingQueue;
  logger: Logger;
  limits: VisualLimits;
  now?: () => number;
}

export const limitsFromVisionConfig = (c: VisionConfig): VisualLimits => ({
  timeoutMs: c.timeoutMs, maxFrames: c.maxFrames, batchSize: c.batchSize, maxFrameBytes: c.maxFrameBytes,
  minConfidence: c.minConfidence, maxLabelsPerFrame: c.maxLabelsPerFrame, maxObservationsPerFrame: c.maxObservationsPerFrame,
});

const iso = (ms: number) => new Date(ms).toISOString();
const issue = (code: VisualIssue['code'], stage: VisualIssue['stage'], fatal: boolean, count = 0): VisualIssue => ({ code, stage, fatal, count });
type Job = { controller: AbortController; cancelled: boolean };

/**
 * Collects VISUAL EVIDENCE for a media item once extraction has completed:
 * the frames extraction produced are analysed through the
 * VisualAnalysisProvider port and turned into timestamped observations on the
 * media timeline. It decides nothing about safety: no score, no verdict, no
 * action. Runs on its own bounded queue, isolates failures per frame, and
 * every temporary resource is released on any outcome.
 */
export class VisualAnalysisService {
  private readonly running = new Map<string, Job>();
  private readonly now: () => number;

  constructor(private readonly deps: VisualAnalysisDeps) {
    this.now = deps.now ?? Date.now;
  }

  schedule(mediaId: string, requestId?: string): void {
    const { repository, queue, logger, provider } = this.deps;
    const record = repository.get(mediaId);
    if (!record || record.extraction.status !== 'completed' || record.visual.status !== 'not_started') return;
    const reject = (code: VisualIssue['code'], stage: VisualIssue['stage']) => {
      repository.set({ ...record, visual: failVisual(record.visual, issue(code, stage, true), iso(this.now())) });
      logger.warn('visual analysis not started', { op: 'visual', requestId, mediaId, status: 'failed', code });
    };
    if (!provider) return reject('provider-unavailable', 'provider');
    if (!queue.hasCapacity()) return reject('server-busy', 'queue');
    repository.set({ ...record, visual: queueVisual(record.visual) });
    void queue.run(() => this.run(mediaId, requestId)).catch((e) => logger.error('visual analysis job crashed', { op: 'visual', mediaId, reason: e instanceof Error ? e.name : 'unknown' }));
  }

  /** Aborts a running analysis (and its inference process). Used before media is deleted. */
  cancel(mediaId: string): void {
    const job = this.running.get(mediaId);
    if (!job) return;
    job.cancelled = true;
    job.controller.abort('cancelled');
  }

  private update(mediaId: string, change: (r: MediaRecord) => MediaRecord) {
    const record = this.deps.repository.get(mediaId);
    if (!record) throw new VisionError('cancelled');
    this.deps.repository.set(change(record));
  }

  private async run(mediaId: string, requestId?: string): Promise<void> {
    const { repository, logger, limits } = this.deps;
    const queued = repository.get(mediaId);
    if (!queued || queued.visual.status !== 'queued') return;
    const started = this.now();
    const job: Job = { controller: new AbortController(), cancelled: false };
    this.running.set(mediaId, job);
    try {
      this.update(mediaId, (r) => ({ ...r, visual: startVisual(r.visual, iso(started)) }));
      const candidates = queued.extraction.frames?.frames ?? [];
      const issues: VisualIssue[] = [];
      if (candidates.length === 0) issues.push(issue('no-frames', 'frames', false));

      const frames = new Map<string, VisualFrame>();
      const observations: VisualObservation[] = [];
      const counters = { dropped: 0, providerMs: 0, batches: 0 };
      const eligible: Frame[] = [];
      for (const f of candidates) {
        if (eligible.length >= limits.maxFrames) frames.set(f.id, frameOf(f, 'skipped', null, 'over-limit'));
        else if (f.sizeBytes > limits.maxFrameBytes) frames.set(f.id, frameOf(f, 'failed', 'resource-limit'));
        else eligible.push(f);
      }

      let done = frames.size;
      for (let i = 0; i < eligible.length; i += limits.batchSize) {
        if (job.cancelled) throw new VisionError('cancelled');
        const batch = eligible.slice(i, i + limits.batchSize);
        this.update(mediaId, (r) => ({ ...r, visual: setVisualPhase(r.visual, 'analyzing-frames', { framesDone: done, framesTotal: candidates.length }) }));
        await this.analyzeBatch(mediaId, batch, job, frames, observations, counters);
        done += batch.length;
      }

      this.update(mediaId, (r) => ({ ...r, visual: setVisualPhase(r.visual, 'building-timeline') }));
      const all = candidates.map((f) => frames.get(f.id)!);
      const analyzed = all.filter((f) => f.status === 'analyzed').length;
      const failedCodes = new Map<VisualErrorCode, number>();
      for (const f of all) if (f.status === 'failed' && f.error) failedCodes.set(f.error, (failedCodes.get(f.error) ?? 0) + 1);
      for (const [code, count] of failedCodes) issues.push(issue(code, 'frames', false, count));
      if (counters.dropped > 0) issues.push(issue('observations-dropped', 'timeline', false, counters.dropped));
      const completed = this.now();
      const metrics = { durationMs: completed - started, providerMs: counters.providerMs, batches: counters.batches };

      if (candidates.length > 0 && analyzed === 0 && failedCodes.size > 0) {
        // Nothing could be analysed: the stage failed, with the most common cause as the fatal issue.
        const [code, count] = [...failedCodes].sort((a, b) => b[1] - a[1])[0]!;
        this.update(mediaId, (r) => ({ ...r, visual: failVisual(r.visual, issue(code, 'provider', true, count), iso(completed), metrics) }));
        logger.warn('visual analysis failed', { op: 'visual', requestId, mediaId, status: 'failed', code, durationMs: metrics.durationMs });
        return;
      }
      const result: VisualResult = { frames: all, observations: sortObservations(observations), provider: this.deps.provider ? { ...this.deps.provider.info } : null, issues, metrics };
      this.update(mediaId, (r) => ({ ...r, visual: completeVisual(r.visual, result, iso(completed)) }));
      logger.info('visual analysis ready', {
        op: 'visual', requestId, mediaId, status: 'ready', durationMs: metrics.durationMs, providerMs: metrics.providerMs,
        frames: all.length, analyzed, observations: observations.length, warnings: issues.length,
      });
    } catch (e) {
      if (repository.get(mediaId)) {
        const code: VisualErrorCode = job.cancelled ? 'cancelled' : e instanceof VisionError ? e.code : 'inference-failed';
        this.update(mediaId, (r) => ({ ...r, visual: failVisual(r.visual, issue(code, 'provider', true), iso(this.now())) }));
        logger.warn('visual analysis failed', { op: 'visual', requestId, mediaId, status: 'failed', code, durationMs: this.now() - started });
      }
    } finally {
      this.running.delete(mediaId);
    }
  }

  /** Analyses one batch. Failures here are isolated to the batch's frames, except cancellation and an unavailable provider. */
  private async analyzeBatch(
    mediaId: string, batch: readonly Frame[], job: Job, frames: Map<string, VisualFrame>, observations: VisualObservation[],
    counters: { dropped: number; providerMs: number; batches: number },
  ) {
    const { provider, storage, limits, logger } = this.deps;
    if (!provider) throw new VisionError('provider-unavailable');
    const fail = (f: Frame, code: VisualErrorCode) => frames.set(f.id, frameOf(f, 'failed', code));

    // Frames whose file is gone are reported as such; the rest go to the provider together.
    const present: Frame[] = [];
    for (const f of batch) {
      try { await storage.withArtifactFile(mediaId, f.artifact, async () => undefined); present.push(f); } catch {
        fail(f, 'frame-missing');
      }
    }
    if (present.length === 0) return;

    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort('timeout'), limits.timeoutMs);
    const signal = AbortSignal.any([job.controller.signal, deadline.signal]);
    const t0 = this.now();
    try {
      const results = await withFiles(storage, mediaId, present, (paths) =>
        provider.analyze(present.map((f, i) => ({ frameId: f.id, path: paths[i]! })), { signal, minConfidence: limits.minConfidence, maxLabelsPerFrame: limits.maxLabelsPerFrame }));
      counters.batches += 1;
      counters.providerMs += this.now() - t0;
      const byId = new Map<string, VisionFrameResult>(results.map((r) => [r.frameId, r]));
      for (const f of present) {
        const r = byId.get(f.id);
        if (!r) { fail(f, 'inference-failed'); continue; }
        if (r.error) { fail(f, r.error); continue; }
        const kept: VisualObservation[] = [];
        r.observations.slice(0, limits.maxObservationsPerFrame).forEach((raw) => {
          const n = normalizeObservation(raw, { frameId: f.id, frameIndex: f.index, timestampSeconds: f.timestampSeconds, provider: provider.info.name, model: provider.info.model }, kept.length);
          if (n.observation) kept.push(n.observation); else counters.dropped += 1;
        });
        counters.dropped += Math.max(0, r.observations.length - limits.maxObservationsPerFrame);
        observations.push(...kept);
        frames.set(f.id, { ...frameOf(f, 'analyzed'), observationCount: kept.length, processingMs: r.elapsedMs });
      }
    } catch (e) {
      if (job.cancelled) throw new VisionError('cancelled');
      const code: VisualErrorCode = deadline.signal.aborted ? 'timeout' : e instanceof VisionError ? e.code : 'inference-failed';
      if (code === 'provider-unavailable' || code === 'cancelled') throw new VisionError(code);
      for (const f of present) fail(f, code);
      logger.warn('visual batch failed', { op: 'visual', mediaId, status: 'failed', code, frames: present.length, durationMs: this.now() - t0 });
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Nests `withArtifactFile` so every path stays valid for the whole provider call. */
async function withFiles<T>(storage: MediaStorage, mediaId: string, frames: readonly Frame[], fn: (paths: string[]) => Promise<T>, paths: string[] = []): Promise<T> {
  const next = frames[paths.length];
  if (!next) return fn(paths);
  return storage.withArtifactFile(mediaId, next.artifact, (file) => withFiles(storage, mediaId, frames, fn, [...paths, file.path]));
}

function frameOf(f: Frame, status: VisualFrame['status'], error: VisualErrorCode | null = null, skipReason: VisualFrame['skipReason'] = null): VisualFrame {
  return { frameId: f.id, index: f.index, timestampSeconds: f.timestampSeconds, width: f.width, height: f.height, format: 'jpeg', status, error, skipReason, observationCount: 0, processingMs: null };
}

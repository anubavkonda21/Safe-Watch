import { randomUUID } from 'node:crypto';
import { PENDING_METADATA, type MediaAsset } from '@/domain/media/asset';
import { CONTAINER_INFO, SNIFF_BYTES, detectContainer, type ContainerFormat } from '@/domain/media/container';
import { MediaIngestionError, type MediaErrorCode } from '@/domain/media/errors';
import { containerMatchesExtension, sanitizeFilename, validateMediaFile } from '@/domain/media/validation';
import type { MediaResource } from '@/domain/api/contract';
import type { MediaExtraction } from '@/domain/extraction/extraction';
import type { TextAnalysis } from '@/domain/text/textAnalysis';
import type { VisualAnalysis } from '@/domain/vision/visualAnalysis';
import { createUploadedRecord, markFailed, markProcessing, markReady, toResource } from '../domain/mediaRecord';
import { MediaServiceError } from './errors';
import type { Logger, MediaRepository, MediaStorage, ServerMediaProcessor } from './ports';
import { StorageError } from './ports';
import type { ExtractionScheduler } from './extractionService';
import type { ProcessingQueue } from './processingQueue';

export interface MediaServiceDeps {
  storage: MediaStorage;
  repository: MediaRepository;
  processor: ServerMediaProcessor;
  queue: ProcessingQueue;
  /** Optional: when present, extraction is scheduled as soon as media is ready and cancelled before media is deleted. */
  extraction?: ExtractionScheduler;
  /** Optional: text analysis is cancelled before media is deleted. */
  textAnalysis?: { cancel(mediaId: string): void };
  /** Optional: visual analysis is cancelled before media is deleted. */
  visualAnalysis?: { cancel(mediaId: string): void };
  logger: Logger;
  limits: { maxUploadBytes: number; maxConcurrentUploads: number; processingTimeoutMs: number; retentionMs: number };
  now?: () => number;
  newId?: () => string;
}

export interface UploadInput {
  body: AsyncIterable<Uint8Array>;
  /** Declared by the client: untrusted. */
  filename: string;
  mimeType: string;
  contentLength: number | null;
  signal?: AbortSignal;
  requestId: string;
}

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isMediaId = (v: string) => ID_PATTERN.test(v);

const FROM_VALIDATION: Record<string, MediaServiceError['code']> = {
  'unsupported-type': 'UNSUPPORTED_MEDIA',
  'file-too-large': 'FILE_TOO_LARGE',
  'empty-file': 'INVALID_FILE',
};

/**
 * Use cases for server-side media: upload → store → inspect → ready, plus
 * lookup, deletion and expiry. Contains no HTTP, filesystem or FFmpeg code.
 */
export class MediaService {
  private activeUploads = 0;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(private readonly deps: MediaServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? randomUUID;
  }

  /** Discards leftovers from a previous run. In-memory records do not survive restarts, so no stored file can still be referenced. */
  async start(): Promise<void> {
    const { removed } = await this.deps.storage.purge();
    this.deps.logger.info('startup cleanup', { op: 'startup-cleanup', removed });
  }

  async upload(input: UploadInput): Promise<MediaResource> {
    const { storage, repository, logger, limits } = this.deps;
    const started = this.now();

    // Cheap checks first: nothing has been read from the network or written to disk yet.
    if (input.contentLength === 0) throw new MediaServiceError('INVALID_FILE');
    const check = validateMediaFile(
      { name: input.filename, type: input.mimeType, size: input.contentLength ?? 1 },
      limits.maxUploadBytes,
    );
    if (!check.ok) throw new MediaServiceError(FROM_VALIDATION[check.code] ?? 'INVALID_FILE');
    if (this.activeUploads >= limits.maxConcurrentUploads || !this.deps.queue.hasCapacity()) {
      throw new MediaServiceError('SERVER_BUSY');
    }

    const id = this.newId();
    const sniffed: { container: ContainerFormat | null } = { container: null };
    this.activeUploads += 1;
    try {
      const tapped = this.sniffEarly(input.body, input.filename, (c) => { sniffed.container = c; });
      let sizeBytes: number;
      try {
        ({ sizeBytes } = await storage.save(id, tapped, { maxBytes: limits.maxUploadBytes, signal: input.signal }));
      } catch (e) {
        throw this.mapUploadError(e, input.signal);
      }
      const container = sniffed.container;
      if (sizeBytes === 0 || container === null) {
        await this.safeDelete(id);
        throw new MediaServiceError('INVALID_FILE');
      }

      const info = CONTAINER_INFO[container];
      const asset: MediaAsset = {
        id,
        filename: sanitizeFilename(input.filename),
        mimeType: info.mimeType,
        container,
        typeLabel: info.label,
        sizeBytes,
        status: 'uploaded',
        metadata: PENDING_METADATA,
        createdAt: new Date(this.now()).toISOString(),
        failure: null,
      };
      const record = createUploadedRecord(asset, this.now(), limits.retentionMs);
      repository.set(record);
      logger.info('upload stored', { op: 'upload', requestId: input.requestId, mediaId: id, status: 'uploaded', sizeBytes, durationMs: this.now() - started });

      this.startProcessing(id, input.requestId);
      return toResource(record);
    } catch (e) {
      await this.safeDelete(id); // covers every failure path, including ones that left partial data
      if (!(e instanceof MediaServiceError)) throw e;
      logger.warn('upload rejected', { op: 'upload', requestId: input.requestId, mediaId: id, status: 'rejected', code: e.code, durationMs: this.now() - started });
      throw e;
    } finally {
      this.activeUploads -= 1;
    }
  }

  get(id: string): MediaResource {
    const record = isMediaId(id) ? this.deps.repository.get(id) : undefined;
    if (!record) throw new MediaServiceError('NOT_FOUND');
    return toResource(record);
  }

  /** Full extraction manifest (assets and metrics). Contains no paths or tool output. */
  getExtraction(id: string): MediaExtraction {
    const record = isMediaId(id) ? this.deps.repository.get(id) : undefined;
    if (!record) throw new MediaServiceError('NOT_FOUND');
    return record.extraction;
  }

  /** Speech transcripts and subtitle timeline (text evidence). Contains no paths, provider output or credentials. */
  getTextAnalysis(id: string, options: { words?: boolean } = {}): TextAnalysis {
    const record = isMediaId(id) ? this.deps.repository.get(id) : undefined;
    if (!record) throw new MediaServiceError('NOT_FOUND');
    if (options.words === false) {
      // Word timing can be large; omit it on request.
      const strip = <T extends { words: unknown }>(x: T) => ({ ...x, words: null });
      return {
        ...record.text,
        speech: record.text.speech.map((s) => (s.transcript ? { ...s, transcript: { ...s.transcript, segments: s.transcript.segments.map(strip) } } : s)),
        timeline: record.text.timeline.map(strip),
      };
    }
    return record.text;
  }

  getVisualAnalysis(id: string, options: { observations?: boolean } = {}): VisualAnalysis {
    const record = isMediaId(id) ? this.deps.repository.get(id) : undefined;
    if (!record) throw new MediaServiceError('NOT_FOUND');
    return options.observations === false ? { ...record.visual, observations: [] } : record.visual;
  }

  /**
   * A sampled frame, by its manifest id. Only ids listed in the extraction manifest resolve;
   * the client never supplies a path or an artifact name.
   */
  getFrame(id: string, frameId: string): { stream: AsyncIterable<Uint8Array>; sizeBytes: number } {
    const record = isMediaId(id) ? this.deps.repository.get(id) : undefined;
    const frame = record?.extraction.frames?.frames.find((f) => f.id === frameId);
    if (!record || !frame) throw new MediaServiceError('NOT_FOUND');
    return { stream: this.deps.storage.readArtifact(id, frame.artifact), sizeBytes: frame.sizeBytes };
  }

  async delete(id: string): Promise<void> {
    if (!isMediaId(id)) return;
    this.deps.extraction?.cancel(id);
    this.deps.textAnalysis?.cancel(id);
    this.deps.visualAnalysis?.cancel(id);
    this.deps.repository.delete(id);
    await this.safeDelete(id);
    this.deps.logger.info('media deleted', { op: 'delete', mediaId: id });
  }

  /** Removes expired records and their files, then any orphaned files older than the retention window. */
  async sweep(): Promise<{ expired: number; orphans: number }> {
    const expired = this.deps.repository.expired(this.now());
    for (const record of expired) {
      this.deps.extraction?.cancel(record.asset.id);
      this.deps.textAnalysis?.cancel(record.asset.id);
      this.deps.visualAnalysis?.cancel(record.asset.id);
      this.deps.repository.delete(record.asset.id);
      await this.safeDelete(record.asset.id);
    }
    let orphans = 0;
    try {
      ({ removed: orphans } = await this.deps.storage.cleanup({ olderThanMs: this.deps.limits.retentionMs }));
    } catch (e) {
      this.deps.logger.error('orphan cleanup failed', { op: 'sweep', reason: errorName(e) });
    }
    if (expired.length || orphans) this.deps.logger.info('sweep', { op: 'sweep', expired: expired.length, orphans });
    return { expired: expired.length, orphans };
  }

  /** Reads the first bytes while streaming, and rejects early if the content is not a plausible match for the claimed extension. */
  private async *sniffEarly(
    body: AsyncIterable<Uint8Array>,
    filename: string,
    onContainer: (c: ContainerFormat) => void,
  ): AsyncGenerator<Uint8Array> {
    let head = new Uint8Array(0);
    let decided = false;
    const decide = () => {
      decided = true;
      const container = detectContainer(head);
      if (!container || !containerMatchesExtension(filename, container)) throw new MediaServiceError('UNSUPPORTED_MEDIA');
      onContainer(container);
    };
    for await (const chunk of body) {
      if (!decided) {
        const merged = new Uint8Array(Math.min(head.length + chunk.length, SNIFF_BYTES));
        merged.set(head);
        merged.set(chunk.subarray(0, merged.length - head.length), head.length);
        head = merged;
        if (head.length >= SNIFF_BYTES) decide();
      }
      yield chunk;
    }
    if (!decided && head.length > 0) decide(); // very small file
  }

  private mapUploadError(e: unknown, signal?: AbortSignal): Error {
    if (e instanceof MediaServiceError) return e;
    if (e instanceof StorageError) {
      if (e.kind === 'too-large') return new MediaServiceError('FILE_TOO_LARGE');
      if (e.kind === 'aborted') return new MediaServiceError('UPLOAD_FAILED');
      return new MediaServiceError('STORAGE_FAILED');
    }
    if (signal?.aborted) return new MediaServiceError('UPLOAD_FAILED');
    // A client that disconnects mid-upload surfaces as a stream error.
    return new MediaServiceError('UPLOAD_FAILED');
  }

  private startProcessing(id: string, requestId: string): void {
    const { repository, storage, processor, queue, logger, limits } = this.deps;
    void queue
      .run(async () => {
        const started = this.now();
        const current = repository.get(id);
        if (!current) return; // deleted while waiting
        repository.set(markProcessing(current));
        const timeout = new AbortController();
        const timer = setTimeout(() => timeout.abort(), limits.processingTimeoutMs);
        try {
          const container = current.asset.container;
          const metadata = await storage.withLocalFile(id, async (file) => {
            const input = { ...file, container };
            const meta = await processor.extractMetadata(input, { signal: timeout.signal });
            await processor.verifyDecodable(input, { signal: timeout.signal });
            return meta;
          });
          const latest = repository.get(id);
          if (!latest) { await this.safeDelete(id); return; }
          repository.set(markReady(latest, metadata));
          logger.info('media ready', { op: 'process', requestId, mediaId: id, status: 'ready', durationMs: this.now() - started });
          this.deps.extraction?.schedule(id, requestId);
        } catch (e) {
          const code: MediaErrorCode = timeout.signal.aborted ? 'timeout' : e instanceof MediaIngestionError ? e.code : 'processing-failed';
          const latest = repository.get(id);
          if (latest) repository.set(markFailed(latest, code));
          await this.safeDelete(id); // failed media is never kept on disk
          logger.warn('media failed', { op: 'process', requestId, mediaId: id, status: 'failed', code, reason: errorName(e), durationMs: this.now() - started });
        } finally {
          clearTimeout(timer);
        }
      })
      .catch((e) => logger.error('processing job crashed', { op: 'process', mediaId: id, reason: errorName(e) }));
  }

  /** Deletion failures are logged and left for the next sweep (which also scans by file age). */
  private async safeDelete(id: string): Promise<void> {
    try {
      await this.deps.storage.delete(id);
    } catch (e) {
      this.deps.logger.error('delete failed; will retry on sweep', { op: 'delete', mediaId: id, reason: errorName(e) });
    }
  }
}

const errorName = (e: unknown) => (e instanceof Error ? e.name : 'unknown');

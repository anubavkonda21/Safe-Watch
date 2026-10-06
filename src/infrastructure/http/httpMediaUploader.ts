import type { MediaUploader, UploadHooks } from '@/application/mediaUploader';
import { API_PATHS, FILENAME_HEADER, apiErrorToMediaError, isApiErrorCode, type ExtractionResponse, type MediaResource, type MediaResponse, type TextAnalysisResponse } from '@/domain/api/contract';
import type { MediaExtraction } from '@/domain/extraction/extraction';
import type { TextAnalysis } from '@/domain/text/textAnalysis';
import { MediaIngestionError } from '@/domain/media/errors';
import { sanitizeFilename } from '@/domain/media/validation';

export interface HttpMediaUploaderOptions {
  baseUrl: string;
  pollIntervalMs?: number;
  /** Give up waiting for server-side processing after this long. */
  pollTimeoutMs?: number;
  /** Give up waiting for extraction after this long. */
  extractionTimeoutMs?: number;
}

/**
 * Uploads with XMLHttpRequest because it is the only browser API that reports
 * real upload progress. The File is sent as the raw request body (streamed
 * from disk by the browser, never read into JS memory); the filename travels
 * in a header. After the upload, polls the media resource until the server
 * reports `ready` or `failed`.
 */
export class HttpMediaUploader implements MediaUploader {
  private readonly pollIntervalMs: number;
  private readonly pollTimeoutMs: number;
  private readonly extractionTimeoutMs: number;

  constructor(private readonly options: HttpMediaUploaderOptions) {
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
    this.pollTimeoutMs = options.pollTimeoutMs ?? 120_000;
    this.extractionTimeoutMs = options.extractionTimeoutMs ?? 20 * 60_000;
  }

  async upload(file: File, hooks: UploadHooks = {}): Promise<MediaResource> {
    const created = await this.post(file, hooks);
    return this.waitUntilSettled(created, hooks.signal);
  }

  async waitForExtraction(mediaId: string, hooks: { onUpdate?: (e: MediaExtraction) => void; signal?: AbortSignal } = {}): Promise<MediaExtraction> {
    const deadline = Date.now() + this.extractionTimeoutMs;
    let lastKey = '';
    let failures = 0;
    for (;;) {
      if (hooks.signal?.aborted) throw new MediaIngestionError('upload-failed');
      try {
        const res = await fetch(`${this.options.baseUrl}${API_PATHS.extraction(mediaId)}`, { signal: hooks.signal });
        const body = parse(await res.text());
        if (!res.ok || !isExtractionResponse(body)) throw new MediaIngestionError(errorCodeFrom(body, res.status));
        failures = 0;
        const { extraction } = body;
        const key = `${extraction.status}|${extraction.phase}`;
        if (key !== lastKey) { lastKey = key; hooks.onUpdate?.(extraction); }
        if (extraction.status === 'completed' || extraction.status === 'failed') return extraction;
      } catch (e) {
        if (e instanceof MediaIngestionError) throw e;
        if (++failures >= 3) throw new MediaIngestionError('server-unreachable');
      }
      if (Date.now() > deadline) throw new MediaIngestionError('timeout');
      await new Promise((r) => setTimeout(r, this.pollIntervalMs));
    }
  }

  async waitForTextAnalysis(mediaId: string, hooks: { onUpdate?: (t: TextAnalysis) => void; signal?: AbortSignal } = {}): Promise<TextAnalysis> {
    const deadline = Date.now() + this.extractionTimeoutMs;
    const url = `${this.options.baseUrl}${API_PATHS.transcript(mediaId)}`;
    let lastKey = '';
    let failures = 0;
    for (;;) {
      if (hooks.signal?.aborted) throw new MediaIngestionError('upload-failed');
      try {
        // While waiting, ask for the slim form (no word timestamps); fetch the full one once it is final.
        const res = await fetch(`${url}?words=false`, { signal: hooks.signal });
        const body = parse(await res.text());
        if (!res.ok || !isTextAnalysisResponse(body)) throw new MediaIngestionError(errorCodeFrom(body, res.status));
        failures = 0;
        const t = body.textAnalysis;
        const key = `${t.status}|${t.phase}`;
        if (t.status === 'ready' || t.status === 'failed') {
          const full = t.status === 'ready' ? await fetch(url, { signal: hooks.signal }).then(async (r) => parse(await r.text())) : body;
          const result = isTextAnalysisResponse(full) ? full.textAnalysis : t;
          hooks.onUpdate?.(result);
          return result;
        }
        if (key !== lastKey) { lastKey = key; hooks.onUpdate?.(t); }
      } catch (e) {
        if (e instanceof MediaIngestionError) throw e;
        if (++failures >= 3) throw new MediaIngestionError('server-unreachable');
      }
      if (Date.now() > deadline) throw new MediaIngestionError('timeout');
      await new Promise((r) => setTimeout(r, this.pollIntervalMs));
    }
  }

  async remove(mediaId: string): Promise<void> {
    try {
      await fetch(`${this.options.baseUrl}${API_PATHS.media}/${encodeURIComponent(mediaId)}`, { method: 'DELETE', keepalive: true });
    } catch {
      // Best effort: the server also deletes expired media by itself.
    }
  }

  private post(file: File, hooks: UploadHooks): Promise<MediaResource> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      let lastFraction = 0;
      xhr.open('POST', `${this.options.baseUrl}${API_PATHS.media}`);
      xhr.setRequestHeader(FILENAME_HEADER, encodeURIComponent(sanitizeFilename(file.name)));
      if (file.type) xhr.setRequestHeader('content-type', file.type);

      xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable || e.total === 0) return;
        lastFraction = e.loaded / e.total;
        hooks.onProgress?.(lastFraction);
      };
      xhr.onload = () => {
        const body = parse(xhr.responseText);
        if (xhr.status === 202 && isMediaResponse(body)) {
          hooks.onProgress?.(1);
          return resolve(body.media);
        }
        reject(new MediaIngestionError(errorCodeFrom(body, xhr.status)));
      };
      // A network error before the upload completed is an interrupted upload; before any byte was sent it is an unreachable server.
      xhr.onerror = () => reject(new MediaIngestionError(lastFraction > 0 ? 'upload-failed' : 'server-unreachable'));
      xhr.ontimeout = () => reject(new MediaIngestionError('upload-failed'));
      xhr.onabort = () => reject(new MediaIngestionError('upload-failed'));
      hooks.signal?.addEventListener('abort', () => xhr.abort(), { once: true });
      xhr.send(file);
    });
  }

  private async waitUntilSettled(first: MediaResource, signal?: AbortSignal): Promise<MediaResource> {
    let current = first;
    const deadline = Date.now() + this.pollTimeoutMs;
    let failures = 0;
    while (current.asset.status !== 'ready' && current.asset.status !== 'failed') {
      if (signal?.aborted) throw new MediaIngestionError('upload-failed');
      if (Date.now() > deadline) throw new MediaIngestionError('timeout');
      await new Promise((r) => setTimeout(r, this.pollIntervalMs));
      try {
        const res = await fetch(`${this.options.baseUrl}${API_PATHS.media}/${encodeURIComponent(first.asset.id)}`, { signal });
        const body = parse(await res.text());
        if (res.ok && isMediaResponse(body)) { current = body.media; failures = 0; continue; }
        throw new MediaIngestionError(errorCodeFrom(body, res.status));
      } catch (e) {
        if (e instanceof MediaIngestionError) throw e;
        if (++failures >= 3) throw new MediaIngestionError('server-unreachable');
      }
    }
    return current;
  }
}

function parse(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}

function isExtractionResponse(v: unknown): v is ExtractionResponse {
  return typeof v === 'object' && v !== null && 'extraction' in v && typeof (v as { extraction: { status?: unknown } }).extraction?.status === 'string';
}

function isTextAnalysisResponse(v: unknown): v is TextAnalysisResponse {
  return typeof v === 'object' && v !== null && 'textAnalysis' in v && typeof (v as { textAnalysis: { status?: unknown } }).textAnalysis?.status === 'string';
}

function isMediaResponse(v: unknown): v is MediaResponse {
  if (typeof v !== 'object' || v === null || !('media' in v)) return false;
  const m = (v as { media: unknown }).media;
  return typeof m === 'object' && m !== null && 'asset' in m && 'analysis' in m;
}

/**
 * Prefers the API's structured error. Responses that did not come from the
 * API (a reverse proxy or gateway answering with HTML or nothing) are mapped
 * from the HTTP status alone.
 */
function errorCodeFrom(body: unknown, httpStatus: number) {
  const code = typeof body === 'object' && body !== null && 'error' in body ? (body as { error?: { code?: unknown } }).error?.code : undefined;
  if (isApiErrorCode(code)) return apiErrorToMediaError(code);
  if (httpStatus === 502 || httpStatus === 503 || httpStatus === 504) return 'server-unreachable';
  if (httpStatus === 413) return 'file-too-large';
  if (httpStatus === 429) return 'server-busy';
  return 'processing-failed';
}

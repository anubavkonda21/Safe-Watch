import type { MediaUploader, UploadHooks } from '@/application/mediaUploader';
import { API_PATHS, FILENAME_HEADER, apiErrorToMediaError, isApiErrorCode, type MediaResource, type MediaResponse } from '@/domain/api/contract';
import { MediaIngestionError } from '@/domain/media/errors';
import { sanitizeFilename } from '@/domain/media/validation';

export interface HttpMediaUploaderOptions {
  baseUrl: string;
  pollIntervalMs?: number;
  /** Give up waiting for server-side processing after this long. */
  pollTimeoutMs?: number;
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

  constructor(private readonly options: HttpMediaUploaderOptions) {
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
    this.pollTimeoutMs = options.pollTimeoutMs ?? 120_000;
  }

  async upload(file: File, hooks: UploadHooks = {}): Promise<MediaResource> {
    const created = await this.post(file, hooks);
    return this.waitUntilSettled(created, hooks.signal);
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

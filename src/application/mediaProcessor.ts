import type { MediaMetadata } from '@/domain/media/asset';

export interface ProcessOptions {
  /** Aborts the operation (used for timeouts). Adapters that cannot be aborted may ignore it. */
  signal?: AbortSignal;
}

/**
 * Port: everything that inspects or transforms media content. Callers depend
 * only on this interface, never on FFmpeg, the file system, a server or the
 * browser. `TSource` is whatever handle the adapter understands: a browser
 * `File`, or a server-side local file.
 *
 * Adapters:
 *  - BrowserMediaProcessor (client, TSource = File): duration/dimensions via <video>.
 *  - FfmpegMediaProcessor (server): full stream metadata via FFprobe.
 *
 * Contract: resolve with `availability: 'unavailable'` when details cannot be
 * read for an otherwise valid file; reject only for genuine processing failures.
 */
export interface MediaProcessor<TSource = File> {
  extractMetadata(source: TSource, options?: ProcessOptions): Promise<MediaMetadata>;
}

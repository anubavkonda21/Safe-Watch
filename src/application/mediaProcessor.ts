import type { MediaMetadata } from '@/domain/media/asset';

/**
 * Port: everything that inspects or transforms media content. The UI and the
 * ingestion service depend only on this interface, never on FFmpeg, the file
 * system, a server or the browser.
 *
 * Adapters:
 *  - BrowserMediaProcessor (Checkpoint 1): duration/dimensions via <video>.
 *  - FfprobeMediaProcessor (planned, server): full stream metadata.
 * Later additions (audio/subtitle/frame extraction) extend this port.
 *
 * Contract: resolve with `availability: 'unavailable'` when details cannot be
 * read for an otherwise valid file; reject only for genuine processing failures.
 */
export interface MediaProcessor {
  extractMetadata(file: File): Promise<MediaMetadata>;
}

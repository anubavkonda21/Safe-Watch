import type { MediaResource } from '@/domain/api/contract';
import type { MediaExtraction } from '@/domain/extraction/extraction';

export interface UploadHooks {
  /** Real measured upload progress, 0–1. Not called when the transport cannot measure it. */
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

/**
 * Port: sends a file to the SafeWatch server and resolves when the server has
 * finished inspecting it (media `ready`). Rejects with a typed
 * MediaIngestionError otherwise. Adapter: HttpMediaUploader.
 */
export interface MediaUploader {
  upload(file: File, hooks?: UploadHooks): Promise<MediaResource>;
  /**
   * Follows the server-side extraction of a ready media item until it is
   * `completed` or `failed`, reporting each status/phase change. Phase-based:
   * no percentages. Rejects with a typed MediaIngestionError if the server
   * cannot be reached or the wait times out.
   */
  waitForExtraction(mediaId: string, hooks?: { onUpdate?: (extraction: MediaExtraction) => void; signal?: AbortSignal }): Promise<MediaExtraction>;
  /** Best-effort deletion of a stored upload. Never rejects. */
  remove(mediaId: string): Promise<void>;
}

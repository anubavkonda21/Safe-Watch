import type { MediaResource } from '@/domain/api/contract';

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
  /** Best-effort deletion of a stored upload. Never rejects. */
  remove(mediaId: string): Promise<void>;
}

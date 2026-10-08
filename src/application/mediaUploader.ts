import type { MediaResource } from '@/domain/api/contract';
import type { MediaExtraction } from '@/domain/extraction/extraction';
import type { TextAnalysis } from '@/domain/text/textAnalysis';
import type { VisualAnalysis } from '@/domain/vision/visualAnalysis';

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
  /**
   * Follows server-side text analysis (speech transcript + subtitle timeline) until it is `ready` or `failed`,
   * reporting each status/phase change, and resolves with the full result including word timestamps.
   * Evidence only: this is not a safety analysis.
   */
  waitForTextAnalysis(mediaId: string, hooks?: { onUpdate?: (textAnalysis: TextAnalysis) => void; signal?: AbortSignal }): Promise<TextAnalysis>;
  /**
   * Follows server-side visual analysis (frame observations) until it is `ready` or `failed`, reporting each
   * status/progress change, and resolves with the full result. Evidence only: this is not a safety analysis.
   * Optional: an uploader without it simply has no visual evidence.
   */
  waitForVisualAnalysis?(mediaId: string, hooks?: { onUpdate?: (visual: VisualAnalysis) => void; signal?: AbortSignal }): Promise<VisualAnalysis>;
  /** Best-effort deletion of a stored upload. Never rejects. */
  remove(mediaId: string): Promise<void>;
}

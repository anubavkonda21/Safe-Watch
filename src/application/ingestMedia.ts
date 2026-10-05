import {
  sanitizeFilename,
  validateVideoFile,
  type FileLike,
  type SelectedVideo,
  type UploadRejection,
  type VideoMetadata,
} from '@/domain/media/upload';

/**
 * Port: how the application reads technical metadata from a video.
 * Checkpoint 0A ships a browser adapter; Checkpoint 1 will add a server-side
 * media pipeline behind the same boundary.
 */
export interface MetadataReader {
  read(file: File): Promise<VideoMetadata>;
}

export type IngestResult =
  | { ok: true; video: SelectedVideo }
  | { ok: false; reason: UploadRejection | 'unreadable' };

export async function ingestMedia(
  file: File & FileLike,
  deps: { reader: MetadataReader; maxBytes: number },
): Promise<IngestResult> {
  const validation = validateVideoFile(file, deps.maxBytes);
  if (!validation.ok) return validation;
  try {
    const metadata = await deps.reader.read(file);
    return { ok: true, video: { name: sanitizeFilename(file.name), sizeBytes: file.size, metadata } };
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
}

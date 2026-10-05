/**
 * Domain rules for accepting a video. Pure functions, no browser or framework
 * dependencies, so the same rules can later be reused by a server.
 */

export const ACCEPTED_VIDEO_EXTENSIONS = ['mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi'] as const;

/** MIME types browsers commonly report. MKV/AVI are often reported as empty. */
const ACCEPTED_MIME_PREFIXES = ['video/', 'application/x-matroska'];

export type UploadRejection = 'unsupported-type' | 'empty-file' | 'too-large';

export type ValidationResult =
  | { ok: true }
  | { ok: false; reason: UploadRejection };

export interface FileLike {
  name: string;
  size: number;
  type: string;
}

export function getExtension(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot < 0 ? '' : filename.slice(dot + 1).toLowerCase();
}

export function validateVideoFile(file: FileLike, maxBytes: number): ValidationResult {
  const extensionOk = (ACCEPTED_VIDEO_EXTENSIONS as readonly string[]).includes(getExtension(file.name));
  const mimeOk = file.type === '' || ACCEPTED_MIME_PREFIXES.some((p) => file.type.startsWith(p));
  if (!extensionOk || !mimeOk) return { ok: false, reason: 'unsupported-type' };
  if (file.size === 0) return { ok: false, reason: 'empty-file' };
  if (file.size > maxBytes) return { ok: false, reason: 'too-large' };
  return { ok: true };
}

/**
 * Makes a user-controlled filename safe for display and for any future use as
 * a storage key: strips path segments, control/bidi characters and anything
 * outside a conservative allowlist, and caps the length.
 */
export function sanitizeFilename(raw: string, maxLength = 120): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  const cleaned = base
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}._ -]/gu, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.\s]+/, '')
    .trim();
  if (!cleaned) return 'video';
  if (cleaned.length <= maxLength) return cleaned;
  const ext = getExtension(cleaned);
  const keep = ext ? maxLength - ext.length - 1 : maxLength;
  return ext ? `${cleaned.slice(0, keep)}.${ext}` : cleaned.slice(0, keep);
}

export interface VideoMetadata {
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
}

export interface SelectedVideo {
  /** Sanitised display name. The original name is never used for storage. */
  name: string;
  sizeBytes: number;
  metadata: VideoMetadata;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`;
}

export function formatDuration(totalSeconds: number): string {
  const s = Math.round(totalSeconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

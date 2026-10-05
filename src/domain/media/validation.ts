import type { ContainerFormat } from './container';
import type { MediaErrorCode } from './errors';

/** Single source of truth for accepted formats. Extension → containers its bytes may legitimately have. */
export const EXTENSION_CONTAINERS = {
  mp4: ['mp4', 'quicktime'],
  m4v: ['mp4', 'quicktime'],
  mov: ['quicktime', 'mp4'],
  mkv: ['matroska', 'webm'],
  webm: ['webm', 'matroska'],
  avi: ['avi'],
} as const satisfies Record<string, readonly ContainerFormat[]>;

export const ACCEPTED_VIDEO_EXTENSIONS = Object.keys(EXTENSION_CONTAINERS) as Array<keyof typeof EXTENSION_CONTAINERS>;

/**
 * MIME types browsers report for these files. The empty string is allowed
 * because browsers often report nothing for MKV/AVI; content sniffing covers that case.
 */
export const ACCEPTED_MIME_TYPES: readonly string[] = [
  'video/mp4',
  'video/quicktime',
  'video/x-m4v',
  'video/x-matroska',
  'application/x-matroska',
  'video/webm',
  'video/x-msvideo',
  'video/avi',
  'video/msvideo',
  '',
];

export interface FileLike {
  name: string;
  size: number;
  type: string;
}

export type ValidationResult = { ok: true } | { ok: false; code: MediaErrorCode };

export function getExtension(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot < 0 ? '' : filename.slice(dot + 1).toLowerCase();
}

/** Metadata-level checks only (name, declared MIME, size). Content is checked separately via sniffing. */
export function validateMediaFile(file: FileLike, maxBytes: number): ValidationResult {
  const extensionOk = Object.hasOwn(EXTENSION_CONTAINERS, getExtension(file.name));
  const mimeOk = ACCEPTED_MIME_TYPES.includes(file.type.toLowerCase());
  if (!extensionOk || !mimeOk) return { ok: false, code: 'unsupported-type' };
  if (file.size === 0) return { ok: false, code: 'empty-file' };
  if (file.size > maxBytes) return { ok: false, code: 'file-too-large' };
  return { ok: true };
}

/** True when the sniffed container is plausible for the file's extension. */
export function containerMatchesExtension(filename: string, container: ContainerFormat | null): boolean {
  if (!container) return false;
  const allowed = EXTENSION_CONTAINERS[getExtension(filename) as keyof typeof EXTENSION_CONTAINERS] as
    | readonly ContainerFormat[]
    | undefined;
  return allowed?.includes(container) ?? false;
}

/**
 * Makes a user-controlled filename safe for display and for any future use
 * as a label: strips path segments, control/bidi/zero-width characters and
 * anything outside a conservative allowlist, and caps the length.
 * It is never used to build storage paths (storage uses generated ids).
 */
export function sanitizeFilename(raw: string, maxLength = 120): string {
  // Normalise first so fullwidth separators/dots become real ones and are then stripped.
  const base = raw.normalize('NFKC').split(/[\\/]/).pop() ?? '';
  const cleaned = base
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

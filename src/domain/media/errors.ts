/**
 * Typed failure causes for media ingestion. The presentation layer maps each
 * code to user-facing "what / why / how to fix" copy; internals never leak.
 *
 * `timeout`, `storage-failure`, `upload-failed`, `server-busy` and
 * `server-unreachable` come from the server pipeline (Checkpoint 2); the
 * browser-only adapter degrades to "metadata unavailable" instead of failing
 * on timeouts.
 */
export const MEDIA_ERROR_CODES = [
  'unsupported-type',
  'file-too-large',
  'empty-file',
  'invalid-media',
  'processing-failed',
  'timeout',
  'storage-failure',
  'upload-failed',
  'server-busy',
  'server-unreachable',
] as const;

export type MediaErrorCode = (typeof MEDIA_ERROR_CODES)[number];

export class MediaIngestionError extends Error {
  readonly code: MediaErrorCode;

  constructor(code: MediaErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'MediaIngestionError';
    this.code = code;
  }
}

/** Plain, serialisable form kept in state. */
export interface MediaFailure {
  code: MediaErrorCode;
}

export function toFailure(error: unknown): MediaFailure {
  return error instanceof MediaIngestionError ? { code: error.code } : { code: 'processing-failed' };
}

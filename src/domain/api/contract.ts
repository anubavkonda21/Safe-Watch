import type { AnalysisState } from '../analysis/job';
import type { MediaAsset } from '../media/asset';
import type { MediaErrorCode } from '../media/errors';

/**
 * The HTTP contract shared by the browser and the server. Raw FFprobe output
 * never crosses it: only normalised MediaAsset data does.
 */
export const API_PATHS = {
  health: '/api/health',
  media: '/api/media',
} as const;

/** Original filename travels in a header (URI-encoded), never in the URL or as a path. */
export const FILENAME_HEADER = 'x-safewatch-filename';

export const API_ERROR_CODES = [
  'INVALID_FILE',
  'UNSUPPORTED_MEDIA',
  'FILE_TOO_LARGE',
  'UPLOAD_FAILED',
  'MEDIA_PROCESSING_FAILED',
  'MEDIA_METADATA_FAILED',
  'STORAGE_FAILED',
  'PROCESSING_TIMEOUT',
  'SERVER_BUSY',
  'NOT_FOUND',
  'INTERNAL_ERROR',
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export interface ApiErrorBody {
  error: { code: ApiErrorCode; message: string; requestId: string };
}

export interface MediaResource {
  asset: MediaAsset;
  analysis: AnalysisState;
}

export interface MediaResponse {
  media: MediaResource;
}

export interface HealthResponse {
  status: 'ok' | 'degraded';
  service: 'safewatch-api';
  version: string;
  environment: string;
  tools: { ffmpeg: boolean; ffprobe: boolean };
}

export function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return typeof value === 'string' && (API_ERROR_CODES as readonly string[]).includes(value);
}

const API_TO_MEDIA: Record<ApiErrorCode, MediaErrorCode> = {
  INVALID_FILE: 'invalid-media',
  UNSUPPORTED_MEDIA: 'unsupported-type',
  FILE_TOO_LARGE: 'file-too-large',
  UPLOAD_FAILED: 'upload-failed',
  MEDIA_PROCESSING_FAILED: 'processing-failed',
  MEDIA_METADATA_FAILED: 'invalid-media',
  STORAGE_FAILED: 'storage-failure',
  PROCESSING_TIMEOUT: 'timeout',
  SERVER_BUSY: 'server-busy',
  NOT_FOUND: 'processing-failed',
  INTERNAL_ERROR: 'processing-failed',
};

export const apiErrorToMediaError = (code: ApiErrorCode): MediaErrorCode => API_TO_MEDIA[code];

const MEDIA_TO_API: Record<MediaErrorCode, ApiErrorCode> = {
  'unsupported-type': 'UNSUPPORTED_MEDIA',
  'file-too-large': 'FILE_TOO_LARGE',
  'empty-file': 'INVALID_FILE',
  'invalid-media': 'MEDIA_METADATA_FAILED',
  'processing-failed': 'MEDIA_PROCESSING_FAILED',
  timeout: 'PROCESSING_TIMEOUT',
  'storage-failure': 'STORAGE_FAILED',
  'upload-failed': 'UPLOAD_FAILED',
  'server-busy': 'SERVER_BUSY',
  'server-unreachable': 'INTERNAL_ERROR',
};

export const mediaErrorToApiError = (code: MediaErrorCode): ApiErrorCode => MEDIA_TO_API[code];

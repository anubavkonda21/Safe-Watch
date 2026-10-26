import type { ApiErrorBody, ApiErrorCode } from '@/domain/api/contract';

export const STATUS_FOR: Record<ApiErrorCode, number> = {
  INVALID_FILE: 400,
  UNSUPPORTED_MEDIA: 415,
  FILE_TOO_LARGE: 413,
  UPLOAD_FAILED: 400,
  MEDIA_PROCESSING_FAILED: 500,
  MEDIA_METADATA_FAILED: 422,
  STORAGE_FAILED: 500,
  PROCESSING_TIMEOUT: 504,
  SERVER_BUSY: 503,
  INVALID_REQUEST: 400,
  NOT_FOUND: 404,
  UNAUTHENTICATED: 401,
  RATE_LIMITED: 429,
  QUOTA_EXCEEDED: 507,
  INTERNAL_ERROR: 500,
};

/** Fixed, safe, user-presentable messages. Internal detail never appears here. */
export const MESSAGE_FOR: Record<ApiErrorCode, string> = {
  INVALID_FILE: 'The file is missing, empty or could not be read.',
  UNSUPPORTED_MEDIA: 'This file type is not supported.',
  FILE_TOO_LARGE: 'The file exceeds the maximum upload size.',
  UPLOAD_FAILED: 'The upload did not complete.',
  MEDIA_PROCESSING_FAILED: 'The media could not be processed.',
  MEDIA_METADATA_FAILED: 'The file does not contain readable video.',
  STORAGE_FAILED: 'The file could not be stored.',
  PROCESSING_TIMEOUT: 'Processing took too long.',
  SERVER_BUSY: 'The server is busy. Try again shortly.',
  INVALID_REQUEST: 'The request is not valid.',
  NOT_FOUND: 'Not found.',
  UNAUTHENTICATED: 'No valid session. Upload a file to start one.',
  RATE_LIMITED: 'Too many requests. Slow down and try again shortly.',
  QUOTA_EXCEEDED: 'SafeWatch has no room for this file right now. Remove media or try later.',
  INTERNAL_ERROR: 'Something went wrong on the server.',
};

export const errorBody = (code: ApiErrorCode, requestId: string): ApiErrorBody => ({
  error: { code, message: MESSAGE_FOR[code], requestId },
});

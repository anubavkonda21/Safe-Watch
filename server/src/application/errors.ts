import type { ApiErrorCode } from '@/domain/api/contract';

/** Failure of a server use case, already classified for the API. Messages are safe to show. */
export class MediaServiceError extends Error {
  readonly code: ApiErrorCode;
  constructor(code: ApiErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'MediaServiceError';
    this.code = code;
  }
}

import type { ExtractionErrorCode } from '@/domain/extraction/extraction';

/** Failure of one extraction operation, classified. Never carries tool output. */
export class ExtractionError extends Error {
  readonly code: ExtractionErrorCode;
  constructor(code: ExtractionErrorCode) {
    super(code);
    this.name = 'ExtractionError';
    this.code = code;
  }
}

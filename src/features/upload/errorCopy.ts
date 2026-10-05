import { formatBytes } from '@/domain/media/format';
import { ACCEPTED_VIDEO_EXTENSIONS } from '@/domain/media/validation';
import type { MediaErrorCode } from '@/domain/media/errors';

export interface ErrorCopy {
  /** What failed. */
  title: string;
  /** Why it failed, and how to fix it. */
  body: string;
}

const formats = ACCEPTED_VIDEO_EXTENSIONS.map((e) => e.toUpperCase()).join(', ');

/** User-facing copy for every typed failure. Never includes internal details. */
export function errorCopy(code: MediaErrorCode, maxBytes: number): ErrorCopy {
  switch (code) {
    case 'unsupported-type':
      return { title: 'This file type is not supported', body: `SafeWatch accepts ${formats} videos. Choose a video in one of these formats.` };
    case 'file-too-large':
      return { title: 'This file is too large', body: `The limit is ${formatBytes(maxBytes)}. Choose a smaller file or trim the video first.` };
    case 'empty-file':
      return { title: 'This file is empty', body: 'It contains no data. Choose the original video file.' };
    case 'invalid-media':
      return { title: 'This does not look like a valid video', body: 'Its contents do not match its file extension, so it may be damaged or renamed. Download or export it again, or choose another file.' };
    case 'timeout':
      return { title: 'Preparing took too long', body: 'The video could not be prepared in time. Try again, or choose a smaller file.' };
    case 'storage-failure':
      return { title: 'We could not store this video', body: 'Saving the file failed. Try again in a moment.' };
    case 'processing-failed':
      return { title: 'We could not prepare this video', body: 'Reading the file failed unexpectedly. It may have been moved or removed. Choose the file again.' };
  }
}

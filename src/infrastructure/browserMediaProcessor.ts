import type { MediaProcessor } from '@/application/mediaProcessor';
import { normalizeMetadata } from '@/domain/media/metadata';

export const METADATA_TIMEOUT_MS = 4000;

/**
 * Reads duration and dimensions locally through a detached <video> element
 * pointed at an object URL: the browser streams from the File, nothing is
 * copied into JS memory, nothing leaves the device. The URL is always revoked.
 *
 * Browsers cannot decode every container/codec (MKV, AVI, HEVC are common
 * misses). That is reported as `unavailable` metadata, never as an invalid file.
 */
export const browserMediaProcessor: MediaProcessor = {
  extractMetadata(file) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const video = document.createElement('video');
      let settled = false;

      const finish = (result: ReturnType<typeof normalizeMetadata>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        video.onloadedmetadata = null;
        video.onerror = null;
        video.removeAttribute('src');
        video.load();
        URL.revokeObjectURL(url);
        resolve(result);
      };

      const timer = setTimeout(() => finish(normalizeMetadata({}, 'browser', 'timeout')), METADATA_TIMEOUT_MS);

      video.preload = 'metadata';
      video.muted = true;
      video.onloadedmetadata = () =>
        finish(normalizeMetadata({ durationSeconds: video.duration, width: video.videoWidth, height: video.videoHeight }, 'browser'));
      video.onerror = () => finish(normalizeMetadata({}, 'browser', 'unsupported-by-browser'));
      video.src = url;
    });
  },
};

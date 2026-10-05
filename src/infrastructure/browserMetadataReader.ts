import type { MetadataReader } from '@/application/ingestMedia';

const TIMEOUT_MS = 4000;

/**
 * Reads duration and dimensions locally using a detached <video> element.
 * Nothing leaves the device. If the browser cannot decode the container
 * (common for MKV/AVI) metadata is reported as unknown rather than failing.
 */
export const browserMetadataReader: MetadataReader = {
  read(file) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const video = document.createElement('video');
      let settled = false;
      const finish = (meta: { d: number | null; w: number | null; h: number | null }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        video.removeAttribute('src');
        video.load();
        URL.revokeObjectURL(url);
        resolve({ durationSeconds: meta.d, width: meta.w, height: meta.h });
      };
      const timer = setTimeout(() => finish({ d: null, w: null, h: null }), TIMEOUT_MS);
      video.preload = 'metadata';
      video.muted = true;
      video.onloadedmetadata = () =>
        finish({
          d: Number.isFinite(video.duration) ? video.duration : null,
          w: video.videoWidth || null,
          h: video.videoHeight || null,
        });
      video.onerror = () => finish({ d: null, w: null, h: null });
      video.src = url;
    });
  },
};

import { createMediaIngestion } from '@/application/mediaIngestion';
import { browserMediaProcessor } from './browserMediaProcessor';
import { config } from './config/env';
import { HttpMediaUploader } from './http/httpMediaUploader';

/** Composition root for the default ingestion pipeline: server upload, or browser-only when configured. */
export const defaultMediaIngestion = createMediaIngestion(
  config.mediaBackend === 'browser'
    ? { processor: browserMediaProcessor, maxBytes: config.maxUploadBytes }
    : { uploader: new HttpMediaUploader({ baseUrl: config.apiBaseUrl }), maxBytes: config.maxUploadBytes },
);

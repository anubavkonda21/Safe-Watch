import { createMediaIngestion } from '@/application/mediaIngestion';
import { browserMediaProcessor } from './browserMediaProcessor';
import { config } from './config/env';

/** Composition root for the default (browser) ingestion pipeline. */
export const defaultMediaIngestion = createMediaIngestion({
  processor: browserMediaProcessor,
  maxBytes: config.maxUploadBytes,
});

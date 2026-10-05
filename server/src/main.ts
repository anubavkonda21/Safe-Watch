import { parseServerConfig } from './config';
import { MediaService } from './application/mediaService';
import { ProcessingQueue } from './application/processingQueue';
import { createApiServer } from './api/server';
import { FfmpegMediaProcessor } from './infrastructure/ffmpeg/ffmpegMediaProcessor';
import { InMemoryMediaRepository } from './infrastructure/inMemoryMediaRepository';
import { createJsonLogger } from './infrastructure/jsonLogger';
import { LocalDiskMediaStorage } from './infrastructure/storage/localDiskMediaStorage';

const started = Date.now();
const config = parseServerConfig(process.env);
const logger = createJsonLogger(config.logLevel);

const tools = await FfmpegMediaProcessor.checkTools(config);
if (!tools.ffmpeg || !tools.ffprobe) {
  logger.error('FFmpeg/FFprobe not found', { op: 'startup', tools });
  console.error(
    'SafeWatch needs FFmpeg and FFprobe. Install them (macOS: "brew install ffmpeg"; Debian/Ubuntu: "apt install ffmpeg")\n' +
      'or set SAFEWATCH_FFMPEG_PATH and SAFEWATCH_FFPROBE_PATH.',
  );
  process.exit(1);
}

const version = process.env.npm_package_version ?? 'unknown'; // set by npm when started through an npm script
const storage = new LocalDiskMediaStorage(config.storageDir);
const mediaService = new MediaService({
  storage,
  repository: new InMemoryMediaRepository(),
  processor: new FfmpegMediaProcessor(config),
  queue: new ProcessingQueue(config.maxConcurrentProcessing, config.maxQueuedProcessing),
  logger,
  limits: config,
});
await mediaService.start();

const server = createApiServer({
  mediaService,
  logger,
  limits: config,
  allowedOrigins: config.allowedOrigins,
  health: { version, environment: config.environment, tools },
});

const sweeper = setInterval(() => { void mediaService.sweep(); }, config.sweepIntervalMs);
sweeper.unref();

server.listen(config.port, config.host, () => {
  logger.info('server listening', { op: 'startup', host: config.host, port: config.port, environment: config.environment, startupMs: Date.now() - started });
});

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  logger.info('shutting down', { op: 'shutdown', signal });
  clearInterval(sweeper);
  server.close();
  server.closeIdleConnections();
  setTimeout(() => server.closeAllConnections(), 5000).unref();
  try { await storage.purge(); } catch { /* best effort; next startup purges again */ }
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

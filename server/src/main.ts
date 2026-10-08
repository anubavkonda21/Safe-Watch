import { parseServerConfig } from './config';
import { MediaExtractionService } from './application/extractionService';
import { MediaService } from './application/mediaService';
import { TextAnalysisService, limitsFromConfig } from './application/textAnalysisService';
import { VisualAnalysisService, limitsFromVisionConfig } from './application/visualAnalysisService';
import { AppleVisionProvider } from './infrastructure/vision/appleVisionProvider';
import { ProcessingQueue } from './application/processingQueue';
import { createApiServer } from './api/server';
import { FfmpegMediaExtractor } from './infrastructure/ffmpeg/ffmpegMediaExtractor';
import { FfmpegMediaProcessor } from './infrastructure/ffmpeg/ffmpegMediaProcessor';
import { WhisperCppProvider } from './infrastructure/speech/whisperCppProvider';
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
const repository = new InMemoryMediaRepository();
const { extraction: ex, speech: sp, vision: vs } = config;
const speechProvider = sp.provider === 'whispercpp' && sp.modelPath
  ? new WhisperCppProvider({ binaryPath: sp.binaryPath, modelPath: sp.modelPath, modelName: sp.modelName, threads: sp.threads })
  : null;
const speechAvailable = speechProvider ? await speechProvider.isAvailable() : false;
if (speechProvider) {
  const swept = await speechProvider.cleanupStale();
  if (swept > 0) logger.info('removed stale speech temp directories', { op: 'startup-cleanup', removed: swept });
}
if (speechProvider && !speechAvailable) logger.warn('speech-to-text unavailable: binary or model not found; only subtitle evidence will be collected', { op: 'startup', provider: sp.provider });
const textAnalysis = new TextAnalysisService({
  storage, repository, speech: speechProvider, queue: new ProcessingQueue(sp.maxConcurrent, sp.maxQueued), logger, limits: limitsFromConfig(sp),
});
const visionProvider = vs.provider === 'apple-vision' ? new AppleVisionProvider({ binaryPath: vs.binaryPath }) : null;
const visionAvailable = visionProvider ? await visionProvider.isAvailable() : false;
if (visionProvider && !visionAvailable) logger.warn('visual analysis unavailable: helper binary not found or not runnable (build it with scripts/build-vision-helper.sh)', { op: 'startup', provider: vs.provider });
const visualAnalysis = new VisualAnalysisService({
  storage, repository, provider: visionAvailable ? visionProvider : null, queue: new ProcessingQueue(vs.maxConcurrent, vs.maxQueued), logger, limits: limitsFromVisionConfig(vs),
});
const extraction = new MediaExtractionService({
  storage,
  repository,
  extractor: new FfmpegMediaExtractor(config),
  queue: new ProcessingQueue(ex.maxConcurrent, ex.maxQueued),
  logger,
  onCompleted: (id, requestId) => { textAnalysis.schedule(id, requestId); if (vs.provider !== 'none') visualAnalysis.schedule(id, requestId); },
  limits: { timeoutMs: ex.timeoutMs, frame: ex.frame, maxFrameBytes: ex.maxFrameBytes, maxAudioBytes: ex.maxAudioBytes, maxAudioTracks: ex.maxAudioTracks, maxCues: ex.maxCues, maxSubtitleBytes: ex.maxSubtitleBytes },
});
const mediaService = new MediaService({
  storage,
  repository,
  processor: new FfmpegMediaProcessor(config),
  queue: new ProcessingQueue(config.maxConcurrentProcessing, config.maxQueuedProcessing),
  extraction,
  textAnalysis,
  visualAnalysis,
  logger,
  limits: config,
});
await mediaService.start();

const server = createApiServer({
  mediaService,
  logger,
  limits: config,
  allowedOrigins: config.allowedOrigins,
  health: { version, environment: config.environment, tools, speech: { provider: sp.provider, available: speechAvailable }, vision: { provider: vs.provider, available: visionAvailable } },
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

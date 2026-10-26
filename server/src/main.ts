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
import { configureKillGrace, configureSandbox, currentSandbox, probeSeatbelt, terminateAllProcesses } from './infrastructure/ffmpeg/processRunner';
import { StorageQuota } from './application/storageQuota';
import { SessionStore } from './api/sessions';

const started = Date.now();
let config: ReturnType<typeof parseServerConfig>;
try {
  config = parseServerConfig(process.env);
} catch (e) {
  // A configuration mistake is reported as one clear line, not a stack trace.
  console.error(`SafeWatch cannot start: ${e instanceof Error ? e.message : 'invalid configuration'}`);
  process.exit(1);
}
const logger = createJsonLogger(config.logLevel);

// OS sandbox for FFmpeg, FFprobe, whisper.cpp and the Vision helper (macOS Seatbelt). Probed for real, not assumed from the platform.
const seatbelt = config.sandbox === 'none' ? false : await probeSeatbelt();
if (config.sandbox === 'seatbelt' && !seatbelt) { logger.error('sandbox requested but unavailable', { op: 'startup' }); console.error('SAFEWATCH_SANDBOX=seatbelt, but the macOS sandbox cannot be applied here.'); process.exit(1); }
if (config.requireSandbox && !seatbelt) { logger.error('sandbox required but unavailable', { op: 'startup' }); console.error('A process sandbox is required (SAFEWATCH_REQUIRE_SANDBOX) but none is available on this platform. See the security documentation.'); process.exit(1); }
configureSandbox(seatbelt ? 'seatbelt' : 'none');
configureKillGrace(Math.min(config.shutdownGraceMs, 2000));
if (!seatbelt) logger.warn('child processes are NOT sandboxed (no OS sandbox available); they still run with a minimal environment, argv only, file-only protocols, timeouts and output caps', { op: 'startup' });

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
const quota = new StorageQuota({ totalBytes: config.quota.totalBytes, perOwnerBytes: config.quota.perSessionBytes, maxMediaPerOwner: config.quota.maxMediaPerSession });
const sessions = new SessionStore({ ttlMs: config.security.sessionTtlMs, maxSessions: config.security.maxSessions });
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
  quota,
  onCompleted: (id, requestId) => { textAnalysis.schedule(id, requestId); if (vs.provider !== 'none') visualAnalysis.schedule(id, requestId); },
  limits: { timeoutMs: ex.timeoutMs, frame: ex.frame, maxFrameBytes: ex.maxFrameBytes, maxAudioBytes: ex.maxAudioBytes, maxAudioTracks: ex.maxAudioTracks, maxCues: ex.maxCues, maxSubtitleBytes: ex.maxSubtitleBytes },
});
const mediaService = new MediaService({
  storage,
  quota,
  repository,
  processor: new FfmpegMediaProcessor(config),
  queue: new ProcessingQueue(config.maxConcurrentProcessing, config.maxQueuedProcessing),
  extraction,
  textAnalysis,
  visualAnalysis,
  context: config.context,
  logger,
  limits: config,
});
await mediaService.start();

const server = createApiServer({
  mediaService,
  logger,
  limits: config,
  allowedOrigins: config.allowedOrigins,
  security: config.security,
  rate: config.rate,
  sessions,
  health: { version, environment: config.environment, tools, speech: { provider: sp.provider, available: speechAvailable }, vision: { provider: vs.provider, available: visionAvailable } },
});

const sweeper = setInterval(() => { void mediaService.deleteOwners(sessions.prune()).then(() => mediaService.sweep()); }, config.sweepIntervalMs);
sweeper.unref();

server.listen(config.port, config.host, () => {
  logger.info('server listening', { op: 'startup', host: config.host, port: config.port, environment: config.environment, sandbox: currentSandbox(), startupMs: Date.now() - started });
});

/**
 * Shutdown policy: stop accepting connections, cancel running jobs, stop every child process (SIGTERM to its process
 * group, SIGKILL after a grace period), delete all stored media, then exit. Nothing is drained: media is temporary
 * and its in-memory records are lost on exit anyway. A second signal during shutdown is ignored; if cleanup stalls the
 * process exits after the configured grace period (the next start purges whatever is left).
 */
let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  logger.info('shutting down', { op: 'shutdown', signal });
  clearInterval(sweeper);
  setTimeout(() => { logger.error('shutdown timed out', { op: 'shutdown' }); process.exit(1); }, config.shutdownGraceMs + 10_000).unref();
  server.close();
  server.closeIdleConnections();
  setTimeout(() => server.closeAllConnections(), 2000).unref();
  mediaService.shutdown();
  const stopped = await terminateAllProcesses(config.shutdownGraceMs).catch(() => 0);
  try { await storage.purge(); } catch { /* best effort; next startup purges again */ }
  logger.info('shutdown complete', { op: 'shutdown', childProcessesStopped: stopped });
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (e) => logger.error('unhandled rejection', { op: 'process', reason: e instanceof Error ? e.name : 'unknown' }));

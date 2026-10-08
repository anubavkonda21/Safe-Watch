/**
 * Manual measurement of the REAL visual path (not part of the test suite).
 * Uploads each video to an in-process SafeWatch server that uses real FFmpeg,
 * real storage and the real Apple Vision helper, waits for visual analysis, and prints
 * frame counts, provider time per frame, end-to-end time, memory, payload sizes and observation counts.
 *
 *   scripts/build-vision-helper.sh
 *   npm run check:vision -- video.mp4 [more...]
 *
 * Optional env (same names as the server): SAFEWATCH_FRAME_INTERVAL_SECONDS, SAFEWATCH_FRAME_MAX_COUNT,
 * SAFEWATCH_VISION_BATCH_SIZE, SAFEWATCH_VISION_BINARY, ...
 * Memory is sampled every 100 ms: this process (heap, RSS) and the safewatch-vision child process (RSS).
 * Note: the first analysis after a reboot compiles Apple's models (about 30 s); run a video twice to see warm numbers.
 */
import { execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import type { VisualAnalysis } from '@/domain/vision/visualAnalysis';
import { createApiServer } from '../server/src/api/server';
import { MediaExtractionService } from '../server/src/application/extractionService';
import { MediaService } from '../server/src/application/mediaService';
import { ProcessingQueue } from '../server/src/application/processingQueue';
import { VisualAnalysisService, limitsFromVisionConfig } from '../server/src/application/visualAnalysisService';
import { parseServerConfig } from '../server/src/config';
import { FfmpegMediaExtractor } from '../server/src/infrastructure/ffmpeg/ffmpegMediaExtractor';
import { FfmpegMediaProcessor } from '../server/src/infrastructure/ffmpeg/ffmpegMediaProcessor';
import { InMemoryMediaRepository } from '../server/src/infrastructure/inMemoryMediaRepository';
import { LocalDiskMediaStorage } from '../server/src/infrastructure/storage/localDiskMediaStorage';
import { AppleVisionProvider } from '../server/src/infrastructure/vision/appleVisionProvider';

const files = process.argv.slice(2);
if (files.length === 0) { console.error('Usage: npm run check:vision -- <video> [more...]'); process.exit(1); }

const MB = 1024 * 1024;
const config = parseServerConfig({ SAFEWATCH_VISION_PROVIDER: 'apple-vision', SAFEWATCH_VISION_TIMEOUT_MS: '600000', ...process.env, SAFEWATCH_MAX_UPLOAD_MB: '4096' });
const vs = config.vision;
const provider = new AppleVisionProvider({ binaryPath: vs.binaryPath });
if (!(await provider.isAvailable())) { console.error('safewatch-vision helper not found: run scripts/build-vision-helper.sh'); process.exit(1); }

const storageDir = await mkdtemp(join(tmpdir(), 'sw-visioncheck-'));
const logger = { debug() {}, info() {}, warn() {}, error() {} };
const storage = new LocalDiskMediaStorage(storageDir);
const repository = new InMemoryMediaRepository();
const ex = config.extraction;
const visual = new VisualAnalysisService({ storage, repository, logger, provider, queue: new ProcessingQueue(1, 10), limits: limitsFromVisionConfig(vs) });
const extraction = new MediaExtractionService({
  storage, repository, logger, extractor: new FfmpegMediaExtractor(config), queue: new ProcessingQueue(1, 10), onCompleted: (id) => visual.schedule(id),
  limits: { timeoutMs: ex.timeoutMs, frame: ex.frame, maxFrameBytes: ex.maxFrameBytes, maxAudioBytes: 4096 * MB, maxAudioTracks: ex.maxAudioTracks, maxCues: ex.maxCues, maxSubtitleBytes: ex.maxSubtitleBytes },
});
const mediaService = new MediaService({ storage, repository, logger, extraction, visualAnalysis: visual, processor: new FfmpegMediaProcessor(config), queue: new ProcessingQueue(2, 10), limits: { ...config, processingTimeoutMs: 120_000 } });
const server = createApiServer({ mediaService, logger, limits: { uploadTimeoutMs: 3_600_000 }, allowedOrigins: [], health: { version: 'check', environment: 'test', tools: { ffmpeg: true, ffprobe: true }, speech: { provider: 'none', available: false }, vision: { provider: 'apple-vision', available: true } } });
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const port = (server.address() as AddressInfo).port;
const mimeFor = (f: string) => ({ '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.webm': 'video/webm' })[extname(f).toLowerCase()] ?? 'video/mp4';

/** RSS (MB) of any running safewatch-vision process. */
function helperRss(): number {
  try {
    const rows = execFileSync('ps', ['-A', '-o', 'rss=,comm='], { encoding: 'utf8' }).split('\n');
    return rows.filter((l) => /safewatch-vision$/.test(l.trim())).reduce((n, l) => n + Number(l.trim().split(/\s+/)[0]) / 1024, 0);
  } catch { return 0; }
}
const r1 = (n: number) => Math.round(n * 10) / 10;

for (const file of files) {
  global.gc?.();
  const base = process.memoryUsage();
  const peak = { heap: 0, rss: 0, helper: 0 };
  const sampler = setInterval(() => {
    const m = process.memoryUsage();
    peak.heap = Math.max(peak.heap, m.heapUsed / MB); peak.rss = Math.max(peak.rss, m.rss / MB); peak.helper = Math.max(peak.helper, helperRss());
  }, 100);

  const size = (await stat(file)).size;
  const t0 = performance.now();
  const id = await new Promise<string>((resolve, reject) => {
    const req = request({ port, host: '127.0.0.1', method: 'POST', path: '/api/media', headers: { 'content-type': mimeFor(file), 'content-length': String(size), 'x-safewatch-filename': encodeURIComponent(basename(file)) } }, (res) => {
      let body = ''; res.on('data', (c) => { body += c; });
      res.on('end', () => (res.statusCode === 202 ? resolve(JSON.parse(body).media.asset.id) : reject(new Error(`HTTP ${res.statusCode} ${body.slice(0, 120)}`))));
    });
    req.on('error', reject);
    createReadStream(file).pipe(req);
  });

  let extractedAt = 0;
  let analysis: VisualAnalysis | undefined;
  for (;;) {
    const rec = repository.get(id);
    if (rec?.extraction.status === 'completed' && !extractedAt) extractedAt = performance.now();
    if (rec && (rec.visual.status === 'ready' || rec.visual.status === 'failed')) { analysis = rec.visual; break; }
    if (rec && rec.extraction.status === 'failed') { console.error('extraction failed'); break; }
    await new Promise((r) => setTimeout(r, 50));
  }
  const totalMs = performance.now() - t0;
  clearInterval(sampler);
  if (!analysis) continue;

  const full = await fetch(`http://127.0.0.1:${port}/api/media/${id}/visual`).then((r) => r.text());
  const slim = await fetch(`http://127.0.0.1:${port}/api/media/${id}/visual?observations=false`).then((r) => r.text());
  const analyzed = analysis.counts.analyzedFrameCount;
  const byType = (t: string) => analysis!.observations.filter((o) => o.type === t).length;
  console.log(JSON.stringify({
    file: basename(file), fileMB: r1(size / MB), status: analysis.status, issues: analysis.issues, provider: analysis.provider,
    frames: { total: analysis.frames.length, analyzed, failed: analysis.counts.failedFrameCount, skipped: analysis.counts.skippedFrameCount },
    timing: {
      providerMs: analysis.metrics?.providerMs, visualStageMs: analysis.metrics?.durationMs, batches: analysis.metrics?.batches,
      msPerFrame: analyzed ? r1((analysis.metrics?.providerMs ?? 0) / analyzed) : null,
      framesPerSecond: analysis.metrics?.providerMs ? r1(analyzed / (analysis.metrics.providerMs / 1000)) : null,
      extractionEndMs: Math.round(extractedAt - t0), endToEndMs: Math.round(totalMs),
    },
    output: {
      observations: analysis.counts.observationCount, labels: byType('classification'), objects: byType('object'), text: byType('text'),
      apiPayloadKB: { withObservations: r1(full.length / 1024), withoutObservations: r1(slim.length / 1024) },
    },
    memoryMB: { nodeHeapBaseline: r1(base.heapUsed / MB), nodeHeapPeak: r1(peak.heap), nodeRssPeak: r1(peak.rss), visionHelperRssPeak: r1(peak.helper) },
  }, null, 2));
  await mediaService.delete(id);
}

server.closeAllConnections();
server.close();
await rm(storageDir, { recursive: true, force: true });

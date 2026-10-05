/**
 * Manual resource check for extraction (not part of the test suite).
 * Uploads each given video to an in-process SafeWatch server that uses the
 * real FFmpeg adapter and real disk storage, waits for extraction, and prints
 * timings, output sizes, memory, FFmpeg process counts and cleanup time.
 *
 *   npm run check:extraction -- /path/to/video.mkv [more files...]
 *
 * Optional env: SAFEWATCH_FRAME_INTERVAL_SECONDS, SAFEWATCH_FRAME_MAX_COUNT, ...
 * (the same variables as the server). Memory is sampled every 100 ms for this
 * process (heap, RSS) and for every FFmpeg/FFprobe child process.
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { createReadStream } from 'node:fs';
import type { MediaExtraction } from '@/domain/extraction/extraction';
import { parseServerConfig } from '../server/src/config';
import { createApiServer } from '../server/src/api/server';
import { MediaExtractionService } from '../server/src/application/extractionService';
import { MediaService } from '../server/src/application/mediaService';
import { ProcessingQueue } from '../server/src/application/processingQueue';
import { FfmpegMediaExtractor } from '../server/src/infrastructure/ffmpeg/ffmpegMediaExtractor';
import { FfmpegMediaProcessor } from '../server/src/infrastructure/ffmpeg/ffmpegMediaProcessor';
import { InMemoryMediaRepository } from '../server/src/infrastructure/inMemoryMediaRepository';
import { LocalDiskMediaStorage } from '../server/src/infrastructure/storage/localDiskMediaStorage';

const files = process.argv.slice(2);
if (files.length === 0) { console.error('Usage: npm run check:extraction -- <video> [more...]'); process.exit(1); }

const MB = 1024 * 1024;
const config = parseServerConfig({ ...process.env, SAFEWATCH_MAX_UPLOAD_MB: '4096' });
const storageDir = await mkdtemp(join(tmpdir(), 'sw-extcheck-'));
const logs: Array<Record<string, unknown>> = [];
const logger = {
  debug() {},
  info: (m: string, f?: object) => { logs.push({ m, ...f }); },
  warn: (m: string, f?: object) => { logs.push({ m, ...f }); },
  error: (m: string, f?: object) => { logs.push({ m, ...f }); },
};
const storage = new LocalDiskMediaStorage(storageDir);
const repository = new InMemoryMediaRepository();
const ex = config.extraction;
const extraction = new MediaExtractionService({
  storage, repository, logger, extractor: new FfmpegMediaExtractor(config), queue: new ProcessingQueue(ex.maxConcurrent, ex.maxQueued),
  limits: { timeoutMs: ex.timeoutMs, frame: ex.frame, maxFrameBytes: ex.maxFrameBytes, maxAudioBytes: ex.maxAudioBytes, maxAudioTracks: ex.maxAudioTracks, maxCues: ex.maxCues, maxSubtitleBytes: ex.maxSubtitleBytes },
});
const mediaService = new MediaService({
  storage, repository, logger, extraction, processor: new FfmpegMediaProcessor(config), queue: new ProcessingQueue(2, 10),
  limits: { ...config, processingTimeoutMs: 120_000 },
});
const server = createApiServer({ mediaService, logger, limits: { uploadTimeoutMs: 3_600_000 }, allowedOrigins: [], health: { version: 'check', environment: 'test', tools: { ffmpeg: true, ffprobe: true } } });
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const port = (server.address() as AddressInfo).port;
const mimeFor = (f: string) => ({ '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.webm': 'video/webm' })[extname(f).toLowerCase()] ?? 'video/mp4';

/** Sums RSS (MB) of all FFmpeg/FFprobe processes right now. */
function ffmpegChildren(): { count: number; rssMB: number } {
  try {
    const out = execFileSync('ps', ['-A', '-o', 'rss=,comm='], { encoding: 'utf8' });
    const rows = out.split('\n').map((l) => l.trim().match(/^(\d+)\s+(.*)$/)).filter((m): m is RegExpMatchArray => !!m);
    const mine = rows.filter((m) => /(^|\/)(ffmpeg|ffprobe)$/.test(m[2] ?? ''));
    return { count: mine.length, rssMB: mine.reduce((n, m) => n + Number(m[1]) / 1024, 0) };
  } catch { return { count: 0, rssMB: 0 }; }
}
const dirSize = async (dir: string): Promise<number> => {
  let total = 0;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    total += e.isDirectory() ? await dirSize(p) : (await stat(p)).size;
  }
  return total;
};
const r1 = (n: number) => Math.round(n * 10) / 10;

for (const file of files) {
  global.gc?.();
  const peak = { heap: 0, rss: 0, ffmpegRss: 0, ffmpegConcurrent: 0 };
  const base = process.memoryUsage();
  const sampler = setInterval(() => {
    const m = process.memoryUsage();
    const c = ffmpegChildren();
    peak.heap = Math.max(peak.heap, m.heapUsed / MB);
    peak.rss = Math.max(peak.rss, m.rss / MB);
    peak.ffmpegRss = Math.max(peak.ffmpegRss, c.rssMB);
    peak.ffmpegConcurrent = Math.max(peak.ffmpegConcurrent, c.count);
  }, 100);

  const size = (await stat(file)).size;
  const t0 = performance.now();
  const id = await new Promise<string>((resolve, reject) => {
    const req = request({ port, host: '127.0.0.1', method: 'POST', path: '/api/media', headers: { 'content-type': mimeFor(file), 'content-length': String(size), 'x-safewatch-filename': encodeURIComponent(basename(file)) } }, (res) => {
      let body = ''; res.on('data', (c) => { body += c; });
      res.on('end', () => (res.statusCode === 202 ? resolve(JSON.parse(body).media.asset.id) : reject(new Error(`HTTP ${res.statusCode}`))));
    });
    req.on('error', reject);
    createReadStream(file).pipe(req);
  });
  const uploadMs = performance.now() - t0;

  let manifest: MediaExtraction | undefined;
  let mediaReadyAt = 0;
  for (;;) {
    const rec = repository.get(id);
    if (rec?.asset.status === 'ready' && !mediaReadyAt) mediaReadyAt = performance.now();
    if (rec && (rec.extraction.status === 'completed' || rec.extraction.status === 'failed')) { manifest = rec.extraction; break; }
    await new Promise((r) => setTimeout(r, 50));
  }
  const totalMs = performance.now() - t0;
  clearInterval(sampler);

  const extractionDir = join(storageDir, `${id}.extraction`);
  const onDisk = manifest.status === 'completed' ? await dirSize(extractionDir) : 0;
  const audioBytes = manifest.audio.reduce((n, a) => n + (a.duplicateOf === null ? a.sizeBytes : 0), 0);
  const cues = manifest.subtitles.reduce((n, t) => n + t.cueCount, 0);

  const d0 = performance.now();
  await mediaService.delete(id);
  const cleanupMs = performance.now() - d0;
  const leftover = (await readdir(storageDir)).filter((f) => f !== '.safewatch-storage');

  console.log(JSON.stringify({
    file: basename(file), fileMB: r1(size / MB), status: manifest.status, errors: manifest.errors,
    config: { ...ex.frame, maxFrameMB: r1(ex.maxFrameBytes / MB), maxAudioMB: r1(ex.maxAudioBytes / MB) },
    timingsMs: { upload: Math.round(uploadMs), mediaReadyAfterUpload: Math.round(mediaReadyAt - t0 - uploadMs), extractionTotal: manifest.metrics?.durationMs, audio: manifest.metrics?.stageMs.audio, subtitles: manifest.metrics?.stageMs.subtitles, frames: manifest.metrics?.stageMs.frames, endToEnd: Math.round(totalMs) },
    output: {
      audioTracks: manifest.audio.length, audioMB: r1(audioBytes / MB), audioDurationSeconds: manifest.audio[0]?.durationSeconds,
      subtitleTracks: manifest.subtitles.length, cues,
      frames: manifest.frames?.frames.length, frameStepSeconds: manifest.frames?.effectiveIntervalSeconds, frameMB: r1((manifest.frames?.totalSizeBytes ?? 0) / MB),
      frameSizes: manifest.frames ? `${Math.min(...manifest.frames.frames.map((f) => f.width))}x${Math.min(...manifest.frames.frames.map((f) => f.height))} … ${Math.max(...manifest.frames.frames.map((f) => f.width))}x${Math.max(...manifest.frames.frames.map((f) => f.height))}` : null,
      totalOutputOnDiskMB: r1(onDisk / MB), outputToSourceRatio: r1((onDisk / size) * 100) + '%',
    },
    processes: { toolProcessesCounted: manifest.metrics?.toolProcesses, peakConcurrentFfmpeg: peak.ffmpegConcurrent },
    memoryMB: { nodeHeapBaseline: r1(base.heapUsed / MB), nodeHeapPeak: r1(peak.heap), nodeRssPeak: r1(peak.rss), ffmpegChildRssPeak: r1(peak.ffmpegRss) },
    cleanup: { ms: r1(cleanupMs), filesLeft: leftover.length },
  }, null, 2));
}

server.closeAllConnections();
server.close();
await rm(storageDir, { recursive: true, force: true });

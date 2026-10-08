/**
 * Manual measurement of the REAL speech-to-text path (not part of the test suite).
 * Uploads each video to an in-process SafeWatch server that uses real FFmpeg,
 * real storage and the configured whisper.cpp model, waits for text analysis,
 * and prints inference time, audio duration, real-time factor, memory, payload
 * size, languages and (optionally) word error rate.
 *
 *   SAFEWATCH_SPEECH_MODEL_PATH=models/ggml-base.bin \
 *   npm run check:speech -- video.mp4 [more...]
 *
 * Optional env: SAFEWATCH_SPEECH_LANGUAGE, SAFEWATCH_SPEECH_THREADS,
 * EXPECTED_TEXT (reference transcript for a word-error-rate figure).
 * Memory is sampled every 100 ms: this process (heap, RSS) and the whisper-cli child process (RSS).
 */
import { execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import type { TextAnalysis } from '@/domain/text/textAnalysis';
import { createApiServer } from '../server/src/api/server';
import { MediaExtractionService } from '../server/src/application/extractionService';
import { MediaService } from '../server/src/application/mediaService';
import { ProcessingQueue } from '../server/src/application/processingQueue';
import { TextAnalysisService, limitsFromConfig } from '../server/src/application/textAnalysisService';
import { parseServerConfig } from '../server/src/config';
import { FfmpegMediaExtractor } from '../server/src/infrastructure/ffmpeg/ffmpegMediaExtractor';
import { FfmpegMediaProcessor } from '../server/src/infrastructure/ffmpeg/ffmpegMediaProcessor';
import { InMemoryMediaRepository } from '../server/src/infrastructure/inMemoryMediaRepository';
import { WhisperCppProvider } from '../server/src/infrastructure/speech/whisperCppProvider';
import { LocalDiskMediaStorage } from '../server/src/infrastructure/storage/localDiskMediaStorage';

const files = process.argv.slice(2);
if (files.length === 0) { console.error('Usage: npm run check:speech -- <video> [more...]'); process.exit(1); }

const MB = 1024 * 1024;
const config = parseServerConfig({ SAFEWATCH_SPEECH_PROVIDER: 'whispercpp', SAFEWATCH_SPEECH_MODEL_PATH: 'models/ggml-base.bin', SAFEWATCH_SPEECH_MAX_DURATION_SECONDS: '21600', SAFEWATCH_SPEECH_TIMEOUT_MS: '3600000', ...process.env, SAFEWATCH_MAX_UPLOAD_MB: '4096' });
const sp = config.speech;
const provider = new WhisperCppProvider({ binaryPath: sp.binaryPath, modelPath: sp.modelPath!, modelName: sp.modelName, threads: sp.threads });
if (!(await provider.isAvailable())) { console.error('whisper.cpp binary or model not found'); process.exit(1); }

const storageDir = await mkdtemp(join(tmpdir(), 'sw-speechcheck-'));
const logger = { debug() {}, info() {}, warn() {}, error() {} };
const storage = new LocalDiskMediaStorage(storageDir);
const repository = new InMemoryMediaRepository();
const ex = config.extraction;
const text = new TextAnalysisService({ storage, repository, logger, speech: provider, queue: new ProcessingQueue(1, 10), limits: limitsFromConfig(sp) });
const extraction = new MediaExtractionService({
  storage, repository, logger, extractor: new FfmpegMediaExtractor(config), queue: new ProcessingQueue(1, 10), onCompleted: (id) => text.schedule(id),
  limits: { timeoutMs: ex.timeoutMs, frame: ex.frame, maxFrameBytes: ex.maxFrameBytes, maxAudioBytes: 4096 * MB, maxAudioTracks: ex.maxAudioTracks, maxCues: ex.maxCues, maxSubtitleBytes: ex.maxSubtitleBytes },
});
const mediaService = new MediaService({ storage, repository, logger, extraction, textAnalysis: text, processor: new FfmpegMediaProcessor(config), queue: new ProcessingQueue(2, 10), limits: { ...config, processingTimeoutMs: 120_000 } });
const server = createApiServer({ mediaService, logger, limits: { uploadTimeoutMs: 3_600_000 }, allowedOrigins: [], health: { version: 'check', environment: 'test', tools: { ffmpeg: true, ffprobe: true }, speech: { provider: 'whispercpp', available: true }, vision: { provider: 'none', available: false } } });
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const port = (server.address() as AddressInfo).port;
const mimeFor = (f: string) => ({ '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.webm': 'video/webm' })[extname(f).toLowerCase()] ?? 'video/mp4';

/** RSS (MB) of any running whisper-cli process. */
function engineRss(): number {
  try {
    const rows = execFileSync('ps', ['-A', '-o', 'rss=,comm='], { encoding: 'utf8' }).split('\n');
    return rows.filter((l) => /whisper-cli$/.test(l.trim())).reduce((n, l) => n + Number(l.trim().split(/\s+/)[0]) / 1024, 0);
  } catch { return 0; }
}
const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;

function wer(reference: string, hypothesis: string): number {
  const words = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' ').split(/\s+/).filter(Boolean);
  const r = words(reference); const h = words(hypothesis);
  const d = Array.from({ length: r.length + 1 }, (_, i) => [i, ...Array<number>(h.length).fill(0)]);
  for (let j = 1; j <= h.length; j++) d[0]![j] = j;
  for (let i = 1; i <= r.length; i++) for (let j = 1; j <= h.length; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (r[i - 1] === h[j - 1] ? 0 : 1));
  return d[r.length]![h.length]! / Math.max(1, r.length);
}

for (const file of files) {
  global.gc?.();
  const base = process.memoryUsage();
  const peak = { heap: 0, rss: 0, engine: 0 };
  const sampler = setInterval(() => {
    const m = process.memoryUsage();
    peak.heap = Math.max(peak.heap, m.heapUsed / MB); peak.rss = Math.max(peak.rss, m.rss / MB); peak.engine = Math.max(peak.engine, engineRss());
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

  let analysis: TextAnalysis | undefined;
  for (;;) {
    const rec = repository.get(id);
    if (rec && (rec.text.status === 'ready' || rec.text.status === 'failed')) { analysis = rec.text; break; }
    if (rec && rec.extraction.status === 'failed') { console.error('extraction failed'); break; }
    await new Promise((r) => setTimeout(r, 50));
  }
  const totalMs = performance.now() - t0;
  clearInterval(sampler);
  if (!analysis) continue;

  const track = analysis.speech.find((s) => s.status === 'completed');
  const tr = track?.transcript;
  const audioSeconds = analysis.metrics?.audioSeconds ?? 0;
  const inferMs = track?.processingMs ?? 0;
  const apiFull = await fetch(`http://127.0.0.1:${port}/api/media/${id}/transcript`).then((r) => r.text());
  const apiSlim = await fetch(`http://127.0.0.1:${port}/api/media/${id}/transcript?words=false`).then((r) => r.text());
  const fullText = analysis.timeline.filter((e) => e.source === 'speech').map((e) => e.text).join(' ');
  const words = tr?.segments.flatMap((s) => s.words ?? []) ?? [];

  console.log(JSON.stringify({
    file: basename(file), fileMB: r1(size / MB), status: analysis.status, issues: analysis.issues,
    model: analysis.provider, language: tr?.language, tracks: analysis.speech.map((s) => ({ id: s.audioTrackId, status: s.status, error: s.error, skip: s.skipReason })),
    timing: { audioSeconds: r1(audioSeconds), inferenceMs: Math.round(inferMs), realTimeFactor: audioSeconds ? r2(inferMs / 1000 / audioSeconds) : null, speedVsRealtime: inferMs ? r1(audioSeconds / (inferMs / 1000)) + 'x' : null, endToEndMs: Math.round(totalMs) },
    output: { segments: tr?.segments.length, words: words.length, wordTiming: tr?.wordTiming, timelineEvents: analysis.timeline.length, transcriptChars: fullText.length, apiPayloadKB: { withWords: r1(apiFull.length / 1024), withoutWords: r1(apiSlim.length / 1024) } },
    memoryMB: { nodeHeapBaseline: r1(base.heapUsed / MB), nodeHeapPeak: r1(peak.heap), nodeRssPeak: r1(peak.rss), whisperEngineRssPeak: r1(peak.engine) },
    ...(process.env.EXPECTED_TEXT ? { wordErrorRate: r2(wer(process.env.EXPECTED_TEXT, fullText)) } : {}),
    sample: fullText.slice(0, 160),
  }, null, 2));
  await mediaService.delete(id);
}

server.closeAllConnections();
server.close();
await rm(storageDir, { recursive: true, force: true });

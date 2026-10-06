import { mkdtemp, readdir, rm } from 'node:fs/promises';
import type { MediaExtraction } from '@/domain/extraction/extraction';
import { DEFAULT_FRAME_SAMPLING } from '@/domain/extraction/sampling';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import type { MediaResponse } from '@/domain/api/contract';
import { normalizeMetadata } from '@/domain/media/metadata';
import { execFileSync } from 'node:child_process';
import { createApiServer } from '../src/api/server';
import { MediaExtractionService } from '../src/application/extractionService';
import type { MediaExtractor } from '../src/application/extractionPorts';
import type { ExtractionLimits } from '../src/application/extractionTypes';
import { FfmpegMediaExtractor } from '../src/infrastructure/ffmpeg/ffmpegMediaExtractor';
import { TextAnalysisService, type TextAnalysisLimits } from '../src/application/textAnalysisService';
import type { SpeechToTextProvider } from '../src/application/speechPorts';
import { WhisperCppProvider } from '../src/infrastructure/speech/whisperCppProvider';
import type { TextAnalysis } from '@/domain/text/textAnalysis';
import { MediaService } from '../src/application/mediaService';
import type { Logger, ServerMediaProcessor } from '../src/application/ports';
import { ProcessingQueue } from '../src/application/processingQueue';
import { FfmpegMediaProcessor } from '../src/infrastructure/ffmpeg/ffmpegMediaProcessor';
import { InMemoryMediaRepository } from '../src/infrastructure/inMemoryMediaRepository';
import { LocalDiskMediaStorage } from '../src/infrastructure/storage/localDiskMediaStorage';

export const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
export const tools = await FfmpegMediaProcessor.checkTools({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' });
export const hasFfmpeg = tools.ffmpeg && tools.ffprobe;

export const fakeProcessor = (): ServerMediaProcessor => ({
  extractMetadata: async () => normalizeMetadata({ durationSeconds: 1, width: 160, height: 120, frameRate: 25 }, 'ffprobe'),
  verifyDecodable: async () => undefined,
});

export interface TestApp {
  url: string;
  storageDir: string;
  logs: Array<Record<string, unknown>>;
  service: MediaService;
  extraction?: MediaExtractionService;
  textAnalysis?: TextAnalysisService;
  repository: InMemoryMediaRepository;
  storage: LocalDiskMediaStorage;
  clock: { now: number };
  files(): Promise<string[]>;
  close(): Promise<void>;
}

export interface TestAppOptions {
  processor?: ServerMediaProcessor;
  maxUploadBytes?: number;
  processingTimeoutMs?: number;
  maxConcurrentProcessing?: number;
  maxQueuedProcessing?: number;
  maxConcurrentUploads?: number;
  retentionMs?: number;
  allowedOrigins?: string[];
  toolsStatus?: { ffmpeg: boolean; ffprobe: boolean };
  /** Enables extraction after media is ready. Omit to test media handling alone. */
  extraction?: { extractor?: MediaExtractor; limits?: Partial<ExtractionLimits>; maxConcurrent?: number; maxQueued?: number };
  /** Enables text analysis after extraction. `provider: null` = speech-to-text not configured (subtitle evidence only). Requires `extraction`. */
  speech?: { provider: SpeechToTextProvider | null; limits?: Partial<TextAnalysisLimits>; maxConcurrent?: number; maxQueued?: number };
}

export const defaultSpeechLimits = (): TextAnalysisLimits => ({ language: 'auto', timeoutMs: 30_000, maxAudioBytes: 256 * 1024 * 1024, maxDurationSeconds: 3600, maxTracks: 1 });

/** The real local model, if installed (see SAFEWATCH docs). Real-inference tests skip themselves without it. */
export const MODEL_PATH = new URL('../../models/ggml-base.bin', import.meta.url).pathname;
export const realSpeech = new WhisperCppProvider({ binaryPath: 'whisper-cli', modelPath: MODEL_PATH, modelName: 'ggml-base', threads: 4 });
export const hasRealSpeech = await realSpeech.isAvailable();

export const defaultExtractionLimits = (): ExtractionLimits => ({
  timeoutMs: 30_000,
  frame: { ...DEFAULT_FRAME_SAMPLING },
  maxFrameBytes: 64 * 1024 * 1024,
  maxAudioBytes: 512 * 1024 * 1024,
  maxAudioTracks: 8,
  maxCues: 50_000,
  maxSubtitleBytes: 8 * 1024 * 1024,
});

export async function startTestApp(opts: TestAppOptions = {}): Promise<TestApp> {
  const storageDir = await mkdtemp(join(tmpdir(), 'sw-test-'));
  const logs: Array<Record<string, unknown>> = [];
  const logger: Logger = {
    debug: () => undefined,
    info: (msg, f) => { logs.push({ level: 'info', msg, ...f }); },
    warn: (msg, f) => { logs.push({ level: 'warn', msg, ...f }); },
    error: (msg, f) => { logs.push({ level: 'error', msg, ...f }); },
  };
  const storage = new LocalDiskMediaStorage(storageDir);
  const repository = new InMemoryMediaRepository();
  const clock = { now: Date.now() };
  const limits = {
    maxUploadBytes: opts.maxUploadBytes ?? 50 * 1024 * 1024,
    maxConcurrentUploads: opts.maxConcurrentUploads ?? 4,
    processingTimeoutMs: opts.processingTimeoutMs ?? 10_000,
    retentionMs: opts.retentionMs ?? 60 * 60_000,
  };
  const textAnalysis = opts.extraction && opts.speech
    ? new TextAnalysisService({
        storage, repository, logger, now: () => clock.now, speech: opts.speech.provider,
        queue: new ProcessingQueue(opts.speech.maxConcurrent ?? 1, opts.speech.maxQueued ?? 10),
        limits: { ...defaultSpeechLimits(), ...opts.speech.limits },
      })
    : undefined;
  const extraction = opts.extraction
    ? new MediaExtractionService({
        storage, repository, logger, now: () => clock.now, onCompleted: (id, rid) => textAnalysis?.schedule(id, rid),
        extractor: opts.extraction.extractor ?? new FfmpegMediaExtractor({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' }),
        queue: new ProcessingQueue(opts.extraction.maxConcurrent ?? 1, opts.extraction.maxQueued ?? 10),
        limits: { ...defaultExtractionLimits(), ...opts.extraction.limits },
      })
    : undefined;
  const service = new MediaService({
    storage, repository, logger, limits, extraction, textAnalysis,
    processor: opts.processor ?? fakeProcessor(),
    queue: new ProcessingQueue(opts.maxConcurrentProcessing ?? 2, opts.maxQueuedProcessing ?? 10),
    now: () => clock.now,
  });
  const server = createApiServer({
    mediaService: service, logger, limits: { uploadTimeoutMs: 30_000 },
    allowedOrigins: opts.allowedOrigins ?? ['http://localhost:5173'],
    health: { version: '0.0.0-test', environment: 'test', tools: opts.toolsStatus ?? { ffmpeg: true, ffprobe: true }, speech: { provider: opts.speech?.provider ? 'test' : 'none', available: !!opts.speech?.provider } },
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url, storageDir, logs, service, extraction, textAnalysis, repository, storage, clock,
    files: async () => (await readdir(storageDir)).filter((f) => f !== '.safewatch-storage'),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await rm(storageDir, { recursive: true, force: true });
    },
  };
}

export function upload(app: TestApp, body: BodyInit | null, filename: string | null, type: string | null = 'video/mp4', extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { ...extra };
  if (filename !== null) headers['x-safewatch-filename'] = encodeURIComponent(filename);
  if (type !== null) headers['content-type'] = type;
  return fetch(`${app.url}/api/media`, { method: 'POST', headers, body });
}

export async function waitForStatus(app: TestApp, id: string, statuses: string[], timeoutMs = 10_000): Promise<MediaResponse['media']> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const res = await fetch(`${app.url}/api/media/${id}`);
    const { media } = (await res.json()) as MediaResponse;
    if (statuses.includes(media.asset.status)) return media;
    if (Date.now() > end) throw new Error(`timed out waiting for ${statuses.join('|')}; last=${media.asset.status}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Resolves once `predicate` is true (polling), for asserting background cleanup. */
export async function eventually(predicate: () => Promise<boolean> | boolean, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 25));
  }
}

export async function waitForExtraction(app: TestApp, id: string, timeoutMs = 20_000): Promise<MediaExtraction> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const res = await fetch(`${app.url}/api/media/${id}/extraction`);
    const { extraction } = (await res.json()) as { extraction: MediaExtraction };
    if (extraction.status === 'completed' || extraction.status === 'failed') return extraction;
    if (Date.now() > end) throw new Error(`timed out waiting for extraction; last=${extraction.status}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Generates a small synthetic video with FFmpeg into `file` (tests only; never committed). */
export function generateVideo(file: string, o: { width: number; height: number; seconds: number; fps?: number; audio?: boolean }) {
  const args = ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=${o.width}x${o.height}:rate=${o.fps ?? 10}`];
  if (o.audio) args.push('-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100');
  args.push('-t', String(o.seconds), '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '10', '-b:v', '200k', '-pix_fmt', 'yuv420p');
  if (o.audio) args.push('-c:a', 'aac', '-b:a', '24k');
  args.push(file);
  execFileSync('ffmpeg', args, { stdio: 'ignore' });
}

export async function waitForTextAnalysis(app: TestApp, id: string, timeoutMs = 60_000): Promise<TextAnalysis> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const res = await fetch(`${app.url}/api/media/${id}/transcript`);
    const { textAnalysis } = (await res.json()) as { textAnalysis: TextAnalysis };
    if (textAnalysis.status === 'ready' || textAnalysis.status === 'failed') return textAnalysis;
    if (Date.now() > end) throw new Error(`timed out waiting for text analysis; last=${textAnalysis.status}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

import { mkdtemp, readdir, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import type { MediaResponse } from '@/domain/api/contract';
import { normalizeMetadata } from '@/domain/media/metadata';
import { createApiServer } from '../src/api/server';
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
}

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
  const service = new MediaService({
    storage, repository, logger, limits,
    processor: opts.processor ?? fakeProcessor(),
    queue: new ProcessingQueue(opts.maxConcurrentProcessing ?? 2, opts.maxQueuedProcessing ?? 10),
    now: () => clock.now,
  });
  const server = createApiServer({
    mediaService: service, logger, limits: { uploadTimeoutMs: 30_000 },
    allowedOrigins: opts.allowedOrigins ?? ['http://localhost:5173'],
    health: { version: '0.0.0-test', environment: 'test', tools: opts.toolsStatus ?? { ffmpeg: true, ffprobe: true } },
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url, storageDir, logs, service, repository, storage, clock,
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

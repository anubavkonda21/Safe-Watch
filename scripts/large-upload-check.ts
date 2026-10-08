/**
 * Manual large-file check (not part of the test suite): streams a real video
 * to an in-process SafeWatch server using the real FFprobe/FFmpeg adapter and
 * reports memory, timing and cleanup. Usage:
 *
 *   npm run check:large -- /path/to/large.mp4
 *
 * The file is streamed from disk in chunks by the client side as well, so the
 * numbers reflect the server's behaviour. Heap/RSS are sampled every 50 ms.
 */
import { createReadStream } from 'node:fs';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createApiServer } from '../server/src/api/server';
import { MediaService } from '../server/src/application/mediaService';
import { ProcessingQueue } from '../server/src/application/processingQueue';
import { FfmpegMediaProcessor } from '../server/src/infrastructure/ffmpeg/ffmpegMediaProcessor';
import { InMemoryMediaRepository } from '../server/src/infrastructure/inMemoryMediaRepository';
import { LocalDiskMediaStorage } from '../server/src/infrastructure/storage/localDiskMediaStorage';

const path = process.argv[2];
if (!path) { console.error('Usage: npm run check:large -- <video file>'); process.exit(1); }

const MB = 1024 * 1024;
const size = (await stat(path)).size;
const storageDir = await mkdtemp(join(tmpdir(), 'sw-large-'));
const ffmpeg = { ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' };
const logs: string[] = [];
const quiet = { debug() {}, info: (m: string, f?: object) => logs.push(m + ' ' + JSON.stringify(f)), warn: (m: string, f?: object) => logs.push(m + ' ' + JSON.stringify(f)), error: (m: string, f?: object) => logs.push(m + ' ' + JSON.stringify(f)) };
const storage = new LocalDiskMediaStorage(storageDir);
const limits = { maxUploadBytes: 8 * 1024 * MB, maxConcurrentUploads: 4, processingTimeoutMs: 120_000, retentionMs: 3_600_000 };
const service = new MediaService({ storage, repository: new InMemoryMediaRepository(), processor: new FfmpegMediaProcessor(ffmpeg), queue: new ProcessingQueue(2, 10), logger: quiet, limits });
const server = createApiServer({ mediaService: service, logger: quiet, limits: { uploadTimeoutMs: 3_600_000 }, allowedOrigins: [], health: { version: 'check', environment: 'test', tools: { ffmpeg: true, ffprobe: true }, speech: { provider: 'none', available: false }, vision: { provider: 'none', available: false } } });
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const port = (server.address() as AddressInfo).port;

const mem = () => { const m = process.memoryUsage(); return { heapMB: m.heapUsed / MB, rssMB: m.rss / MB, externalMB: (m.external + m.arrayBuffers) / MB }; };
global.gc?.();
const base = mem();
const peak = { ...base };
const sampler = setInterval(() => { const m = mem(); for (const k of Object.keys(peak) as Array<keyof typeof peak>) peak[k] = Math.max(peak[k], m[k]); }, 50);

const t0 = performance.now();
const created = await new Promise<{ id: string; status: number }>((resolve, reject) => {
  const req = request({ port, host: '127.0.0.1', method: 'POST', path: '/api/media', headers: { 'content-type': 'video/mp4', 'content-length': String(size), 'x-safewatch-filename': encodeURIComponent(basename(path)) } }, (res) => {
    let body = ''; res.on('data', (c) => { body += c; });
    res.on('end', () => resolve({ id: JSON.parse(body).media?.asset?.id, status: res.statusCode ?? 0 }));
  });
  req.on('error', reject);
  createReadStream(path).pipe(req);
});
const uploadMs = performance.now() - t0;

const t1 = performance.now();
let final: { asset: { status: string; metadata: Record<string, unknown>; failure: unknown } } | undefined;
for (;;) {
  const res = await fetch(`http://127.0.0.1:${port}/api/media/${created.id}`);
  final = ((await res.json()) as { media: typeof final }).media;
  if (final && (final.asset.status === 'ready' || final.asset.status === 'failed')) break;
  await new Promise((r) => setTimeout(r, 50));
}
const processMs = performance.now() - t1;
clearInterval(sampler);
const storedOnDisk = (await readdir(storageDir)).filter((f) => f.endsWith('.media')).length;

const t2 = performance.now();
await fetch(`http://127.0.0.1:${port}/api/media/${created.id}`, { method: 'DELETE' });
const cleanupMs = performance.now() - t2;
const leftover = (await readdir(storageDir)).filter((f) => f !== '.safewatch-storage');

const r = (n: number) => Math.round(n * 10) / 10;
console.log(JSON.stringify({
  fileMB: r(size / MB), httpStatus: created.status, mediaStatus: final?.asset.status, failure: final?.asset.failure,
  metadata: final?.asset.metadata,
  uploadSeconds: r(uploadMs / 1000), uploadMBps: r(size / MB / (uploadMs / 1000)), processingMs: Math.round(processMs), cleanupMs: r(cleanupMs),
  storedFilesBeforeDelete: storedOnDisk, filesLeftAfterDelete: leftover.length,
  memoryMB: { baselineHeap: r(base.heapMB), peakHeap: r(peak.heapMB), heapGrowth: r(peak.heapMB - base.heapMB), baselineRss: r(base.rssMB), peakRss: r(peak.rssMB), rssGrowth: r(peak.rssMB - base.rssMB), peakExternalPlusArrayBuffers: r(peak.externalMB), baselineExternal: r(base.externalMB) },
}, null, 2));

server.closeAllConnections();
server.close();
await rm(storageDir, { recursive: true, force: true });

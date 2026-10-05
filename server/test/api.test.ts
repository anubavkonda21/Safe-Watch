import { request } from 'node:http';
import type { ApiErrorBody, HealthResponse, MediaResponse } from '@/domain/api/contract';
import { normalizeMetadata } from '@/domain/media/metadata';
import type { ServerMediaProcessor } from '../src/application/ports';
import { FfmpegMediaProcessor } from '../src/infrastructure/ffmpeg/ffmpegMediaProcessor';
import { eventually, fakeProcessor, fixture, hasFfmpeg, startTestApp, upload, waitForStatus, type TestApp } from './helpers';

let app: TestApp;
afterEach(async () => { await app?.close(); });

const mp4 = () => new Uint8Array(fixture('sample.mp4'));
const errorOf = async (res: Response) => ((await res.json()) as ApiErrorBody).error;

describe('GET /api/health', () => {
  it('reports status, version, environment and tool availability only', async () => {
    app = await startTestApp();
    const res = await fetch(`${app.url}/api/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const body = (await res.json()) as HealthResponse;
    expect(body).toEqual({ status: 'ok', service: 'safewatch-api', version: '0.0.0-test', environment: 'test', tools: { ffmpeg: true, ffprobe: true } });
    expect(JSON.stringify(body)).not.toContain(app.storageDir);
  });
  it('is degraded when tools are missing', async () => {
    app = await startTestApp({ toolsStatus: { ffmpeg: true, ffprobe: false } });
    expect(((await (await fetch(`${app.url}/api/health`)).json()) as HealthResponse).status).toBe('degraded');
  });
  it('sets a request id header and honours a valid incoming one', async () => {
    app = await startTestApp();
    expect((await fetch(`${app.url}/api/health`)).headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    expect((await fetch(`${app.url}/api/health`, { headers: { 'x-request-id': 'client-req-12345' } })).headers.get('x-request-id')).toBe('client-req-12345');
    expect((await fetch(`${app.url}/api/health`, { headers: { 'x-request-id': 'bad id\twith spaces' } })).headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('POST /api/media — happy path', () => {
  it('stores the upload, answers 202 with an id and uploaded status, then becomes ready', async () => {
    app = await startTestApp();
    const res = await upload(app, mp4(), 'My Clip.mp4');
    expect(res.status).toBe(202);
    const { media } = (await res.json()) as MediaResponse;
    expect(res.headers.get('location')).toBe(`/api/media/${media.asset.id}`);
    expect(media.asset).toMatchObject({ filename: 'My Clip.mp4', container: 'mp4', status: 'uploaded', sizeBytes: mp4().length });
    expect(media.analysis).toEqual({ status: 'not_started' });
    expect(media.asset.id).toMatch(/^[0-9a-f-]{36}$/);

    const ready = await waitForStatus(app, media.asset.id, ['ready']);
    expect(ready.asset.metadata).toMatchObject({ availability: 'available', source: 'ffprobe', width: 160 });
    expect(ready.analysis.status).toBe('not_started'); // media READY, analysis NOT started
  });
  it('never exposes filesystem paths or raw tool output', async () => {
    app = await startTestApp();
    const { media } = (await (await upload(app, mp4(), 'a.mp4')).json()) as MediaResponse;
    const ready = await waitForStatus(app, media.asset.id, ['ready']);
    const text = JSON.stringify(ready);
    expect(text).not.toContain(app.storageDir);
    expect(text).not.toMatch(/\.media|\.part|ffmpeg|codec_type|stack/i);
  });
});

describe('POST /api/media — rejection', () => {
  it('rejects a missing filename header', async () => {
    app = await startTestApp();
    const res = await upload(app, mp4(), null);
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe('INVALID_FILE');
  });
  it('rejects an undecodable filename header', async () => {
    app = await startTestApp();
    const res = await fetch(`${app.url}/api/media`, { method: 'POST', headers: { 'x-safewatch-filename': '%E0%A4%A', 'content-type': 'video/mp4' }, body: mp4() });
    expect((await errorOf(res)).code).toBe('INVALID_FILE');
  });
  it('rejects a missing file (empty body) and leaves nothing stored', async () => {
    app = await startTestApp();
    const res = await upload(app, null, 'a.mp4');
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe('INVALID_FILE');
    expect(await app.files()).toEqual([]);
  });
  it('rejects an invalid MIME type', async () => {
    app = await startTestApp();
    const res = await upload(app, mp4(), 'a.mp4', 'text/html');
    expect(res.status).toBe(415);
    expect((await errorOf(res)).code).toBe('UNSUPPORTED_MEDIA');
    expect(await app.files()).toEqual([]);
  });
  it('rejects an invalid extension even with a video MIME type', async () => {
    app = await startTestApp();
    for (const name of ['a.exe', 'a.mp4.exe', 'noext', 'a.constructor']) {
      const res = await upload(app, mp4(), name);
      expect(res.status).toBe(415);
    }
    expect(await app.files()).toEqual([]);
  });
  it('rejects content that does not match the claimed type, and stores nothing', async () => {
    app = await startTestApp();
    const res = await upload(app, '<html>this is not a video, it is a web page of some length</html>', 'fake.mp4');
    expect(res.status).toBe(415);
    expect((await errorOf(res)).code).toBe('UNSUPPORTED_MEDIA');
    expect(await app.files()).toEqual([]);
  });
  it('rejects an oversized upload by declared length, before storing anything', async () => {
    app = await startTestApp({ maxUploadBytes: 4096 });
    const res = await upload(app, new Uint8Array(10_000), 'big.mp4');
    expect(res.status).toBe(413);
    expect((await errorOf(res)).code).toBe('FILE_TOO_LARGE');
    expect(await app.files()).toEqual([]);
  });
  it('rejects an oversized chunked upload (no Content-Length) while streaming and cleans up', async () => {
    app = await startTestApp({ maxUploadBytes: 4096 });
    const head = mp4().subarray(0, 64);
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(`${app.url}/api/media`, { method: 'POST', headers: { 'x-safewatch-filename': 'big.mp4', 'content-type': 'video/mp4', 'transfer-encoding': 'chunked' } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on('error', reject);
      req.write(head);
      for (let i = 0; i < 4; i++) req.write(Buffer.alloc(2048));
      req.end();
    });
    expect(status).toBe(413);
    await eventually(async () => (await app.files()).length === 0);
  });
  it('treats a client that disconnects mid-upload as a failed upload and cleans up', async () => {
    app = await startTestApp();
    await new Promise<void>((resolve) => {
      const req = request(`${app.url}/api/media`, { method: 'POST', headers: { 'x-safewatch-filename': 'a.mp4', 'content-type': 'video/mp4', 'content-length': '100000' } });
      req.on('error', () => resolve());
      req.write(mp4().subarray(0, 100));
      setTimeout(() => { req.destroy(); resolve(); }, 100);
    });
    await eventually(async () => (await app.files()).length === 0);
    expect(app.logs.some((l) => l.msg === 'upload rejected' && l.code === 'UPLOAD_FAILED')).toBe(true);
  });
  it('unknown routes and methods return structured 404s', async () => {
    app = await startTestApp();
    for (const [method, path] of [['GET', '/nope'], ['GET', '/api/media'], ['PUT', '/api/media/x'], ['POST', '/api/health']] as const) {
      const res = await fetch(`${app.url}${path}`, { method });
      expect(res.status).toBe(404);
      expect((await errorOf(res)).code).toBe('NOT_FOUND');
    }
  });
});

describe('processing outcomes', () => {
  it('malformed media behind a valid header fails with a typed code and is deleted', async () => {
    if (!hasFfmpeg) return;
    app = await startTestApp({ processor: new FfmpegMediaProcessor({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' }) });
    const res = await upload(app, new Uint8Array(fixture('garbage-with-mp4-header.mp4')), 'broken.mp4');
    const { media } = (await res.json()) as MediaResponse;
    const failed = await waitForStatus(app, media.asset.id, ['failed']);
    expect(failed.asset.failure).toEqual({ code: 'invalid-media' });
    expect(failed.analysis.status).toBe('not_started');
    await eventually(async () => (await app.files()).length === 0);
  });
  it('an unexpected processor error becomes processing-failed without leaking details', async () => {
    const processor: ServerMediaProcessor = { extractMetadata: async () => { throw new Error('ENOENT /secret/internal/path ffprobe -i'); }, verifyDecodable: async () => undefined };
    app = await startTestApp({ processor });
    const { media } = (await (await upload(app, mp4(), 'a.mp4')).json()) as MediaResponse;
    const failed = await waitForStatus(app, media.asset.id, ['failed']);
    expect(failed.asset.failure).toEqual({ code: 'processing-failed' });
    expect(JSON.stringify(failed)).not.toMatch(/secret|ENOENT|ffprobe/);
    await eventually(async () => (await app.files()).length === 0);
  });
  it('a processing timeout fails the media, aborts the work and deletes the file', async () => {
    let aborted = false;
    const processor: ServerMediaProcessor = {
      extractMetadata: (_i, o) => new Promise((_res, rej) => { o?.signal?.addEventListener('abort', () => { aborted = true; rej(new Error('aborted')); }); }),
      verifyDecodable: async () => undefined,
    };
    app = await startTestApp({ processor, processingTimeoutMs: 100 });
    const { media } = (await (await upload(app, mp4(), 'a.mp4')).json()) as MediaResponse;
    const failed = await waitForStatus(app, media.asset.id, ['failed']);
    expect(failed.asset.failure).toEqual({ code: 'timeout' });
    expect(aborted).toBe(true);
    await eventually(async () => (await app.files()).length === 0);
  });
  it('limits concurrent processing: a full queue answers 503 SERVER_BUSY with Retry-After', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const processor: ServerMediaProcessor = { extractMetadata: async () => { await gate; return normalizeMetadata({ durationSeconds: 1, width: 2, height: 2 }, 'ffprobe'); }, verifyDecodable: async () => undefined };
    app = await startTestApp({ processor, maxConcurrentProcessing: 1, maxQueuedProcessing: 0 });
    const first = await upload(app, mp4(), 'a.mp4');
    expect(first.status).toBe(202);
    await eventually(() => app.logs.length > 0 && app.repository.get(((app.logs.find((l) => l.mediaId)?.mediaId) as string))?.asset.status === 'processing');
    const second = await upload(app, mp4(), 'b.mp4');
    expect(second.status).toBe(503);
    expect(second.headers.get('retry-after')).toBe('5');
    expect((await errorOf(second)).code).toBe('SERVER_BUSY');
    release();
    const { media } = (await first.json()) as MediaResponse;
    await waitForStatus(app, media.asset.id, ['ready']);
  });
  it('limits concurrent uploads', async () => {
    app = await startTestApp({ maxConcurrentUploads: 1 });
    let finish!: () => void;
    const slow = new Promise<void>((resolve) => { finish = resolve; });
    const first = new Promise<number>((resolve, reject) => {
      const req = request(`${app.url}/api/media`, { method: 'POST', headers: { 'x-safewatch-filename': 'a.mp4', 'content-type': 'video/mp4' } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on('error', reject);
      req.write(mp4());
      void slow.then(() => req.end());
    });
    await eventually(async () => (await app.files()).some((f) => f.endsWith('.part')));
    const second = await upload(app, mp4(), 'b.mp4');
    expect(second.status).toBe(503);
    finish();
    expect(await first).toBe(202);
  });
  it('an unexpected server fault returns a generic 500 with no internals', async () => {
    app = await startTestApp();
    app.repository.get = () => { throw new Error(`boom at ${app.storageDir}/secret.js:42`); };
    const res = await fetch(`${app.url}/api/media/${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}`);
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text).error.code).toBe('INTERNAL_ERROR');
    expect(text).not.toMatch(/boom|secret|stack|\.js/);
  });
});

describe('GET/DELETE /api/media/:id', () => {
  it('returns 404 for unknown and malformed ids', async () => {
    app = await startTestApp();
    for (const id of ['00000000-0000-4000-8000-000000000000', 'abc', '..%2F..%2Fetc%2Fpasswd']) {
      expect((await fetch(`${app.url}/api/media/${id}`)).status).toBe(404);
    }
  });
  it('DELETE removes the file and record, and is idempotent', async () => {
    app = await startTestApp();
    const { media } = (await (await upload(app, mp4(), 'a.mp4')).json()) as MediaResponse;
    await waitForStatus(app, media.asset.id, ['ready']);
    expect((await app.files())).toHaveLength(1);
    expect((await fetch(`${app.url}/api/media/${media.asset.id}`, { method: 'DELETE' })).status).toBe(204);
    expect(await app.files()).toEqual([]);
    expect((await fetch(`${app.url}/api/media/${media.asset.id}`)).status).toBe(404);
    expect((await fetch(`${app.url}/api/media/${media.asset.id}`, { method: 'DELETE' })).status).toBe(204);
  });
});

describe('CORS', () => {
  it('echoes only an exact allowed origin, never "*"', async () => {
    app = await startTestApp({ allowedOrigins: ['http://localhost:5173'] });
    const ok = await fetch(`${app.url}/api/health`, { headers: { origin: 'http://localhost:5173' } });
    expect(ok.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(ok.headers.get('vary')).toContain('Origin');
    const other = await fetch(`${app.url}/api/health`, { headers: { origin: 'https://evil.example' } });
    expect(other.headers.get('access-control-allow-origin')).toBeNull();
    expect(ok.headers.get('access-control-allow-credentials')).toBeNull();
  });
  it('answers preflight for allowed origins only', async () => {
    app = await startTestApp({ allowedOrigins: ['http://localhost:5173'] });
    const pre = await fetch(`${app.url}/api/media`, { method: 'OPTIONS', headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'POST' } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-headers')).toContain('x-safewatch-filename');
    const bad = await fetch(`${app.url}/api/media`, { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
    expect(bad.status).toBe(403);
    expect(bad.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('security: hostile filenames', () => {
  it.each([
    ['path traversal', '../../etc/passwd.mp4', 'passwd.mp4'],
    ['windows traversal', '..\\..\\windows\\system32\\evil.mp4', 'evil.mp4'],
    ['absolute path', '/etc/shadow.mp4', 'shadow.mp4'],
    ['shell metacharacters', 'a;$(rm -rf ~);`id`|&.mp4', 'a___rm -rf ____id___.mp4'],
    ['bidi override', 'movie‮gpj.mp4', 'movie_gpj.mp4'],
    ['null byte', 'a\u0000b.mp4', 'a_b.mp4'],
    ['unicode lookalike slashes', '．．／evil.mp4', 'evil.mp4'],
  ])('%s never reaches the filesystem and is sanitised for display', async (_n, name, expected) => {
    app = await startTestApp();
    const res = await upload(app, mp4(), name);
    expect(res.status).toBe(202);
    const { media } = (await res.json()) as MediaResponse;
    expect(media.asset.filename).toBe(expected);
    await waitForStatus(app, media.asset.id, ['ready']);
    const files = await app.files();
    expect(files).toEqual([`${media.asset.id}.media`]); // only the server-generated id on disk
  });
  it('does not log filenames', async () => {
    app = await startTestApp();
    const { media } = (await (await upload(app, mp4(), 'private-holiday-video.mp4')).json()) as MediaResponse;
    await waitForStatus(app, media.asset.id, ['ready']);
    expect(JSON.stringify(app.logs)).not.toContain('private-holiday');
    expect(app.logs.filter((l) => l.mediaId === media.asset.id).every((l) => typeof l.requestId === 'string' || l.op === 'process')).toBe(true);
  });
  it('logs operation, request id, media id, status and duration', async () => {
    app = await startTestApp();
    const { media } = (await (await upload(app, mp4(), 'a.mp4')).json()) as MediaResponse;
    await waitForStatus(app, media.asset.id, ['ready']);
    expect(app.logs.find((l) => l.msg === 'media ready')).toMatchObject({ op: 'process', mediaId: media.asset.id, status: 'ready', durationMs: expect.any(Number), requestId: expect.any(String) });
  });
});

describe('lifecycle and cleanup', () => {
  it('startup purge removes leftovers from a previous run', async () => {
    app = await startTestApp();
    const { randomUUID } = await import('node:crypto');
    async function* data() { yield Buffer.from('x'); }
    await app.storage.save(randomUUID(), data(), { maxBytes: 10 });
    await app.storage.save(randomUUID(), data(), { maxBytes: 10 });
    await app.service.start();
    expect(await app.files()).toEqual([]);
  });
  it('sweep removes expired records and files, keeps live ones', async () => {
    app = await startTestApp({ retentionMs: 60_000 });
    const a = (await (await upload(app, mp4(), 'a.mp4')).json()) as MediaResponse;
    await waitForStatus(app, a.media.asset.id, ['ready']);
    expect(await app.service.sweep()).toMatchObject({ expired: 0 });
    expect(await app.files()).toHaveLength(1);
    app.clock.now += 61_000;
    expect(await app.service.sweep()).toMatchObject({ expired: 1 });
    expect(await app.files()).toEqual([]);
    expect((await fetch(`${app.url}/api/media/${a.media.asset.id}`)).status).toBe(404);
  });
  it('a failed delete is logged and retried by a later sweep', async () => {
    app = await startTestApp({ retentionMs: 60_000 });
    const { media } = (await (await upload(app, mp4(), 'a.mp4')).json()) as MediaResponse;
    await waitForStatus(app, media.asset.id, ['ready']);
    const realDelete = app.storage.delete.bind(app.storage);
    app.storage.delete = async () => { throw new Error('EBUSY'); };
    await fetch(`${app.url}/api/media/${media.asset.id}`, { method: 'DELETE' });
    expect(app.logs.some((l) => l.level === 'error' && String(l.msg).includes('delete failed'))).toBe(true);
    expect(await app.files()).toHaveLength(1); // still on disk
    app.storage.delete = realDelete;
    // Orphan sweep is age-based: make the file old enough.
    const { utimes } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const old = new Date(Date.now() - 2 * 3600_000);
    await utimes(join(app.storageDir, `${media.asset.id}.media`), old, old);
    expect(await app.service.sweep()).toMatchObject({ orphans: 1 });
    expect(await app.files()).toEqual([]);
  });
  it('uses the default fake processor contract (sanity)', async () => {
    expect((await fakeProcessor().extractMetadata({ path: '/x', container: 'mp4' })).availability).toBe('available');
  });
});

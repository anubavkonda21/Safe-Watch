import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApiErrorBody, ExtractionResponse, MediaResponse } from '@/domain/api/contract';
import { ExtractionError } from '../src/application/errors';
import type { MediaExtractor } from '../src/application/extractionPorts';
import { eventually, fixture, generateVideo, hasFfmpeg, startTestApp, upload, waitForExtraction, waitForStatus, type TestApp } from './helpers';

let app: TestApp;
afterEach(async () => { await app?.close(); });

const mkv = (name: string) => new Uint8Array(fixture(name));
const send = async (file: string, name = file, type = file.endsWith('.mkv') ? 'video/x-matroska' : 'video/mp4') => {
  const { media } = (await (await upload(app, mkv(file), name, type)).json()) as MediaResponse;
  return media.asset.id;
};
const extractionDirs = async () => (await app.files()).filter((f) => f.endsWith('.extraction'));

// Real FFmpeg, real storage, real queue: no fakes anywhere on this path.
describe.skipIf(!hasFfmpeg)('extraction end-to-end (real FFmpeg)', () => {
  it('upload → media ready → extraction queued → audio → subtitles → frames → manifest → delete → disk empty', async () => {
    app = await startTestApp({ extraction: {}, processor: new (await import('../src/infrastructure/ffmpeg/ffmpegMediaProcessor')).FfmpegMediaProcessor({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' }) });
    const id = await send('multi.mkv');
    const ready = await waitForStatus(app, id, ['ready']);
    expect(ready.analysis.status).toBe('not_started');

    const e = await waitForExtraction(app, id);
    expect(e).toMatchObject({ mediaId: id, status: 'completed', phase: null, errors: [], completedAt: expect.any(String) });
    expect(e.audio).toHaveLength(2);
    expect(e.audio[0]).toMatchObject({ id: 'aud-0', streamIndex: 1, language: 'eng', title: 'English mono', format: { container: 'wav', codec: 'pcm_s16le', sampleRate: 16000, channels: 1 } });
    expect(e.subtitles.map((t) => [t.codec, t.kind, t.textExtraction, t.language, t.cueCount])).toEqual([['subrip', 'text', 'extracted', 'eng', 2], ['ass', 'text', 'extracted', 'spa', 2]]);
    expect(e.subtitles[1]!.cues[0]).toEqual({ index: 0, startSeconds: 0.2, endSeconds: 1.1, text: 'Hola mundo\nsegunda línea' });
    expect(e.frames!.frames.length).toBeGreaterThanOrEqual(1);
    expect(e.frames!.frames[0]).toMatchObject({ id: 'frm-00000', format: 'jpeg', width: 160, height: 120 });
    expect(e.metrics!.toolProcesses).toBeGreaterThanOrEqual(4);

    // Everything extracted exists on disk, in the media's own extraction directory.
    const dir = join(app.storageDir, `${id}.extraction`);
    expect((await readdir(join(dir, 'audio'))).sort()).toEqual(['aud-0.wav', 'aud-1.wav']);
    expect((await readdir(join(dir, 'frames'))).length).toBe(e.frames!.frames.length);

    // The API never reveals paths or tool output.
    const text = JSON.stringify(e);
    expect(text).not.toContain(app.storageDir);
    expect(text).not.toMatch(/\/tmp|ffmpeg|ffprobe|stderr|codec_type/i);

    expect((await fetch(`${app.url}/api/media/${id}`, { method: 'DELETE' })).status).toBe(204);
    expect(await app.files()).toEqual([]);
  });

  it('video without audio and subtitles succeeds with empty lists', async () => {
    app = await startTestApp({ extraction: {} });
    const { media } = (await (await upload(app, mkv('sample-silent.webm'), 'quiet.webm', 'video/webm')).json()) as MediaResponse;
    const e = await waitForExtraction(app, media.asset.id);
    expect(e).toMatchObject({ status: 'completed', audio: [], subtitles: [] });
    expect(e.frames!.frames).toHaveLength(1);
  });

  it('keeps image subtitles explicit: unsupported, never text', async () => {
    app = await startTestApp({ extraction: {} });
    const e = await waitForExtraction(app, await send('image-subs.mkv'));
    const pgs = e.subtitles.find((t) => t.codec === 'hdmv_pgs_subtitle')!;
    expect(pgs).toMatchObject({ kind: 'image', textExtraction: 'unsupported', language: 'jpn', cueCount: 0, cues: [] });
    expect(e.subtitles.find((t) => t.codec === 'subrip')!.textExtraction).toBe('extracted');
    expect(e.status).toBe('completed');
  });

  it('fails cleanly on media FFmpeg cannot decode after the signature check, with no partial assets', async () => {
    app = await startTestApp({ extraction: {}, processor: { extractMetadata: async () => (await import('@/domain/media/metadata')).normalizeMetadata({ durationSeconds: 3, width: 160, height: 120 }, 'ffprobe'), verifyDecodable: async () => undefined } });
    const id = await send('garbage-with-mp4-header.mp4');
    await waitForStatus(app, id, ['ready']); // the fake processor accepts it; real extraction must not
    const e = await waitForExtraction(app, id);
    expect(e).toMatchObject({ status: 'failed', audio: [], subtitles: [], frames: null, errors: [{ fatal: true }] });
    await eventually(async () => (await extractionDirs()).length === 0);
  });

  it('sanitises hostile stream metadata and keeps output inside the extraction directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sw-evil-'));
    const file = join(dir, 'evil.mkv');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
      '-metadata:s:a:0', 'title=<script>alert(1)</script>‮../../etc/passwd', '-metadata:s:a:0', 'language=../../etc', file], { stdio: 'ignore' });
    app = await startTestApp({ extraction: {} });
    const { media } = (await (await upload(app, new Uint8Array(await readFile(file)), '../../evil;name.mkv', 'video/x-matroska')).json()) as MediaResponse;
    const e = await waitForExtraction(app, media.asset.id);
    await rm(dir, { recursive: true, force: true });
    expect(e.status).toBe('completed');
    expect(e.audio[0]!.language).toBeNull(); // path-like language rejected
    expect(e.audio[0]!.title).not.toMatch(/‮/);
    expect(typeof e.audio[0]!.title).toBe('string'); // plain text: rendered by the UI as text, never as HTML
    const entries = await readdir(join(app.storageDir, `${media.asset.id}.extraction`), { recursive: true });
    expect(entries.every((n) => /^(audio|frames)(\/(aud-\d+\.wav|frm-\d{5}\.jpg))?$/.test(n))).toBe(true);
  });
});

describe('GET /api/media/:id/extraction', () => {
  it('returns 404 for unknown and malformed ids', async () => {
    app = await startTestApp({ extraction: {} });
    for (const id of ['00000000-0000-4000-8000-000000000000', 'nope', '..%2F..%2Fetc']) {
      const res = await fetch(`${app.url}/api/media/${id}/extraction`);
      expect(res.status).toBe(404);
      expect(((await res.json()) as ApiErrorBody).error.code).toBe('NOT_FOUND');
    }
  });
  it('is not_started for media that has no extraction wiring, and rejects other methods', async () => {
    app = await startTestApp();
    const { media } = (await (await upload(app, mkv('sample.mp4'), 'a.mp4')).json()) as MediaResponse;
    await waitForStatus(app, media.asset.id, ['ready']);
    const body = (await (await fetch(`${app.url}/api/media/${media.asset.id}/extraction`)).json()) as ExtractionResponse;
    expect(body.extraction).toMatchObject({ status: 'not_started', phase: null, audio: [], subtitles: [], frames: null });
    expect((await fetch(`${app.url}/api/media/${media.asset.id}/extraction`, { method: 'POST' })).status).toBe(404);
  });
  it('does not extract media that failed processing', async () => {
    const failing = { extractMetadata: async () => { throw new Error('boom'); }, verifyDecodable: async () => undefined };
    app = await startTestApp({ processor: failing, extraction: {} });
    const { media } = (await (await upload(app, mkv('sample.mp4'), 'a.mp4')).json()) as MediaResponse;
    await waitForStatus(app, media.asset.id, ['failed']);
    expect(((await (await fetch(`${app.url}/api/media/${media.asset.id}/extraction`)).json()) as ExtractionResponse).extraction.status).toBe('not_started');
  });
  it('exposes a failed extraction with a structured error and no internals', async () => {
    const extractor: MediaExtractor = {
      inspect: async () => { throw new ExtractionError('invalid-media'); },
      extractAudio: async () => { throw new Error('unreachable'); }, extractSubtitleCues: async () => [], sampleFrame: async () => null,
    };
    app = await startTestApp({ extraction: { extractor } });
    const { media } = (await (await upload(app, mkv('sample.mp4'), 'a.mp4')).json()) as MediaResponse;
    const e = await waitForExtraction(app, media.asset.id);
    expect(e).toMatchObject({ status: 'failed', errors: [{ code: 'invalid-media', stage: 'queue', fatal: true, streamIndex: null }] });
    expect(JSON.stringify(e)).not.toMatch(/ENOENT|stack|\.ts|Error:/);
  });
});

describe('extraction cleanup and retention', () => {
  const hanging = (): MediaExtractor => ({
    inspect: async () => ({ durationSeconds: 10, video: null, audio: [], subtitles: [] }),
    extractAudio: async () => { throw new Error('unused'); }, extractSubtitleCues: async () => [],
    sampleFrame: (ctx) => new Promise((_r, rej) => ctx.signal.addEventListener('abort', () => rej(new ExtractionError('timeout')))),
  });

  it('DELETE removes the original and ALL extraction assets, and aborts a running extraction', async () => {
    app = await startTestApp({ extraction: {} });
    const id = await send('multi.mkv');
    await waitForExtraction(app, id);
    expect(await extractionDirs()).toHaveLength(1);
    await fetch(`${app.url}/api/media/${id}`, { method: 'DELETE' });
    expect(await app.files()).toEqual([]);

    await app.close();
    app = await startTestApp({ extraction: { extractor: hanging() } });
    const id2 = await send('sample.mp4');
    await eventually(async () => (await extractionDirs()).length === 1 || app.repository.get(id2)?.extraction.phase === 'sampling-frames');
    await fetch(`${app.url}/api/media/${id2}`, { method: 'DELETE' });
    await eventually(async () => (await app.files()).length === 0);
    expect(app.repository.get(id2)).toBeUndefined();
  });
  it('expiry removes extraction assets together with the media', async () => {
    app = await startTestApp({ extraction: {}, retentionMs: 60_000 });
    const id = await send('multi.mkv');
    await waitForExtraction(app, id);
    expect(await app.files()).toEqual(expect.arrayContaining([`${id}.media`, `${id}.extraction`]));
    app.clock.now += 61_000;
    expect(await app.service.sweep()).toMatchObject({ expired: 1 });
    expect(await app.files()).toEqual([]);
  });
  it('the age-based sweep removes an orphaned extraction directory', async () => {
    app = await startTestApp({ extraction: {}, retentionMs: 60_000 });
    const id = await send('sample.mp4');
    await waitForExtraction(app, id);
    app.repository.delete(id); // registry forgot it (e.g. crash between steps)
    const old = new Date(Date.now() - 3 * 3600_000);
    await utimes(join(app.storageDir, `${id}.extraction`), old, old);
    await utimes(join(app.storageDir, `${id}.media`), old, old);
    expect((await app.service.sweep()).orphans).toBe(2);
    expect(await app.files()).toEqual([]);
  });
  it('a server restart (startup purge) leaves no extraction assets behind', async () => {
    app = await startTestApp({ extraction: {} });
    const id = await send('sample.mp4');
    await waitForExtraction(app, id);
    expect(await extractionDirs()).toHaveLength(1);
    await app.service.start();
    expect(await app.files()).toEqual([]);
  });
  it('a failed extraction (timeout) leaves no partial output', async () => {
    app = await startTestApp({ extraction: { extractor: hanging(), limits: { timeoutMs: 150 } } });
    const id = await send('sample.mp4');
    const e = await waitForExtraction(app, id);
    expect(e.errors[0]).toMatchObject({ code: 'timeout', fatal: true });
    await eventually(async () => (await extractionDirs()).length === 0);
    expect(await app.files()).toEqual([`${id}.media`]); // media itself stays ready
  });
  it('storage refuses artifact names that are not server-generated', async () => {
    app = await startTestApp();
    const id = await send('sample.mp4');
    for (const bad of ['../x.jpg', 'frames/../../x.jpg', '/etc/passwd', 'frames/a b.jpg', 'audio/aud-0.exe', 'other/x.jpg']) {
      expect(() => app.storage.readArtifact(id, bad)).toThrow();
      await expect(app.storage.deleteArtifact(id, bad)).rejects.toThrow();
    }
  });
});

describe.skipIf(!hasFfmpeg)('resource limits (real FFmpeg)', () => {
  it('fails safely when a track exceeds the audio output limit', async () => {
    app = await startTestApp({ extraction: { limits: { maxAudioBytes: 20_000 } } });
    const e = await waitForExtraction(app, await send('multi.mkv'));
    expect(e).toMatchObject({ status: 'failed', errors: [{ code: 'limit-exceeded', stage: 'audio', fatal: true }], audio: [], frames: null });
    await eventually(async () => (await extractionDirs()).length === 0);
  });
  it('a long, high-resolution source cannot explode: frames are capped in count, size and dimensions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sw-long-'));
    const file = join(dir, 'long.mp4');
    generateVideo(file, { width: 1920, height: 1080, seconds: 60, fps: 2, audio: true });
    app = await startTestApp({ extraction: { limits: { frame: { intervalSeconds: 1, maxFrames: 6, maxWidth: 320, maxHeight: 320 } } } });
    const { media } = (await (await upload(app, new Uint8Array(await readFile(file)), 'long.mp4')).json()) as MediaResponse;
    await rm(dir, { recursive: true, force: true });
    const e = await waitForExtraction(app, media.asset.id);
    expect(e.status).toBe('completed');
    expect(e.frames!.frames).toHaveLength(6); // 1 frame/s would be 60; the cap wins
    expect(e.frames!.effectiveIntervalSeconds).toBeCloseTo(10, 0);
    expect(e.frames!.frames.every((f) => f.width <= 320 && f.height <= 320)).toBe(true);
    expect(e.frames!.frames[0]).toMatchObject({ width: 320, height: 180 });
    expect(e.frames!.totalSizeBytes).toBeLessThan(6 * 100_000);
  });
});

import { PENDING_METADATA } from '@/domain/media/asset';
import { normalizeMetadata } from '@/domain/media/metadata';
import { HEADERS, makeFile } from '@/test/files';
import { MediaIngestionError } from '@/domain/media/errors';
import { createMediaIngestion } from './mediaIngestion';
import type { MediaUploader } from './mediaUploader';
import type { MediaProcessor } from './mediaProcessor';

const MB = 1024 * 1024;
/** Extraction that never reports: keeps these tests about upload behaviour only. */
const neverSettles = () => new Promise<never>(() => undefined);
const okProcessor: MediaProcessor = {
  extractMetadata: async () => normalizeMetadata({ durationSeconds: 60, width: 1280, height: 720 }, 'browser'),
};
const make = (processor: MediaProcessor = okProcessor, maxBytes = 10 * MB) =>
  createMediaIngestion({ processor, maxBytes, newId: () => 'id-1', now: () => new Date('2026-01-01T00:00:00Z') });

// These tests use fake processors only: no browser, FFmpeg or filesystem involved.
describe('createMediaIngestion.accept', () => {
  it('creates an accepted asset from a valid file with detected type and sanitised name', async () => {
    const asset = await make().accept(makeFile('../my;clip.mp4', HEADERS.mp4));
    expect(asset).toEqual({
      id: 'id-1', filename: 'my_clip.mp4', mimeType: 'video/mp4', container: 'mp4', typeLabel: 'MP4 video',
      sizeBytes: HEADERS.mp4.length, status: 'accepted', metadata: PENDING_METADATA,
      createdAt: '2026-01-01T00:00:00.000Z', failure: null,
    });
  });
  it('accepts MKV reported with an empty MIME type', async () => {
    const asset = await make().accept(makeFile('film.mkv', HEADERS.matroska, ''));
    expect(asset.container).toBe('matroska');
  });
  it.each([
    ['bad extension', makeFile('a.txt', HEADERS.mp4), 'unsupported-type'],
    ['bad MIME', makeFile('a.mp4', HEADERS.mp4, 'text/html'), 'unsupported-type'],
    ['oversized', makeFile('a.mp4', HEADERS.mp4, 'video/mp4', 11 * MB), 'file-too-large'],
    ['empty', makeFile('a.mp4', new Uint8Array(0)), 'empty-file'],
    ['HTML renamed to .mp4', makeFile('a.mp4', HEADERS.html), 'invalid-media'],
    ['AVI bytes with .mp4 name', makeFile('a.mp4', HEADERS.avi), 'invalid-media'],
  ])('rejects %s', async (_n, file, code) => {
    await expect(make().accept(file)).rejects.toMatchObject({ name: 'MediaIngestionError', code });
  });
  it('does not read file content when cheap checks already fail', async () => {
    const file = makeFile('a.txt', HEADERS.mp4);
    const slice = vi.spyOn(file, 'slice');
    await make().accept(file).catch(() => undefined);
    expect(slice).not.toHaveBeenCalled();
  });
  it('reads only the leading bytes of the file', async () => {
    const file = makeFile('a.mp4', HEADERS.mp4);
    const slice = vi.spyOn(file, 'slice');
    await make().accept(file);
    expect(slice).toHaveBeenCalledWith(0, 64);
  });
  it('reports processing-failed when the file cannot be read', async () => {
    const file = makeFile('a.mp4', HEADERS.mp4);
    vi.spyOn(file, 'slice').mockReturnValue({ arrayBuffer: () => Promise.reject(new Error('NotReadableError')) } as unknown as Blob);
    await expect(make().accept(file)).rejects.toMatchObject({ code: 'processing-failed' });
  });
});

describe('createMediaIngestion.prepare', () => {
  it('attaches processor metadata to the asset', async () => {
    const ingestion = make();
    const file = makeFile('a.mp4', HEADERS.mp4);
    const prepared = await ingestion.prepare(file, await ingestion.accept(file));
    expect(prepared.asset.metadata).toMatchObject({ availability: 'available', durationSeconds: 60, width: 1280 });
    expect(prepared.analysis).toBe('not_started');
  });
  it('treats unavailable metadata as success, not failure', async () => {
    const processor: MediaProcessor = { extractMetadata: async () => normalizeMetadata({}, 'browser', 'unsupported-by-browser') };
    const ingestion = make(processor);
    const file = makeFile('a.mkv', HEADERS.matroska, '');
    const prepared = await ingestion.prepare(file, await ingestion.accept(file));
    expect(prepared.asset.metadata).toMatchObject({ availability: 'unavailable', unavailableReason: 'unsupported-by-browser' });
  });
  it('maps unexpected processor errors to a typed failure without leaking details', async () => {
    const processor: MediaProcessor = { extractMetadata: async () => { throw new Error('ENOENT /secret/path'); } };
    const ingestion = make(processor);
    const file = makeFile('a.mp4', HEADERS.mp4);
    const accepted = await ingestion.accept(file);
    const err = await ingestion.prepare(file, accepted).catch((e: Error) => e);
    expect(err).toMatchObject({ code: 'processing-failed' });
    expect((err as Error).message).not.toContain('secret');
  });
});

describe('createMediaIngestion with a server uploader', () => {
  const remoteAsset = (patch = {}) => ({
    id: 'server-id', filename: 'a.mp4', mimeType: 'video/mp4', container: 'mp4' as const, typeLabel: 'MP4 video', sizeBytes: 5,
    status: 'ready' as const, metadata: normalizeMetadata({ durationSeconds: 1, width: 2, height: 2 }, 'ffprobe'), createdAt: 'x', failure: null, ...patch,
  });
  const make = (uploader: MediaUploader) => createMediaIngestion({ uploader, maxBytes: 10 * MB });

  it('reports server mode and still validates on the client first', async () => {
    const uploader: MediaUploader = { upload: vi.fn(), waitForExtraction: neverSettles, remove: vi.fn() };
    const ingestion = make(uploader);
    expect(ingestion.mode).toBe('server');
    await expect(ingestion.accept(makeFile('a.txt', HEADERS.mp4))).rejects.toMatchObject({ code: 'unsupported-type' });
    expect(uploader.upload).not.toHaveBeenCalled();
  });
  it('uploads, forwards progress, and returns the server asset and analysis status', async () => {
    const upload = vi.fn(async (_f: File, h?: { onProgress?: (n: number) => void }) => { h?.onProgress?.(0.5); return { asset: remoteAsset(), analysis: { status: 'not_started' as const }, extraction: { status: 'queued' as const, phase: null } }; });
    const ingestion = make({ upload, waitForExtraction: neverSettles, remove: vi.fn() });
    const file = makeFile('a.mp4', HEADERS.mp4);
    const onProgress = vi.fn();
    const prepared = await ingestion.prepare(file, await ingestion.accept(file), { onProgress });
    expect(prepared).toMatchObject({ asset: { id: 'server-id', status: 'ready' }, analysis: 'not_started' });
    expect(onProgress).toHaveBeenCalledWith(0.5);
  });
  it('turns a server-side failed asset into a typed error', async () => {
    const failed = remoteAsset({ status: 'failed', failure: { code: 'invalid-media' } });
    const ingestion = make({ upload: async () => ({ asset: failed, analysis: { status: 'not_started' }, extraction: { status: 'queued', phase: null } }), waitForExtraction: neverSettles, remove: vi.fn() });
    const file = makeFile('a.mp4', HEADERS.mp4);
    await expect(ingestion.prepare(file, await ingestion.accept(file))).rejects.toMatchObject({ code: 'invalid-media' });
  });
  it('preserves typed upload errors and maps unknown ones', async () => {
    const file = makeFile('a.mp4', HEADERS.mp4);
    const busy = make({ upload: async () => { throw new MediaIngestionError('server-busy'); }, waitForExtraction: neverSettles, remove: vi.fn() });
    await expect(busy.prepare(file, await busy.accept(file))).rejects.toMatchObject({ code: 'server-busy' });
    const weird = make({ upload: async () => { throw new TypeError('boom'); }, waitForExtraction: neverSettles, remove: vi.fn() });
    await expect(weird.prepare(file, await weird.accept(file))).rejects.toMatchObject({ code: 'processing-failed' });
  });
  it('removes server data through the uploader', async () => {
    const remove = vi.fn(async () => undefined);
    await make({ upload: vi.fn(), waitForExtraction: neverSettles, remove }).remove(remoteAsset());
    expect(remove).toHaveBeenCalledWith('server-id');
  });
});

import type { MediaResource } from '@/domain/api/contract';
import { PENDING_METADATA, type MediaAsset } from '@/domain/media/asset';
import { HttpMediaUploader } from './httpMediaUploader';

const asset = (status: MediaAsset['status'], extra: Partial<MediaAsset> = {}): MediaAsset => ({
  id: 'srv-1', filename: 'a.mp4', mimeType: 'video/mp4', container: 'mp4', typeLabel: 'MP4 video', sizeBytes: 5,
  status, metadata: PENDING_METADATA, createdAt: 'x', failure: null, ...extra,
});
const resource = (status: MediaAsset['status'], extra: Partial<MediaAsset> = {}): MediaResource => ({ asset: asset(status, extra), analysis: { status: 'not_started' } });

class FakeXhr {
  static last: FakeXhr;
  method = ''; url = ''; headers: Record<string, string> = {}; body: unknown; status = 0; responseText = '';
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null; onerror: (() => void) | null = null; ontimeout: (() => void) | null = null; onabort: (() => void) | null = null;
  constructor() { FakeXhr.last = this; }
  open(m: string, u: string) { this.method = m; this.url = u; }
  setRequestHeader(k: string, v: string) { this.headers[k.toLowerCase()] = v; }
  send(b: unknown) { this.body = b; }
  abort() { this.onabort?.(); }
  respond(status: number, body: unknown) { this.status = status; this.responseText = typeof body === 'string' ? body : JSON.stringify(body); this.onload?.(); }
}

const file = new File(['x'], 'my ../clip;.mp4', { type: 'video/mp4' });
const make = (o = {}) => new HttpMediaUploader({ baseUrl: 'http://api.test', pollIntervalMs: 1, pollTimeoutMs: 500, ...o });

beforeEach(() => { vi.stubGlobal('XMLHttpRequest', FakeXhr); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('HttpMediaUploader', () => {
  it('posts the raw file with a sanitised, encoded filename header and no multipart wrapper', async () => {
    const p = make().upload(file);
    const x = FakeXhr.last;
    expect(x.method).toBe('POST');
    expect(x.url).toBe('http://api.test/api/media');
    expect(x.body).toBe(file);
    expect(x.headers['content-type']).toBe('video/mp4');
    expect(decodeURIComponent(x.headers['x-safewatch-filename']!)).toBe('clip_.mp4');
    x.respond(202, { media: resource('ready') });
    await expect(p).resolves.toMatchObject({ asset: { status: 'ready' } });
  });
  it('omits Content-Type when the browser reports none (e.g. MKV)', () => {
    void make().upload(new File(['x'], 'a.mkv', { type: '' }));
    expect(FakeXhr.last.headers['content-type']).toBeUndefined();
  });
  it('reports real progress from upload events and ignores non-measurable ones', () => {
    const onProgress = vi.fn();
    void make().upload(file, { onProgress });
    FakeXhr.last.upload.onprogress?.({ lengthComputable: true, loaded: 25, total: 100 });
    FakeXhr.last.upload.onprogress?.({ lengthComputable: false, loaded: 50, total: 0 });
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenCalledWith(0.25);
  });
  it('polls until the server reports ready', async () => {
    const statuses = ['processing', 'processing', 'ready'];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ media: resource(statuses.shift() as MediaAsset['status']) }), { status: 200 })));
    const p = make().upload(file);
    FakeXhr.last.respond(202, { media: resource('uploaded') });
    await expect(p).resolves.toMatchObject({ asset: { status: 'ready' } });
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it('returns a failed asset so the caller can map its failure code', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ media: resource('failed', { failure: { code: 'invalid-media' } }) }), { status: 200 })));
    const p = make().upload(file);
    FakeXhr.last.respond(202, { media: resource('processing') });
    await expect(p).resolves.toMatchObject({ asset: { status: 'failed', failure: { code: 'invalid-media' } } });
  });
  it.each([
    [415, 'UNSUPPORTED_MEDIA', 'unsupported-type'],
    [413, 'FILE_TOO_LARGE', 'file-too-large'],
    [503, 'SERVER_BUSY', 'server-busy'],
    [504, 'PROCESSING_TIMEOUT', 'timeout'],
    [500, 'STORAGE_FAILED', 'storage-failure'],
  ])('maps HTTP %i %s to %s', async (status, apiCode, mediaCode) => {
    const p = make().upload(file);
    FakeXhr.last.respond(status, { error: { code: apiCode, message: 'x', requestId: 'r' } });
    await expect(p).rejects.toMatchObject({ code: mediaCode });
  });
  it('maps an unparseable or unknown error body to processing-failed without surfacing it', async () => {
    const p = make().upload(file);
    FakeXhr.last.respond(500, '<html>Internal stack trace at /srv/app.js</html>');
    const err = await p.catch((e: Error) => e);
    expect(err).toMatchObject({ code: 'processing-failed' });
    expect((err as Error).message).not.toContain('/srv');
  });
  it.each([
    [502, 'server-unreachable'], [503, 'server-unreachable'], [504, 'server-unreachable'],
    [413, 'file-too-large'], [429, 'server-busy'], [500, 'processing-failed'],
  ])('maps a non-API (gateway) HTTP %i response with no JSON body to %s', async (status, code) => {
    const p = make().upload(file);
    FakeXhr.last.respond(status, '');
    await expect(p).rejects.toMatchObject({ code });
  });
  it('distinguishes an unreachable server from an interrupted upload', async () => {
    const a = make().upload(file);
    FakeXhr.last.onerror?.();
    await expect(a).rejects.toMatchObject({ code: 'server-unreachable' });
    const b = make().upload(file);
    FakeXhr.last.upload.onprogress?.({ lengthComputable: true, loaded: 10, total: 100 });
    FakeXhr.last.onerror?.();
    await expect(b).rejects.toMatchObject({ code: 'upload-failed' });
  });
  it('aborts the request when the signal fires', async () => {
    const ac = new AbortController();
    const p = make().upload(file, { signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: 'upload-failed' });
  });
  it('gives up polling after the timeout with a typed error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ media: resource('processing') }), { status: 200 })));
    const p = make({ pollTimeoutMs: 30 }).upload(file);
    FakeXhr.last.respond(202, { media: resource('processing') });
    await expect(p).rejects.toMatchObject({ code: 'timeout' });
  });
  it('reports server-unreachable after repeated polling failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network'); }));
    const p = make().upload(file);
    FakeXhr.last.respond(202, { media: resource('processing') });
    await expect(p).rejects.toMatchObject({ code: 'server-unreachable' });
  });
  it('remove() issues DELETE and never rejects', async () => {
    const f = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', f);
    await make().remove('abc');
    expect(f).toHaveBeenCalledWith('http://api.test/api/media/abc', expect.objectContaining({ method: 'DELETE' }));
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    await expect(make().remove('abc')).resolves.toBeUndefined();
  });
});

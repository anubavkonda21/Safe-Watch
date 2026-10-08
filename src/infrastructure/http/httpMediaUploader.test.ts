import type { MediaResource } from '@/domain/api/contract';
import { PENDING_METADATA, type MediaAsset } from '@/domain/media/asset';
import { HttpMediaUploader } from './httpMediaUploader';
import { completedExtraction, processingExtraction } from '@/test/extraction';
import { processingTextAnalysis, readyTextAnalysis } from '@/test/textAnalysis';
import { processingVisual, readyVisual } from '@/test/visualAnalysis';
import { failVisual } from '@/domain/vision/visualAnalysis';

const asset = (status: MediaAsset['status'], extra: Partial<MediaAsset> = {}): MediaAsset => ({
  id: 'srv-1', filename: 'a.mp4', mimeType: 'video/mp4', container: 'mp4', typeLabel: 'MP4 video', sizeBytes: 5,
  status, metadata: PENDING_METADATA, createdAt: 'x', failure: null, ...extra,
});
const resource = (status: MediaAsset['status'], extra: Partial<MediaAsset> = {}): MediaResource => ({ asset: asset(status, extra), analysis: { status: 'not_started' }, extraction: { status: 'queued', phase: null }, text: { status: 'not_started', phase: null }, visual: { status: 'not_started', phase: null, progress: null } });

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

  describe('waitForExtraction', () => {
    const respond = (e: unknown) => new Response(JSON.stringify({ extraction: e }), { status: 200 });
    it('polls the extraction endpoint, reports each status/phase change once, and resolves when completed', async () => {
      const seq = [processingExtraction('srv-1', 'extracting-audio'), processingExtraction('srv-1', 'extracting-audio'), processingExtraction('srv-1', 'sampling-frames'), completedExtraction('srv-1')];
      const f = vi.fn(async () => respond(seq.shift()));
      vi.stubGlobal('fetch', f);
      const onUpdate = vi.fn();
      const result = await make().waitForExtraction('srv-1', { onUpdate });
      expect(result.status).toBe('completed');
      expect(onUpdate.mock.calls.map((c) => `${c[0].status}:${c[0].phase}`)).toEqual(['processing:extracting-audio', 'processing:sampling-frames', 'completed:null']);
      expect(f).toHaveBeenCalledWith('http://api.test/api/media/srv-1/extraction', expect.anything());
    });
    it('returns a failed extraction as a value (the caller shows it)', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => respond({ ...completedExtraction('srv-1'), status: 'failed', errors: [{ code: 'timeout', stage: 'frames', fatal: true, streamIndex: null }] })));
      await expect(make().waitForExtraction('srv-1')).resolves.toMatchObject({ status: 'failed' });
    });
    it('gives up with a typed timeout', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => respond(processingExtraction('srv-1', 'preparing'))));
      await expect(make({ extractionTimeoutMs: 30 }).waitForExtraction('srv-1')).rejects.toMatchObject({ code: 'timeout' });
    });
    it('reports server-unreachable after repeated network failures and maps HTTP errors', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network'); }));
      await expect(make().waitForExtraction('srv-1')).rejects.toMatchObject({ code: 'server-unreachable' });
      vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 502 })));
      await expect(make().waitForExtraction('srv-1')).rejects.toMatchObject({ code: 'server-unreachable' });
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'x', requestId: 'r' } }), { status: 404 })));
      await expect(make().waitForExtraction('srv-1')).rejects.toMatchObject({ code: 'processing-failed' });
    });
    it('stops when aborted', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => respond(processingExtraction('srv-1', 'preparing'))));
      const ac = new AbortController();
      const p = make().waitForExtraction('srv-1', { signal: ac.signal });
      ac.abort();
      await expect(p).rejects.toMatchObject({ code: 'upload-failed' });
    });
  });

  describe('waitForVisualAnalysis', () => {
    const respond = (v: unknown) => new Response(JSON.stringify({ visualAnalysis: v }), { status: 200 });
    it('polls the slim form, reports each change once (including frame progress), then fetches the full result when ready', async () => {
      const urls: string[] = [];
      const seq = [
        processingVisual('srv-1', 'analyzing-frames', { framesDone: 0, framesTotal: 4 }), processingVisual('srv-1', 'analyzing-frames', { framesDone: 0, framesTotal: 4 }),
        processingVisual('srv-1', 'analyzing-frames', { framesDone: 2, framesTotal: 4 }), processingVisual('srv-1', 'building-timeline'), readyVisual('srv-1'), readyVisual('srv-1'),
      ];
      vi.stubGlobal('fetch', vi.fn(async (u: string) => { urls.push(u); return respond(seq.shift()); }));
      const onUpdate = vi.fn();
      const result = await make().waitForVisualAnalysis('srv-1', { onUpdate });
      expect(result.status).toBe('ready');
      expect(result.observations.length).toBeGreaterThan(0);
      expect(onUpdate.mock.calls.map((c) => `${c[0].status}:${c[0].phase}:${c[0].progress?.framesDone ?? '-'}`)).toEqual(['processing:analyzing-frames:0', 'processing:analyzing-frames:2', 'processing:building-timeline:-', 'ready:null:-']);
      expect(urls.slice(0, 5).every((u) => u.endsWith('/api/media/srv-1/visual?observations=false'))).toBe(true);
      expect(urls.at(-1)).toBe('http://api.test/api/media/srv-1/visual');
    });
    it('returns a failed analysis as a value without a second request', async () => {
      const f = vi.fn(async () => respond(failVisual(processingVisual('srv-1', 'preparing'), { code: 'server-busy', stage: 'queue', fatal: true, count: 0 }, 'x')));
      vi.stubGlobal('fetch', f);
      await expect(make().waitForVisualAnalysis('srv-1')).resolves.toMatchObject({ status: 'failed' });
      expect(f).toHaveBeenCalledTimes(1);
    });
    it('times out, reports an unreachable server, maps gateway errors, and stops on abort', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => respond(processingVisual('srv-1', 'preparing'))));
      await expect(make({ extractionTimeoutMs: 30 }).waitForVisualAnalysis('srv-1')).rejects.toMatchObject({ code: 'timeout' });
      vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network'); }));
      await expect(make().waitForVisualAnalysis('srv-1')).rejects.toMatchObject({ code: 'server-unreachable' });
      vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })));
      await expect(make().waitForVisualAnalysis('srv-1')).rejects.toMatchObject({ code: 'server-unreachable' });
      vi.stubGlobal('fetch', vi.fn(async () => respond(processingVisual('srv-1', 'preparing'))));
      const ac = new AbortController();
      const p = make().waitForVisualAnalysis('srv-1', { signal: ac.signal });
      ac.abort();
      await expect(p).rejects.toMatchObject({ code: 'upload-failed' });
    });
  });

  describe('waitForTextAnalysis', () => {
    const respond = (t: unknown) => new Response(JSON.stringify({ textAnalysis: t }), { status: 200 });
    it('polls the slim transcript, reports each change once, then fetches the full result (with word timestamps) when ready', async () => {
      const urls: string[] = [];
      const seq = [processingTextAnalysis('srv-1', 'speech-processing'), processingTextAnalysis('srv-1', 'speech-processing'), processingTextAnalysis('srv-1', 'building-timeline'), readyTextAnalysis('srv-1'), readyTextAnalysis('srv-1')];
      vi.stubGlobal('fetch', vi.fn(async (u: string) => { urls.push(u); return respond(seq.shift()); }));
      const onUpdate = vi.fn();
      const result = await make().waitForTextAnalysis('srv-1', { onUpdate });
      expect(result.status).toBe('ready');
      expect(onUpdate.mock.calls.map((c) => `${c[0].status}:${c[0].phase}`)).toEqual(['processing:speech-processing', 'processing:building-timeline', 'ready:null']);
      expect(urls.slice(0, 4).every((u) => u.endsWith('/api/media/srv-1/transcript?words=false'))).toBe(true);
      expect(urls.at(-1)).toBe('http://api.test/api/media/srv-1/transcript');
    });
    it('returns a failed analysis as a value without a second request', async () => {
      const f = vi.fn(async () => respond({ ...processingTextAnalysis('srv-1', null), status: 'failed', issues: [{ code: 'server-busy', stage: 'queue', fatal: true, trackId: null }] }));
      vi.stubGlobal('fetch', f);
      await expect(make().waitForTextAnalysis('srv-1')).resolves.toMatchObject({ status: 'failed' });
      expect(f).toHaveBeenCalledTimes(1);
    });
    it('times out, reports an unreachable server, maps gateway errors, and stops on abort', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => respond(processingTextAnalysis('srv-1', 'preparing'))));
      await expect(make({ extractionTimeoutMs: 30 }).waitForTextAnalysis('srv-1')).rejects.toMatchObject({ code: 'timeout' });
      vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network'); }));
      await expect(make().waitForTextAnalysis('srv-1')).rejects.toMatchObject({ code: 'server-unreachable' });
      vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })));
      await expect(make().waitForTextAnalysis('srv-1')).rejects.toMatchObject({ code: 'server-unreachable' });
      vi.stubGlobal('fetch', vi.fn(async () => respond(processingTextAnalysis('srv-1', 'preparing'))));
      const ac = new AbortController();
      const p = make().waitForTextAnalysis('srv-1', { signal: ac.signal });
      ac.abort();
      await expect(p).rejects.toMatchObject({ code: 'upload-failed' });
    });
  });
});

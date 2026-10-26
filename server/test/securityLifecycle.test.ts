import { connect } from 'node:net';
import type { ApiErrorBody, MediaResponse } from '@/domain/api/contract';
import type { MediaExtractor } from '../src/application/extractionPorts';
import type { SpeechToTextProvider } from '../src/application/speechPorts';
import { ProcessingQueue } from '../src/application/processingQueue';
import { eventually, fixture, startTestApp, upload, waitForExtraction, waitForStatus, type TestApp } from './helpers';
import { cookieOf, forgetCookies } from './security';

let app: TestApp;
afterEach(async () => { await app?.close(); forgetCookies(); });

const mp4 = () => new Uint8Array(fixture('sample.mp4'));
const SIZE = mp4().length;
const as = (cookie: string, extra: Record<string, string> = {}) => ({ 'x-test-no-jar': '1', cookie, ...extra });
const json = { 'content-type': 'application/json' };

/** An extractor that never finishes on its own: it waits for the abort signal, like a hung FFmpeg. */
function hungExtractor(calls: { inspect: number }): MediaExtractor {
  const hang = (signal: AbortSignal) => new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  return { inspect: async (_i, signal) => { calls.inspect += 1; return hang(signal); }, extractAudio: async () => { throw new Error('x'); }, extractSubtitleCues: async () => [], sampleFrame: async () => null };
}

describe('job state and duplicates', () => {
  it('scheduling the same media again starts no second job', async () => {
    const calls = { inspect: 0 };
    app = await startTestApp({ extraction: { extractor: hungExtractor(calls) } });
    const res = await upload(app, mp4(), 'a.mp4');
    const id = ((await res.json()) as MediaResponse).media.asset.id;
    await eventually(() => calls.inspect === 1);
    for (let i = 0; i < 5; i++) app.extraction!.schedule(id);
    await new Promise((r) => setTimeout(r, 100));
    expect(calls.inspect).toBe(1);
    app.extraction!.cancelAll();
  });
  it('the media state machine rejects illegal transitions, so a duplicate job cannot corrupt a finished item', async () => {
    app = await startTestApp();
    const res = await upload(app, mp4(), 'a.mp4');
    const id = ((await res.json()) as MediaResponse).media.asset.id;
    await waitForStatus(app, id, ['ready']);
    const before = JSON.stringify(app.repository.get(id)!.asset);
    // A second processing pass over a ready item does nothing.
    (app.service as unknown as { startProcessing(id: string, r: string): void }).startProcessing(id, 'dup');
    await new Promise((r) => setTimeout(r, 100));
    expect(JSON.stringify(app.repository.get(id)!.asset)).toBe(before);
  });
  it('an unexpected throw in processing ends in failed (never stuck running) and frees its files and quota', async () => {
    app = await startTestApp({ processor: { extractMetadata: async () => { throw 'a string, not an Error'; }, verifyDecodable: async () => undefined } });
    const res = await upload(app, mp4(), 'a.mp4');
    const id = ((await res.json()) as MediaResponse).media.asset.id;
    const media = await waitForStatus(app, id, ['failed']);
    expect(media.asset.failure).toEqual({ code: 'processing-failed' });
    await eventually(async () => (await app.files()).length === 0 && app.quota.usage().items === 0);
  });
  it('a processing timeout ends in failed with the timeout code and releases everything', async () => {
    app = await startTestApp({ processingTimeoutMs: 50, processor: { extractMetadata: (_i, o) => new Promise((_, rej) => o?.signal?.addEventListener('abort', () => rej(new Error('x')))), verifyDecodable: async () => undefined } });
    const id = ((await (await upload(app, mp4(), 'a.mp4')).json()) as MediaResponse).media.asset.id;
    const media = await waitForStatus(app, id, ['failed']);
    expect(media.asset.failure).toEqual({ code: 'timeout' });
    await eventually(() => app.quota.usage().items === 0);
  });
});

describe('overload', () => {
  it('ProcessingQueue is bounded: running + waiting never exceed the limits, and capacity returns', async () => {
    const q = new ProcessingQueue(1, 2);
    const release: Array<() => void> = [];
    const jobs = Array.from({ length: 3 }, () => q.run(() => new Promise<void>((r) => release.push(r))));
    expect(q.activeCount).toBe(1); expect(q.queuedCount).toBe(2);
    expect(q.hasCapacity()).toBe(false);
    while (release.length) { release.shift()!(); await new Promise((r) => setTimeout(r, 0)); }
    await Promise.all(jobs);
    expect(q.hasCapacity()).toBe(true);
    expect(q.activeCount + q.queuedCount).toBe(0);
  });
  it('a full queue answers 503 SERVER_BUSY with Retry-After and keeps nothing', async () => {
    const gate: Array<() => void> = [];
    app = await startTestApp({ maxConcurrentProcessing: 1, maxQueuedProcessing: 0, processor: { extractMetadata: () => new Promise((r) => gate.push(() => r({} as never))), verifyDecodable: async () => undefined } });
    const first = await upload(app, mp4(), 'a.mp4');
    expect(first.status).toBe(202);
    await eventually(() => gate.length === 1);
    const busy = await upload(app, mp4(), 'b.mp4');
    expect(busy.status).toBe(503);
    expect(busy.headers.get('retry-after')).toBe('5');
    expect(((await busy.json()) as ApiErrorBody).error.code).toBe('SERVER_BUSY');
    expect(app.quota.usage().items).toBe(1);
    expect((await app.files()).length).toBe(1);
    gate.forEach((g) => g());
  });
  it('too many simultaneous uploads are refused, not queued without bound', async () => {
    app = await startTestApp({ maxConcurrentUploads: 1 });
    const u = new URL(app.url);
    const hold = connect(Number(u.port), u.hostname);
    await new Promise<void>((r) => hold.on('connect', () => r()));
    hold.write(`POST /api/media HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: video/mp4\r\nX-SafeWatch-Filename: a.mp4\r\nContent-Length: ${SIZE}\r\n\r\n`);
    hold.write(Buffer.from(mp4().subarray(0, 64)));
    await eventually(async () => (await app.files()).length === 1);
    const second = await upload(app, mp4(), 'b.mp4', 'video/mp4', { 'x-test-no-jar': '1' });
    expect(second.status).toBe(503);
    hold.destroy();
    await eventually(async () => (await app.files()).length === 0 && app.quota.usage().items === 0);
  });
});

describe('shutdown', () => {
  it('stops accepting uploads, cancels running jobs, and leaves failed (not running) state with partial output removed', async () => {
    const calls = { inspect: 0 };
    app = await startTestApp({ extraction: { extractor: hungExtractor(calls) } });
    const id = ((await (await upload(app, mp4(), 'a.mp4')).json()) as MediaResponse).media.asset.id;
    await eventually(() => calls.inspect === 1);
    app.service.shutdown();
    const manifest = await waitForExtraction(app, id);
    expect(manifest.status).toBe('failed');
    expect(manifest.errors[0]).toMatchObject({ code: 'cancelled' });
    const refused = await upload(app, mp4(), 'b.mp4');
    expect(refused.status).toBe(503);
    expect((await app.files()).filter((f) => f.endsWith('.extraction'))).toEqual([]);
  });
  it('purge after shutdown removes everything, and doing it again (or sweeping) is harmless', async () => {
    app = await startTestApp();
    const id = ((await (await upload(app, mp4(), 'a.mp4')).json()) as MediaResponse).media.asset.id;
    await waitForStatus(app, id, ['ready']);
    app.service.shutdown();
    expect((await app.storage.purge()).removed).toBe(1);
    expect((await app.storage.purge()).removed).toBe(0);
    await expect(app.service.sweep()).resolves.toBeDefined();
    await expect(app.service.sweep()).resolves.toBeDefined();
    expect(await app.files()).toEqual([]);
  });
  it('cancelling a text-analysis job that is running aborts it and does not hang', async () => {
    let aborted = false;
    let started = false;
    const speech: SpeechToTextProvider = { info: { name: 'x', model: 'x' }, isAvailable: async () => true, transcribe: (_i, r) => new Promise((_, rej) => { started = true; r.signal.addEventListener('abort', () => { aborted = true; rej(new Error('aborted')); }); }) };
    app = await startTestApp({ extraction: {}, speech: { provider: speech } });
    const id = ((await (await upload(app, new Uint8Array(fixture('speech-en-in.mp4')), 'a.mp4')).json()) as MediaResponse).media.asset.id;
    await waitForExtraction(app, id);
    await eventually(() => started, 60_000); // wait for the job itself, not for a wall-clock guess
    app.service.shutdown();
    await eventually(() => aborted);
  });
});

describe('expiry and cleanup', () => {
  it('the sweep removes expired media, files and accounting, and never touches live media', async () => {
    app = await startTestApp({ retentionMs: 60_000 });
    const a = ((await (await upload(app, mp4(), 'a.mp4')).json()) as MediaResponse).media.asset.id;
    await waitForStatus(app, a, ['ready']);
    app.clock.now += 30_000;
    const b = ((await (await upload(app, mp4(), 'b.mp4')).json()) as MediaResponse).media.asset.id;
    await waitForStatus(app, b, ['ready']);
    app.clock.now += 40_000; // a is 70 s old (expired), b is 40 s old (live)
    expect((await app.service.sweep()).expired).toBe(1);
    expect(app.repository.get(a)).toBeUndefined();
    expect(app.repository.get(b)).toBeDefined();
    expect(app.quota.bytesOf(a)).toBeUndefined();
    expect(app.quota.bytesOf(b)).toBe(SIZE);
    expect((await app.files()).some((f) => f.startsWith(b))).toBe(true);
    expect((await app.files()).some((f) => f.startsWith(a))).toBe(false);
  });
  it('expiry cancels a job that is still running on that media', async () => {
    const calls = { inspect: 0 };
    app = await startTestApp({ retentionMs: 1000, extraction: { extractor: hungExtractor(calls) } });
    await upload(app, mp4(), 'a.mp4');
    await eventually(() => calls.inspect === 1);
    app.clock.now += 5000;
    await app.service.sweep();
    await eventually(() => app.quota.usage().items === 0);
    expect(await app.files()).toEqual([]);
  });
  it('startup purge empties a directory left by a previous run (stale on-disk state)', async () => {
    app = await startTestApp();
    const id = ((await (await upload(app, mp4(), 'a.mp4')).json()) as MediaResponse).media.asset.id;
    await waitForStatus(app, id, ['ready']);
    await app.service.start(); // what main.ts does on boot: nothing in memory can refer to these files any more
    expect(await app.files()).toEqual([]);
  });
});

describe('request validation', () => {
  async function ready() {
    app = await startTestApp({ extraction: {} });
    const res = await upload(app, mp4(), 'a.mp4');
    const cookie = cookieOf(res)!;
    const id = ((await res.json()) as MediaResponse).media.asset.id;
    await waitForExtraction(app, id);
    const post = (body: BodyInit, headers: Record<string, string> = json) => fetch(`${app.url}/api/media/${id}/safety-findings`, { method: 'POST', headers: as(cookie, headers), body });
    return { id, cookie, post };
  }
  it.each([
    ['invalid JSON', '{"terms":'], ['not an object', '[]'], ['null', 'null'], ['a string', '"x"'], ['unknown top-level field', '{"terms":[],"path":"/etc/passwd"}'],
    ['terms not an array', '{"terms":"x"}'], ['term not an object', '{"terms":["x"]}'], ['unknown matchMode', '{"terms":[{"phrase":"x","matchMode":"regex"}]}'],
    ['matchMode wrong type', '{"terms":[{"phrase":"x","matchMode":1}]}'], ['phrase wrong type', '{"terms":[{"phrase":5,"matchMode":"exact"}]}'],
    ['extra term field', '{"terms":[{"phrase":"x","matchMode":"exact","enabled":true}]}'], ['missing phrase', '{"terms":[{"matchMode":"exact"}]}'],
    ['empty phrase', '{"terms":[{"phrase":"   ","matchMode":"exact"}]}'], ['phrase too long', `{"terms":[{"phrase":"${'a'.repeat(300)}","matchMode":"exact"}]}`],
    ['too many terms', JSON.stringify({ terms: Array.from({ length: 101 }, (_, i) => ({ phrase: `p${i}`, matchMode: 'exact' })) })],
    ['duplicate terms', '{"terms":[{"phrase":"x","matchMode":"exact"},{"phrase":"X","matchMode":"exact"}]}'],
    ['prototype pollution via __proto__', '{"terms":[],"__proto__":{"polluted":true}}'], ['prototype pollution in a term', '{"terms":[{"phrase":"x","matchMode":"exact","__proto__":{"a":1}}]}'],
    ['constructor key', '{"terms":[],"constructor":{"prototype":{"x":1}}}'],
  ])('%s is refused with 400 INVALID_REQUEST and nothing is changed', async (_n, body) => {
    const { post } = await ready();
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(((await res.json()) as ApiErrorBody).error.code).toBe('INVALID_REQUEST');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
  it('a body over the limit is refused without being read to the end', async () => {
    const { post } = await ready();
    const res = await post(JSON.stringify({ terms: [{ phrase: 'x', matchMode: 'exact' }], pad: 'y'.repeat(200_000) }));
    expect(res.status).toBe(400);
  });
  it('a well-formed request works and the response never echoes the phrase back in errors or logs', async () => {
    const { post } = await ready();
    const secretPhrase = 'zebra-unicorn-secret-phrase';
    const res = await post(JSON.stringify({ terms: [{ phrase: secretPhrase, matchMode: 'exact' }] }));
    expect(res.status).toBe(200);
    await post(JSON.stringify({ terms: [{ phrase: secretPhrase, matchMode: 'regex' }] }));
    expect(JSON.stringify(app.logs)).not.toContain(secretPhrase);
    expect(JSON.stringify(app.logs)).not.toContain('a.mp4'); // the filename is not logged either
  });
  it.each(['words=maybe', 'words=1', 'words=TRUE', 'words=', 'words=false&words=true', 'x=1', 'words=false&x=1'])('query ?%s on the transcript route is 400', async (q) => {
    const { id, cookie } = await ready();
    expect((await fetch(`${app.url}/api/media/${id}/transcript?${q}`, { headers: as(cookie) })).status).toBe(400);
  });
  it('queries are refused on routes that take none', async () => {
    const { id, cookie } = await ready();
    for (const p of [`/api/media/${id}?x=1`, `/api/media/${id}/extraction?x=1`, `/api/media/${id}/frames/frm-00000?x=1`]) {
      expect((await fetch(`${app.url}${p}`, { headers: as(cookie) })).status, p).toBe(400);
    }
    expect((await fetch(`${app.url}/api/media/${id}/transcript?words=false`, { headers: as(cookie) })).status).toBe(200);
  });
  it('wrong methods are 404, not a different handler', async () => {
    const { id, cookie } = await ready();
    for (const m of ['PUT', 'PATCH', 'POST']) expect((await fetch(`${app.url}/api/media/${id}`, { method: m, headers: as(cookie) })).status, m).toBe(404);
    expect((await fetch(`${app.url}/api/media/${id}/extraction`, { method: 'DELETE', headers: as(cookie) })).status).toBe(404);
  });
});

describe('error responses and logs never expose internals', () => {
  it('an internal exception becomes a generic 500: no message, path, stack or command line', async () => {
    app = await startTestApp();
    const { cookie } = app.newSession();
    app.repository.get = () => { throw new Error(`ffmpeg -i ${app.storageDir}/x.media failed at /Users/me/secret.ts:1\n    at stack`); };
    const res = await fetch(`${app.url}/api/media/00000000-0000-4000-8000-000000000000`, { headers: as(cookie) });
    const text = await res.text();
    expect(res.status).toBe(500);
    expect(JSON.parse(text).error.code).toBe('INTERNAL_ERROR');
    expect(text).not.toMatch(/ffmpeg|Users|secret|stack|storage|\.ts/);
    const logged = JSON.stringify(app.logs);
    expect(logged).not.toMatch(/Users\/me|secret\.ts|ffmpeg -i/);
    expect(app.logs.some((l) => l.msg === 'unhandled request error' && l.reason === 'Error')).toBe(true);
  });
  it('every error code has a fixed message with no variable parts', async () => {
    const { MESSAGE_FOR } = await import('../src/api/errors');
    for (const m of Object.values(MESSAGE_FOR)) expect(m).not.toMatch(/[/\\]|\bat\b.*:\d+|\$\{/);
  });
  it('access logs hold no media id, no cookie, no filename and no query string', async () => {
    app = await startTestApp({ extraction: {} });
    const res = await upload(app, mp4(), 'private-holiday.mp4');
    const cookie = cookieOf(res)!;
    const id = ((await res.json()) as MediaResponse).media.asset.id;
    await fetch(`${app.url}/api/media/${id}/transcript?words=false`, { headers: as(cookie) });
    const requestLogs = app.logs.filter((l) => l.msg === 'request');
    expect(requestLogs.length).toBeGreaterThan(0);
    for (const l of requestLogs) {
      expect(String(l.path)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
      expect(String(l.path)).not.toContain('?');
    }
    const all = JSON.stringify(app.logs);
    expect(all).not.toContain(cookie.split('=')[1]);
    expect(all).not.toContain('private-holiday');
  });
});

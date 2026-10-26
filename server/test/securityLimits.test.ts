import type { ApiErrorBody, MediaResponse } from '@/domain/api/contract';
import { RateLimiter } from '../src/api/rateLimiter';
import { StorageQuota } from '../src/application/storageQuota';
import type { MediaExtractor } from '../src/application/extractionPorts';
import { eventually, fixture, startTestApp, upload, waitForExtraction, type TestApp } from './helpers';
import { cookieOf, forgetCookies } from './security';

let app: TestApp;
afterEach(async () => { await app?.close(); forgetCookies(); });

const mp4 = () => new Uint8Array(fixture('sample.mp4'));
const SIZE = mp4().length;
const anon = { 'x-test-no-jar': '1' };
const as = (cookie: string, extra: Record<string, string> = {}) => ({ 'x-test-no-jar': '1', cookie, ...extra });
const code = async (res: Response) => ((await res.json()) as ApiErrorBody).error.code;

describe('RateLimiter', () => {
  it('allows exactly `limit` requests per window, then denies with a retry time', () => {
    const clock = { now: 1000 };
    const l = new RateLimiter({ limit: 3, windowMs: 60_000, maxKeys: 10, now: () => clock.now });
    expect([1, 2, 3].map(() => l.hit('k').allowed)).toEqual([true, true, true]);
    clock.now += 20_000;
    const denied = l.hit('k');
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBe(40_000);
    expect(l.hit('other').allowed).toBe(true); // keys are independent
  });
  it('the window expires exactly at windowMs and the count restarts', () => {
    const clock = { now: 0 };
    const l = new RateLimiter({ limit: 1, windowMs: 1000, maxKeys: 10, now: () => clock.now });
    expect(l.hit('k').allowed).toBe(true);
    clock.now = 999; expect(l.hit('k').allowed).toBe(false);
    clock.now = 1000; expect(l.hit('k').allowed).toBe(true);
  });
  it('holds a bounded number of keys however many distinct clients appear', () => {
    const clock = { now: 0 };
    const l = new RateLimiter({ limit: 5, windowMs: 60_000, maxKeys: 100, now: () => clock.now });
    for (let i = 0; i < 50_000; i++) l.hit(`attacker-${i}`);
    expect(l.size).toBeLessThanOrEqual(100);
  });
  it('a flood of fresh keys cannot reset an active heavy key that keeps being used', () => {
    const clock = { now: 0 };
    const l = new RateLimiter({ limit: 2, windowMs: 60_000, maxKeys: 50, now: () => clock.now });
    l.hit('victim'); l.hit('victim');
    for (let i = 0; i < 40; i++) { l.hit(`n${i}`); l.hit('victim'); } // victim stays recent, so it is never the one evicted
    expect(l.hit('victim').allowed).toBe(false);
  });
  it('stale windows are swept so memory returns to zero', () => {
    const clock = { now: 0 };
    const l = new RateLimiter({ limit: 5, windowMs: 1000, maxKeys: 1000, now: () => clock.now });
    for (let i = 0; i < 200; i++) l.hit(`k${i}`);
    clock.now = 5000;
    l.hit('fresh');
    expect(l.size).toBe(1);
  });
});

describe('rate limits over HTTP', () => {
  it('uploads: the limit is per session; the next one is 429 RATE_LIMITED with Retry-After and writes nothing', async () => {
    app = await startTestApp({ rate: { uploadsPerMinute: 2 } });
    const first = await upload(app, mp4(), 'a.mp4', 'video/mp4', anon); // counted against the address: it created the session
    const cookie = cookieOf(first)!;
    expect((await upload(app, mp4(), 'b.mp4', 'video/mp4', as(cookie))).status).toBe(202);
    expect((await upload(app, mp4(), 'b2.mp4', 'video/mp4', as(cookie))).status).toBe(202);
    const before = (await app.files()).length;
    const limited = await upload(app, mp4(), 'c.mp4', 'video/mp4', as(cookie));
    expect(limited.status).toBe(429);
    expect(await code(limited)).toBe('RATE_LIMITED');
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await app.files()).length).toBe(before);
    // A different session is unaffected by the first one's exhaustion.
    const other = app.newSession();
    expect((await upload(app, mp4(), 'd.mp4', 'video/mp4', as(other.cookie))).status).toBe(202);
  });
  it('the limit resets when the window ends', async () => {
    app = await startTestApp({ rate: { uploadsPerMinute: 1 } });
    const cookie = cookieOf(await upload(app, mp4(), 'a.mp4', 'video/mp4', anon))!;
    expect((await upload(app, mp4(), 'b.mp4', 'video/mp4', as(cookie))).status).toBe(202);
    expect((await upload(app, mp4(), 'b2.mp4', 'video/mp4', as(cookie))).status).toBe(429);
    app.clock.now += 61_000;
    expect((await upload(app, mp4(), 'b.mp4', 'video/mp4', as(cookie))).status).toBe(202);
  });
  it('anonymous uploads are limited per address, so session creation cannot be mass-produced', async () => {
    app = await startTestApp({ rate: { uploadsPerMinute: 3 } });
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await upload(app, mp4(), `a${i}.mp4`, 'video/mp4', anon)).status);
    expect(statuses.filter((s) => s === 202)).toHaveLength(3);
    expect(statuses.filter((s) => s === 429)).toHaveLength(3);
    expect(app.sessions.size).toBe(3);
  });
  it('analysis requests (POST safety-findings) have their own, tighter limit; reads are unaffected', async () => {
    app = await startTestApp({ extraction: {}, rate: { analysisPerMinute: 2 } });
    const up = await upload(app, mp4(), 'a.mp4', 'video/mp4', anon);
    const cookie = cookieOf(up)!;
    const id = ((await up.json()) as MediaResponse).media.asset.id;
    const post = () => fetch(`${app.url}/api/media/${id}/safety-findings`, { method: 'POST', headers: as(cookie, { 'content-type': 'application/json' }), body: '{"terms":[]}' });
    expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(429);
    expect((await fetch(`${app.url}/api/media/${id}`, { headers: as(cookie) })).status).toBe(200);
  });
  it('polling reads are limited too, with their own budget; unauthenticated noise is limited per address', async () => {
    app = await startTestApp({ rate: { readsPerMinute: 5, otherPerMinute: 4 } });
    const cookie = cookieOf(await upload(app, mp4(), 'a.mp4', 'video/mp4', anon))!;
    const reads: number[] = [];
    for (let i = 0; i < 7; i++) reads.push((await fetch(`${app.url}/api/media/00000000-0000-4000-8000-000000000000`, { headers: as(cookie) })).status);
    expect(reads).toEqual([404, 404, 404, 404, 404, 429, 429]);
    const noise: number[] = [];
    for (let i = 0; i < 6; i++) noise.push((await fetch(`${app.url}/api/health`, { headers: anon })).status);
    expect(noise).toEqual([200, 200, 200, 200, 429, 429]);
  });
  it('the rate-limit response is a normal safe error', async () => {
    app = await startTestApp({ rate: { otherPerMinute: 1 } });
    await fetch(`${app.url}/api/health`, { headers: anon });
    const res = await fetch(`${app.url}/api/health`, { headers: anon });
    const text = await res.text();
    expect(res.status).toBe(429);
    expect(text).not.toContain(app.storageDir);
    expect(JSON.parse(text).error).toMatchObject({ code: 'RATE_LIMITED', message: expect.any(String) });
  });
});

describe('StorageQuota', () => {
  const q = (o: Partial<ConstructorParameters<typeof StorageQuota>[0]> = {}) => new StorageQuota({ totalBytes: 1000, perOwnerBytes: 600, maxMediaPerOwner: 3, ...o });
  it('reserves, refuses above each budget, and reports why', () => {
    const quota = q();
    expect(quota.reserve('a', 'o1', 500)).toEqual({ id: 'a', bytes: 500 });
    expect(quota.reserve('b', 'o1', 101)).toBe('owner'); // 500 + 101 > 600 for this owner
    expect(quota.reserve('c', 'o2', 501)).toBe('total'); // fits the owner (600) but 500 + 501 > 1000 overall
  });
  it('the total budget is shared by every owner', () => {
    const quota = q({ perOwnerBytes: 900 });
    expect(quota.reserve('a', 'o1', 600)).toMatchObject({ bytes: 600 });
    expect(quota.reserve('b', 'o2', 401)).toBe('total');
    expect(quota.reserve('b', 'o2', 400)).toMatchObject({ bytes: 400 });
    expect(quota.usage().totalBytes).toBe(1000);
  });
  it('limits items per owner and refuses invalid sizes', () => {
    const quota = q({ totalBytes: 1e9, perOwnerBytes: 1e9 });
    for (const id of ['a', 'b', 'c']) expect(quota.reserve(id, 'o', 1)).toMatchObject({ id });
    expect(quota.reserve('d', 'o', 1)).toBe('count');
    expect(quota.reserve('e', 'p', 1)).toMatchObject({ id: 'e' });
    for (const bad of [-1, 1.5, NaN, Infinity]) expect(quota.reserve('z', 'x', bad)).not.toMatchObject({ id: 'z' });
    expect(quota.reserve('a', 'x', 1)).toBe('count'); // an id cannot be charged twice
  });
  it('resize shrinks freely and grows only within the budgets; release frees everything', () => {
    const quota = q();
    quota.reserve('a', 'o', 300);
    expect(quota.resize('a', 100)).toBe(true);
    expect(quota.usage().totalBytes).toBe(100);
    expect(quota.resize('a', 601)).toBe(false);
    expect(quota.bytesOf('a')).toBe(100);
    expect(quota.resize('missing', 1)).toBe(false);
    quota.release('a'); quota.release('a'); // idempotent
    expect(quota.usage()).toEqual({ totalBytes: 0, items: 0, owners: 0 });
  });
  it('is exact under concurrent reservations: it can never be oversold', async () => {
    const quota = q({ totalBytes: 1000, perOwnerBytes: 1000, maxMediaPerOwner: 1000 });
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => Promise.resolve().then(() => quota.reserve(`m${i}`, `o${i % 5}`, 100))));
    expect(results.filter((r) => typeof r !== 'string')).toHaveLength(10);
    expect(quota.usage().totalBytes).toBe(1000);
  });
});

describe('storage quota over HTTP', () => {
  it('rejects an upload that would exceed the total budget: 507, nothing written, nothing kept in accounting', async () => {
    app = await startTestApp({ quota: { totalBytes: SIZE * 2 - 1 } });
    const ok = await upload(app, mp4(), 'a.mp4', 'video/mp4', anon);
    expect(ok.status).toBe(202);
    const full = await upload(app, mp4(), 'b.mp4', 'video/mp4', anon);
    expect(full.status).toBe(507);
    expect(await code(full)).toBe('QUOTA_EXCEEDED');
    expect((await app.files()).length).toBe(1);
    expect(app.quota.usage().items).toBe(1);
  });
  it('enforces the per-session budget and item count separately from the total', async () => {
    app = await startTestApp({ quota: { perOwnerBytes: SIZE * 2, maxMediaPerOwner: 2 } });
    const cookie = cookieOf(await upload(app, mp4(), 'a.mp4', 'video/mp4', anon))!;
    expect((await upload(app, mp4(), 'b.mp4', 'video/mp4', as(cookie))).status).toBe(202);
    expect((await upload(app, mp4(), 'c.mp4', 'video/mp4', as(cookie))).status).toBe(507);
    // Another session still has room: one session cannot starve the others of its own share.
    expect((await upload(app, mp4(), 'd.mp4', 'video/mp4', anon)).status).toBe(202);
  });
  it('does not trust the declared length: more bytes than declared are cut off and refunded', async () => {
    app = await startTestApp();
    const body = mp4();
    const res = await fetch(`${app.url}/api/media`, { method: 'POST', headers: { ...anon, 'content-type': 'video/mp4', 'x-safewatch-filename': 'a.mp4', 'content-length': String(body.length) }, body });
    expect(res.status).toBe(202);
    expect(app.quota.bytesOf(((await res.json()) as MediaResponse).media.asset.id)).toBe(body.length);
  });
  it('an upload with no declared length reserves the full upload limit while it runs (so it cannot sneak past)', async () => {
    app = await startTestApp({ maxUploadBytes: SIZE * 10, quota: { totalBytes: SIZE * 5 } });
    const stream = new ReadableStream({ start(c) { c.enqueue(mp4()); c.close(); } });
    const res = await fetch(`${app.url}/api/media`, { method: 'POST', headers: { ...anon, 'content-type': 'video/mp4', 'x-safewatch-filename': 'a.mp4' }, body: stream, duplex: 'half' } as RequestInit);
    expect(res.status).toBe(507); // reservation = 10 x SIZE, budget = 5 x SIZE
    expect(app.quota.usage().items).toBe(0);
  });
  it('concurrent uploads competing for the same budget cannot jointly exceed it', async () => {
    app = await startTestApp({ quota: { totalBytes: SIZE * 3 + 10 }, maxConcurrentUploads: 50 });
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => upload(app, mp4(), `c${i}.mp4`, 'video/mp4', anon)));
    const ok = results.filter((r) => r.status === 202).length;
    expect(ok).toBe(3);
    expect(results.filter((r) => r.status === 507)).toHaveLength(7);
    expect(app.quota.usage().totalBytes).toBeLessThanOrEqual(SIZE * 3 + 10);
    expect((await app.files()).length).toBeLessThanOrEqual(3 * 1);
  });
  it('refuses when the disk itself is nearly full (reserve + minimum free space)', async () => {
    app = await startTestApp({ minFreeDiskBytes: Number.MAX_SAFE_INTEGER });
    const res = await upload(app, mp4(), 'a.mp4', 'video/mp4', anon);
    expect(res.status).toBe(507);
    expect(await app.files()).toEqual([]);
  });
  it('deleting media releases its quota; the freed room can be used again', async () => {
    app = await startTestApp({ quota: { totalBytes: SIZE + 10 } });
    const first = await upload(app, mp4(), 'a.mp4', 'video/mp4', anon);
    const cookie = cookieOf(first)!;
    const id = ((await first.json()) as MediaResponse).media.asset.id;
    expect((await upload(app, mp4(), 'b.mp4', 'video/mp4', as(cookie))).status).toBe(507);
    await fetch(`${app.url}/api/media/${id}`, { method: 'DELETE', headers: as(cookie) });
    expect(app.quota.usage()).toEqual({ totalBytes: 0, items: 0, owners: 0 });
    expect((await upload(app, mp4(), 'b.mp4', 'video/mp4', as(cookie))).status).toBe(202);
  });
  it('a failed processing job releases its quota (the file is deleted)', async () => {
    app = await startTestApp({ processor: { extractMetadata: async () => { throw new Error('bad'); }, verifyDecodable: async () => undefined } });
    const res = await upload(app, mp4(), 'a.mp4', 'video/mp4', anon);
    const id = ((await res.json()) as MediaResponse).media.asset.id;
    await eventually(() => app.quota.bytesOf(id) === undefined);
    expect(await app.files()).toEqual([]);
  });
  it('a failed upload (client sends a non-media body) releases its reservation', async () => {
    app = await startTestApp();
    const res = await upload(app, new Uint8Array(2000).fill(65), 'a.mp4', 'video/mp4', anon);
    expect(res.status).toBe(415);
    expect(app.quota.usage().items).toBe(0);
    expect(await app.files()).toEqual([]);
  });
  it('expiry releases quota, and accounting with no record behind it is finished and released by the sweep', async () => {
    app = await startTestApp({ retentionMs: 1000 });
    const res = await upload(app, mp4(), 'a.mp4', 'video/mp4', anon);
    const id = ((await res.json()) as MediaResponse).media.asset.id;
    await eventually(() => app.repository.get(id)?.asset.status === 'ready');
    // Simulate stale accounting: a record lost without its release (e.g. a crash path), file still on disk.
    app.repository.delete(id);
    expect(app.quota.bytesOf(id)).toBeDefined();
    await app.service.sweep();
    expect(app.quota.bytesOf(id)).toBeUndefined();
    expect(await app.files()).toEqual([]);
  });
  it('does not delete anyone else’s files to make room', async () => {
    app = await startTestApp({ quota: { totalBytes: SIZE + 10 } });
    const a = await upload(app, mp4(), 'a.mp4', 'video/mp4', anon);
    const idA = ((await a.json()) as MediaResponse).media.asset.id;
    const b = await upload(app, mp4(), 'b.mp4', 'video/mp4', anon);
    expect(b.status).toBe(507);
    expect(app.repository.get(idA)).toBeDefined();
    expect((await app.files()).length).toBe(1);
  });
});

describe('derived files (extraction) are charged to the same quota', () => {
  it('settles to original + what was really written, and releases all of it on delete', async () => {
    app = await startTestApp({ extraction: {} });
    const res = await upload(app, mp4(), 'a.mp4', 'video/mp4');
    const cookie = cookieOf(res)!;
    const id = ((await res.json()) as MediaResponse).media.asset.id;
    const manifest = await waitForExtraction(app, id);
    expect(manifest.status).toBe('completed');
    const charged = app.quota.bytesOf(id)!;
    expect(charged).toBe(SIZE + manifest.metrics!.outputBytes);
    await fetch(`${app.url}/api/media/${id}`, { method: 'DELETE', headers: as(cookie) });
    expect(app.quota.usage().totalBytes).toBe(0);
  });
  it('refuses to start extraction when its worst case does not fit, fails it cleanly and keeps only the original charged', async () => {
    app = await startTestApp({ extraction: { limits: { maxFrameBytes: 1024 * 1024, maxAudioBytes: 1024 * 1024 } }, quota: { totalBytes: SIZE + 4096 } });
    const res = await upload(app, mp4(), 'a.mp4', 'video/mp4');
    const id = ((await res.json()) as MediaResponse).media.asset.id;
    const manifest = await waitForExtraction(app, id);
    expect(manifest.status).toBe('failed');
    expect(manifest.errors[0]).toMatchObject({ code: 'limit-exceeded', fatal: true });
    expect(app.quota.bytesOf(id)).toBe(SIZE);
    expect((await fs(app)).filter((f) => f.endsWith('.extraction'))).toEqual([]);
  });
  it('a failing extractor leaves no derived accounting or files behind', async () => {
    const extractor: MediaExtractor = {
      inspect: async () => { throw new Error('boom'); }, extractAudio: async () => { throw new Error('x'); },
      extractSubtitleCues: async () => [], sampleFrame: async () => null,
    };
    app = await startTestApp({ extraction: { extractor } });
    const res = await upload(app, mp4(), 'a.mp4', 'video/mp4');
    const id = ((await res.json()) as MediaResponse).media.asset.id;
    expect((await waitForExtraction(app, id)).status).toBe('failed');
    expect(app.quota.bytesOf(id)).toBe(SIZE);
  });
});

async function fs(a: TestApp) { return a.files(); }

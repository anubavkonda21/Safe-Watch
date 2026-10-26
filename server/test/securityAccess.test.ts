import { request } from 'node:http';
import type { ApiErrorBody, MediaResponse } from '@/domain/api/contract';
import { SessionStore, sessionCookie, tokenFromCookie } from '../src/api/sessions';
import { checkHost, checkOrigin } from '../src/api/requestGuards';
import { eventually, fixture, startTestApp, upload, waitForStatus, type TestApp } from './helpers';
import { cookieOf, forgetCookies, setCookie } from './security';

let app: TestApp;
afterEach(async () => { await app?.close(); forgetCookies(); });

const mp4 = () => new Uint8Array(fixture('sample.mp4'));
const errorOf = async (res: Response) => ((await res.json()) as ApiErrorBody).error;
/** An anonymous client: no cookie jar. */
const anon = { 'x-test-no-jar': '1' };
const as = (cookie: string, extra: Record<string, string> = {}) => ({ 'x-test-no-jar': '1', cookie, ...extra });

/** A request with a Host header of our choosing (fetch forbids setting it). */
function raw(a: TestApp, opts: { method?: string; path: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; text: string }> {
  const u = new URL(a.url);
  return new Promise((resolve, reject) => {
    const req = request({ host: u.hostname, port: u.port, method: opts.method ?? 'GET', path: opts.path, headers: opts.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(opts.body);
  });
}

/** Two browsers, A and B; A owns a ready media item. */
async function twoBrowsers(opts: Parameters<typeof startTestApp>[0] = {}) {
  app = await startTestApp(opts);
  const first = await upload(app, mp4(), 'a.mp4', 'video/mp4', anon);
  const cookieA = cookieOf(first)!;
  setCookie(app.url, cookieA); // the helpers that poll act as browser A
  const id = ((await first.json()) as MediaResponse).media.asset.id;
  const b = app.newSession();
  await waitForStatus(app, id, ['ready']).catch(() => undefined);
  return { id, cookieA, cookieB: b.cookie };
}

describe('sessions', () => {
  it('the first upload starts a session: a 256-bit random secret in an HttpOnly, SameSite=Strict cookie scoped to /api', async () => {
    app = await startTestApp();
    const res = await upload(app, mp4(), 'a.mp4', 'video/mp4', anon);
    expect(res.status).toBe(202);
    const set = res.headers.getSetCookie()[0]!;
    expect(set).toMatch(/^sw_session=[A-Za-z0-9_-]{43};/);
    expect(set).toContain('HttpOnly');
    expect(set).toContain('SameSite=Strict');
    expect(set).toContain('Path=/api');
    expect(set).not.toContain('Secure'); // plain-http loopback by default
    expect(JSON.stringify(await res.json())).not.toContain(set.split(';')[0]!.split('=')[1]!); // the secret is never in a body
  });
  it('is Secure when configured for HTTPS', async () => {
    app = await startTestApp({ security: { cookieSecure: true } });
    expect((await upload(app, mp4(), 'a.mp4', 'video/mp4', anon)).headers.getSetCookie()[0]).toContain('; Secure');
  });
  it('two anonymous uploads get two different secrets', async () => {
    app = await startTestApp();
    const a = cookieOf(await upload(app, mp4(), 'a.mp4', 'video/mp4', anon));
    const b = cookieOf(await upload(app, mp4(), 'b.mp4', 'video/mp4', anon));
    expect(a).toBeDefined(); expect(a).not.toBe(b);
  });
  it('a browser that already has a session keeps it (no new Set-Cookie)', async () => {
    app = await startTestApp();
    const first = await upload(app, mp4(), 'a.mp4', 'video/mp4', anon);
    const second = await upload(app, mp4(), 'b.mp4', 'video/mp4', as(cookieOf(first)!));
    expect(second.status).toBe(202);
    expect(second.headers.getSetCookie()).toEqual([]);
  });
  it('the server stores only a digest: the owner id is not the secret', () => {
    const store = new SessionStore({ ttlMs: 1000, maxSessions: 5 });
    const { token, ownerId } = store.create();
    expect(ownerId).not.toBe(token);
    expect(ownerId).toMatch(/^[0-9a-f]{64}$/);
    expect(store.authenticate(token)).toBe(ownerId);
  });
  it('rejects malformed, truncated, forged and other-length tokens', () => {
    const store = new SessionStore({ ttlMs: 1000, maxSessions: 5 });
    const { token } = store.create();
    for (const bad of [undefined, '', 'x', token.slice(1), `${token}a`, token.toUpperCase(), 'A'.repeat(43), '../../etc', `${token.slice(0, 42)}=`]) expect(store.authenticate(bad)).toBeNull();
  });
  it('expires after the idle limit, and use keeps it alive', () => {
    const clock = { now: 0 };
    const store = new SessionStore({ ttlMs: 1000, maxSessions: 5, now: () => clock.now });
    const { token } = store.create();
    clock.now = 900; expect(store.authenticate(token)).not.toBeNull();
    clock.now = 1800; expect(store.authenticate(token)).not.toBeNull(); // refreshed at 900
    clock.now = 2900; expect(store.authenticate(token)).toBeNull(); // idle for 1100 ms
    expect(store.size).toBe(0);
  });
  it('is bounded: the least recently used session is dropped when the limit is reached', () => {
    const store = new SessionStore({ ttlMs: 1_000_000, maxSessions: 3 });
    const a = store.create(); const b = store.create(); const c = store.create();
    store.authenticate(a.token); // a is now the most recent; b the oldest
    const d = store.create();
    expect(d.dropped).toEqual([b.ownerId]);
    expect(store.size).toBe(3);
    expect(store.authenticate(b.token)).toBeNull();
    for (const x of [a, c, d]) expect(store.authenticate(x.token)).toBe(x.ownerId);
  });
  it('cookie parsing ignores other cookies and oversized headers', () => {
    expect(tokenFromCookie('a=1; sw_session=abc; b=2')).toBe('abc');
    expect(tokenFromCookie('xsw_session=abc')).toBeUndefined();
    expect(tokenFromCookie(`sw_session=${'a'.repeat(5000)}`)).toBeUndefined();
    expect(sessionCookie('t', { maxAgeSeconds: 5, secure: false })).toBe('sw_session=t; Path=/api; HttpOnly; SameSite=Strict; Max-Age=5');
  });
  it('a restart (new server, new session store) invalidates every old cookie', async () => {
    const first = await startTestApp();
    const cookie = cookieOf(await upload(first, mp4(), 'a.mp4', 'video/mp4', anon))!;
    await first.close();
    app = await startTestApp();
    const res = await fetch(`${app.url}/api/media/00000000-0000-4000-8000-000000000000`, { headers: as(cookie) });
    expect(res.status).toBe(401);
  });
});

describe('authentication: every media route needs a session', () => {
  const ID = '00000000-0000-4000-8000-000000000000';
  const routes: Array<[string, string, string?]> = [
    ['GET', `/api/media/${ID}`], ['DELETE', `/api/media/${ID}`], ['GET', `/api/media/${ID}/extraction`], ['GET', `/api/media/${ID}/transcript`],
    ['GET', `/api/media/${ID}/context`], ['GET', `/api/media/${ID}/visual`], ['GET', `/api/media/${ID}/frames/frm-00000`],
    ['GET', `/api/media/${ID}/safety-findings`], ['POST', `/api/media/${ID}/safety-findings`, '{"terms":[]}'], ['GET', '/api/media'],
  ];
  it.each(routes)('%s %s without a session is 401 UNAUTHENTICATED', async (method, path, body) => {
    app = await startTestApp();
    const res = await fetch(`${app.url}${path}`, { method, headers: { ...anon, ...(body ? { 'content-type': 'application/json' } : {}) }, body });
    expect(res.status).toBe(401);
    expect((await errorOf(res)).code).toBe('UNAUTHENTICATED');
  });
  it('an unknown or forged cookie is the same 401', async () => {
    app = await startTestApp();
    for (const cookie of ['sw_session=nope', `sw_session=${'A'.repeat(43)}`, 'other=1']) {
      const res = await fetch(`${app.url}/api/media/${ID}`, { headers: as(cookie) });
      expect(res.status).toBe(401);
    }
  });
  it('the health endpoint stays public and reveals no session state', async () => {
    app = await startTestApp();
    const res = await fetch(`${app.url}/api/health`, { headers: anon });
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toEqual([]);
  });
  it('a rejected request never starts a session', async () => {
    app = await startTestApp();
    const res = await fetch(`${app.url}/api/media/${ID}`, { headers: anon });
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(app.sessions.size).toBe(0);
  });
});

describe('ownership: knowing a media id is not enough', () => {
  it('the owner can read, and every other session gets exactly the answer an unknown id gets', async () => {
    const { id, cookieA, cookieB } = await twoBrowsers({ extraction: {} });
    const unknown = '11111111-1111-4111-8111-111111111111';
    for (const path of ['', '/extraction', '/transcript', '/context', '/visual']) {
      const mine = await fetch(`${app.url}/api/media/${id}${path}`, { headers: as(cookieA) });
      expect(mine.status, path).toBe(200);
      const theirs = await fetch(`${app.url}/api/media/${id}${path}`, { headers: as(cookieB) });
      const none = await fetch(`${app.url}/api/media/${unknown}${path}`, { headers: as(cookieB) });
      expect(theirs.status, path).toBe(404);
      expect(none.status, path).toBe(404);
      // Same status, same body shape (only the per-request id differs): existence is not revealed.
      const norm = async (r: Response) => JSON.stringify(((await r.json()) as ApiErrorBody).error.code) + r.headers.get('content-length');
      expect(await norm(theirs)).toBe(await norm(none));
    }
  });
  it('another session cannot analyse (GET or POST), fetch frames, or delete; the owner still can afterwards', async () => {
    const { id, cookieA, cookieB } = await twoBrowsers({ extraction: {} });
    await waitForStatus(app, id, ['ready']);
    const body = JSON.stringify({ terms: [{ phrase: 'x', matchMode: 'exact' }] });
    expect((await fetch(`${app.url}/api/media/${id}/safety-findings`, { method: 'POST', headers: as(cookieB, { 'content-type': 'application/json' }), body })).status).toBe(404);
    expect((await fetch(`${app.url}/api/media/${id}/safety-findings`, { headers: as(cookieB) })).status).toBe(404);
    expect((await fetch(`${app.url}/api/media/${id}/frames/frm-00000`, { headers: as(cookieB) })).status).toBe(404);
    // Deletion by a stranger is a silent no-op: it changes nothing...
    expect((await fetch(`${app.url}/api/media/${id}`, { method: 'DELETE', headers: as(cookieB) })).status).toBe(204);
    expect((await app.files()).length).toBeGreaterThan(0);
    expect(app.repository.get(id)).toBeDefined();
    expect((await fetch(`${app.url}/api/media/${id}`, { headers: as(cookieA) })).status).toBe(200);
    // ...while the owner's deletion works.
    expect((await fetch(`${app.url}/api/media/${id}`, { method: 'DELETE', headers: as(cookieA) })).status).toBe(204);
    expect(app.repository.get(id)).toBeUndefined();
  });
  it('sessions keep working side by side and neither sees the other', async () => {
    app = await startTestApp();
    const a = await upload(app, mp4(), 'a.mp4', 'video/mp4', anon);
    const b = await upload(app, mp4(), 'b.mp4', 'video/mp4', anon);
    const [ca, cb] = [cookieOf(a)!, cookieOf(b)!];
    const [ia, ib] = [((await a.json()) as MediaResponse).media.asset.id, ((await b.json()) as MediaResponse).media.asset.id];
    expect((await fetch(`${app.url}/api/media/${ia}`, { headers: as(ca) })).status).toBe(200);
    expect((await fetch(`${app.url}/api/media/${ib}`, { headers: as(cb) })).status).toBe(200);
    expect((await fetch(`${app.url}/api/media/${ia}`, { headers: as(cb) })).status).toBe(404);
    expect((await fetch(`${app.url}/api/media/${ib}`, { headers: as(ca) })).status).toBe(404);
  });
  it('the owner id never appears in any response', async () => {
    const { id, cookieA } = await twoBrowsers({ extraction: {} });
    const owner = app.repository.get(id)!.ownerId;
    for (const path of ['', '/extraction', '/transcript', '/context', '/visual']) {
      expect(await (await fetch(`${app.url}/api/media/${id}${path}`, { headers: as(cookieA) })).text()).not.toContain(owner);
    }
  });
  it('an expired session can no longer reach its media (which expires on its own schedule)', async () => {
    const { id, cookieA } = await twoBrowsers({ security: { sessionTtlMs: 1000 } });
    app.clock.now += 5000;
    expect((await fetch(`${app.url}/api/media/${id}`, { headers: as(cookieA) })).status).toBe(401);
  });
});

describe('browser protections: Host, Origin, CORS', () => {
  it('refuses a Host the server was not configured for (DNS rebinding), before anything else', async () => {
    app = await startTestApp();
    for (const host of ['evil.example', 'evil.example:80', '127.0.0.1.evil.example', 'localhost.evil.example:3000']) {
      const r = await raw(app, { path: '/api/health', headers: { host } });
      expect(r.status, host).toBe(403);
      expect(JSON.parse(r.text).error.code).toBe('INVALID_REQUEST');
    }
    expect((await raw(app, { path: '/api/health', headers: { host: 'localhost:5173' } })).status).toBe(200);
    expect((await raw(app, { path: '/api/health', headers: { host: '127.0.0.1' } })).status).toBe(200);
  });
  it('a rebinding page cannot even start a session or upload', async () => {
    app = await startTestApp();
    const r = await raw(app, { method: 'POST', path: '/api/media', headers: { host: 'evil.example', 'content-type': 'video/mp4', 'x-safewatch-filename': 'a.mp4' }, body: 'x' });
    expect(r.status).toBe(403);
    expect(r.headers['set-cookie']).toBeUndefined();
    expect(app.sessions.size).toBe(0);
    expect(await app.files()).toEqual([]);
  });
  it('checkHost: bare names match any port, name:port matches exactly, malformed is refused', () => {
    expect(checkHost('localhost:9', ['localhost'])).toBe(true);
    expect(checkHost('[::1]:8787', ['[::1]'])).toBe(true);
    expect(checkHost('app.test:8787', ['app.test:8787'])).toBe(true);
    expect(checkHost('app.test:9999', ['app.test:8787'])).toBe(false);
    expect(checkHost(undefined, ['localhost'])).toBe(false);
    expect(checkHost('', ['localhost'])).toBe(false);
    expect(checkHost('x'.repeat(300), ['localhost'])).toBe(false);
  });
  it('refuses a foreign Origin on every method, an Origin: null, and a cross-site fetch', async () => {
    const { id, cookieA } = await twoBrowsers();
    for (const origin of ['https://evil.example', 'null', 'http://localhost:5173.evil.example']) {
      const read = await fetch(`${app.url}/api/media/${id}`, { headers: as(cookieA, { origin }) });
      expect(read.status, origin).toBe(403);
      expect(read.headers.get('access-control-allow-origin')).toBeNull();
      const del = await fetch(`${app.url}/api/media/${id}`, { method: 'DELETE', headers: as(cookieA, { origin }) });
      expect(del.status, origin).toBe(403);
    }
    expect((await fetch(`${app.url}/api/media/${id}`, { method: 'DELETE', headers: as(cookieA, { 'sec-fetch-site': 'cross-site' }) })).status).toBe(403);
    expect(app.repository.get(id)).toBeDefined(); // nothing was deleted by any of them
  });
  it('a forged-origin upload cannot start a session or write a byte', async () => {
    app = await startTestApp();
    const res = await upload(app, mp4(), 'a.mp4', 'video/mp4', { ...anon, origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(await app.files()).toEqual([]);
  });
  it('accepts the allow-listed origin (with credentials) and the server’s own origin', async () => {
    const { id, cookieA } = await twoBrowsers({ allowedOrigins: ['http://localhost:5173'] });
    const ok = await fetch(`${app.url}/api/media/${id}`, { headers: as(cookieA, { origin: 'http://localhost:5173' }) });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(ok.headers.get('access-control-allow-credentials')).toBe('true');
    const same = await fetch(`${app.url}/api/media/${id}`, { headers: as(cookieA, { origin: app.url }) });
    expect(same.status).toBe(200);
    expect(same.headers.get('access-control-allow-origin')).toBeNull(); // same-origin needs no CORS
  });
  it('checkOrigin: duplicates and non-http schemes are refused', () => {
    expect(checkOrigin(['a', 'b'], undefined, 'h', [])).toBe(false);
    expect(checkOrigin('ftp://h', undefined, 'h', [])).toBe(false);
    expect(checkOrigin(undefined, undefined, 'h', [])).toBe(true); // non-browser client: governed by the cookie
    expect(checkOrigin('http://h', 'same-origin', 'h', [])).toBe(true);
  });
  it('JSON endpoints reject other content types', async () => {
    const { id, cookieA } = await twoBrowsers({ extraction: {} });
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', '']) {
      const res = await fetch(`${app.url}/api/media/${id}/safety-findings`, { method: 'POST', headers: as(cookieA, type ? { 'content-type': type } : {}), body: '{"terms":[]}' });
      expect(res.status, type).toBe(400);
    }
  });
  it('responses are never cacheable and carry nosniff', async () => {
    const { id, cookieA } = await twoBrowsers();
    const res = await fetch(`${app.url}/api/media/${id}`, { headers: as(cookieA) });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });
});

describe('background work is not blocked by access control', () => {
  it('the owner’s media finishes processing and its files are released on delete', async () => {
    const { id, cookieA } = await twoBrowsers();
    await waitForStatus(app, id, ['ready']);
    await fetch(`${app.url}/api/media/${id}`, { method: 'DELETE', headers: as(cookieA) });
    await eventually(async () => (await app.files()).length === 0);
  });
});

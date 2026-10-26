import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApiErrorBody, MediaResponse } from '@/domain/api/contract';
import { eventually, fixture, hasFfmpeg, startTestApp, upload, waitForStatus, type TestApp } from './helpers';
import { cookieOf, forgetCookies } from './security';

let app: TestApp;
afterEach(async () => { await app?.close(); forgetCookies(); });
const mp4 = () => new Uint8Array(fixture('sample.mp4'));
const anon = { 'x-test-no-jar': '1' };
const as = (cookie: string) => ({ 'x-test-no-jar': '1', cookie });

describe('session eviction (audit): what it can and cannot do to legitimate users', () => {
  it('an IDLE session is evicted once more than maxSessions newer ones exist: its owner gets 401 and its media is deleted, not orphaned', async () => {
    app = await startTestApp({ maxSessions: 3 });
    const victim = await upload(app, mp4(), 'v.mp4', 'video/mp4', anon);
    const vCookie = cookieOf(victim)!;
    const vId = ((await victim.json()) as MediaResponse).media.asset.id;
    await waitForStatus(app, vId, ['ready']).catch(() => undefined);
    for (let i = 0; i < 3; i++) await upload(app, mp4(), `n${i}.mp4`, 'video/mp4', anon); // three newer sessions push the idle one out
    const res = await fetch(`${app.url}/api/media/${vId}`, { headers: as(vCookie) });
    expect(res.status).toBe(401); // legitimate-but-idle users CAN be invalidated by session churn: documented residual risk
    await eventually(() => app.repository.get(vId) === undefined && app.quota.bytesOf(vId) === undefined);
    expect((await app.files()).some((f) => f.startsWith(vId))).toBe(false);
  });
  it('an ACTIVE session survives the same churn (least recently used goes first)', async () => {
    app = await startTestApp({ maxSessions: 3 });
    const a = await upload(app, mp4(), 'a.mp4', 'video/mp4', anon);
    const aCookie = cookieOf(a)!;
    const aId = ((await a.json()) as MediaResponse).media.asset.id;
    for (let i = 0; i < 6; i++) {
      await upload(app, mp4(), `n${i}.mp4`, 'video/mp4', anon);
      expect((await fetch(`${app.url}/api/media/${aId}`, { headers: as(aCookie) })).status).toBe(200); // polling keeps it recent
    }
  });
  it('creating sessions is rate limited per address, which bounds how fast anyone can churn them', async () => {
    app = await startTestApp({ maxSessions: 100, rate: { uploadsPerMinute: 4 } });
    const codes: number[] = [];
    for (let i = 0; i < 10; i++) codes.push((await upload(app, mp4(), `n${i}.mp4`, 'video/mp4', anon)).status);
    expect(codes.filter((c) => c === 202)).toHaveLength(4);
    expect(app.sessions.size).toBe(4);
  });
  it('deleteOwners removes only the named owners’ media and nothing else', async () => {
    app = await startTestApp();
    const a = await upload(app, mp4(), 'a.mp4', 'video/mp4', anon);
    const b = await upload(app, mp4(), 'b.mp4', 'video/mp4', anon);
    const [ia, ib] = [((await a.json()) as MediaResponse).media.asset.id, ((await b.json()) as MediaResponse).media.asset.id];
    expect(await app.service.deleteOwners([app.repository.get(ia)!.ownerId])).toBe(1);
    expect(app.repository.get(ia)).toBeUndefined();
    expect(app.repository.get(ib)).toBeDefined();
    expect(await app.service.deleteOwners(['nobody'])).toBe(0);
  });
  it('an expired session’s media is removed by the periodic prune', async () => {
    app = await startTestApp({ security: { sessionTtlMs: 1000 }, retentionMs: 10 * 60_000 });
    const a = await upload(app, mp4(), 'a.mp4', 'video/mp4', anon);
    const id = ((await a.json()) as MediaResponse).media.asset.id;
    app.clock.now += 5000;
    await app.service.deleteOwners(app.sessions.prune()); // what main.ts does on each sweep
    expect(app.repository.get(id)).toBeUndefined();
    expect(app.quota.usage().items).toBe(0);
  });
  it('401 after eviction carries no hint about whether the media existed', async () => {
    app = await startTestApp();
    const res = await fetch(`${app.url}/api/media/00000000-0000-4000-8000-000000000000`, { headers: as(`sw_session=${'A'.repeat(43)}`) });
    expect(((await res.json()) as ApiErrorBody).error.code).toBe('UNAUTHENTICATED');
  });
});

/** The real entry point as a child process: this is what a user actually runs. */
describe.skipIf(!hasFfmpeg)('real server process: start, upload, SIGTERM in every lifecycle state', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'sw-shutdown-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  async function boot(port: number) {
    const store = join(dir, 'store');
    const child = spawn(process.execPath, ['--import', 'tsx', 'server/src/main.ts'], {
      env: { PATH: process.env.PATH ?? '', SAFEWATCH_PORT: String(port), SAFEWATCH_STORAGE_DIR: store, SAFEWATCH_FRAME_INTERVAL_SECONDS: '1', SAFEWATCH_LOG_LEVEL: 'silent', SAFEWATCH_SHUTDOWN_GRACE_MS: '3000' },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    const exited = new Promise<number | null>((r) => child.on('exit', (c) => r(c)));
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`http://127.0.0.1:${port}/api/health`, { headers: anon })).ok) break; } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    return { child, exited, store, base: `http://127.0.0.1:${port}` };
  }
  const toolsUsing = (store: string) => {
    try { return execFileSync('ps', ['-axo', 'command']).toString().split('\n').filter((l) => l.includes(store) && /ffmpeg|ffprobe|whisper|vision/.test(l)); } catch { return []; }
  };

  it('SIGTERM while FFmpeg is extracting: exits 0, stops the tools, leaves an empty store', async () => {
    const long = join(dir, 'long.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=d=900:s=320x240:r=10', '-c:v', 'libx264', '-preset', 'ultrafast', '-y', long]);
    const s = await boot(18810 + Math.floor(Math.random() * 100));
    const { readFile } = await import('node:fs/promises');
    const res = await fetch(`${s.base}/api/media`, { method: 'POST', headers: { ...anon, 'content-type': 'video/mp4', 'x-safewatch-filename': 'long.mp4' }, body: await readFile(long) });
    expect(res.status).toBe(202);
    await eventually(() => toolsUsing(s.store).length > 0, 20_000); // an FFmpeg/FFprobe child is really running
    s.child.kill('SIGTERM');
    expect(await Promise.race([s.exited, new Promise((r) => setTimeout(() => r('hung'), 15_000))])).toBe(0);
    expect(toolsUsing(s.store)).toEqual([]);
    expect((await readdir(s.store)).filter((f) => f !== '.safewatch-storage')).toEqual([]);
  }, 60_000);

  it('SIGTERM in the middle of an upload: exits, and the partial file is gone', async () => {
    const s = await boot(18910 + Math.floor(Math.random() * 100));
    const port = Number(new URL(s.base).port);
    const sock = connect(port, '127.0.0.1');
    await new Promise<void>((r) => sock.on('connect', () => r()));
    sock.on('error', () => undefined);
    sock.write(`POST /api/media HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: video/mp4\r\nX-SafeWatch-Filename: a.mp4\r\nContent-Length: ${mp4().length}\r\n\r\n`);
    sock.write(Buffer.from(mp4().subarray(0, 200)));
    await eventually(async () => (await readdir(s.store)).some((f) => f.endsWith('.part')), 10_000);
    s.child.kill('SIGTERM');
    expect(await Promise.race([s.exited, new Promise((r) => setTimeout(() => r('hung'), 15_000))])).toBe(0);
    sock.destroy();
    expect((await readdir(s.store)).filter((f) => f !== '.safewatch-storage')).toEqual([]);
  }, 60_000);

  it('SIGTERM when idle, twice in a row, and a restart on the same directory: all clean', async () => {
    const port = 19010 + Math.floor(Math.random() * 100);
    const s = await boot(port);
    s.child.kill('SIGTERM'); s.child.kill('SIGTERM');
    expect(await s.exited).toBe(0);
    const again = await boot(port); // adopts its own marker directory
    expect((await fetch(`${again.base}/api/health`, { headers: anon })).status).toBe(200);
    again.child.kill('SIGINT');
    expect(await again.exited).toBe(0);
  }, 60_000);

  it('refuses to start on a directory it did not create and does not touch what is in it', async () => {
    const { mkdir, writeFile, readFile } = await import('node:fs/promises');
    const store = join(dir, 'store');
    await mkdir(store);
    await writeFile(join(store, 'precious.txt'), 'keep me');
    const child = spawn(process.execPath, ['--import', 'tsx', 'server/src/main.ts'], { env: { PATH: process.env.PATH ?? '', SAFEWATCH_PORT: '19200', SAFEWATCH_STORAGE_DIR: store, SAFEWATCH_LOG_LEVEL: 'silent' }, stdio: 'ignore' });
    const code = await Promise.race([new Promise<number | null>((r) => child.on('exit', r)), new Promise<string>((r) => setTimeout(() => r('still running'), 8000))]);
    child.kill('SIGKILL');
    expect(code).not.toBe(0);
    expect(await readFile(join(store, 'precious.txt'), 'utf8')).toBe('keep me');
  }, 30_000);
});

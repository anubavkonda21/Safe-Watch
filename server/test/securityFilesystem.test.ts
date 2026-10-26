import { connect } from 'node:net';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApiErrorBody, MediaResponse } from '@/domain/api/contract';
import { StorageError } from '../src/application/ports';
import { LocalDiskMediaStorage } from '../src/infrastructure/storage/localDiskMediaStorage';
import { eventually, fixture, startTestApp, upload, waitForExtraction, type TestApp } from './helpers';
import { forgetCookies } from './security';

let app: TestApp;
let scratch: string;
beforeEach(async () => { scratch = await mkdtemp(join(tmpdir(), 'sw-fs-')); });
afterEach(async () => { await app?.close(); forgetCookies(); await rm(scratch, { recursive: true, force: true }); });

const mp4 = () => new Uint8Array(fixture('sample.mp4'));
const ID = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a';
const err = async (r: Response) => ((await r.json()) as ApiErrorBody).error;
const stream = async function* (...parts: Uint8Array[]) { for (const p of parts) yield p; };

describe('route parameters and ids', () => {
  const evil = [
    '..', '../..', '..%2f..%2fetc%2fpasswd', '%2e%2e%2f', '%2E%2E/', '..%5c..%5cwindows', '%00', 'a%00b', '/etc/passwd', '%2fetc%2fpasswd',
    'C:%5Cwindows', '....//', ' ', '%20', ID.toUpperCase(), `${ID}%20`, `${ID}/..`, `${ID}%00.media`, '0'.repeat(500), '🙂', '%F0%9F%99%82', ID.slice(1),
  ];
  it.each(evil)('id %s is rejected as an unknown resource on every route, and reads no file', async (bad) => {
    app = await startTestApp({ extraction: {} });
    app.login();
    for (const suffix of ['', '/extraction', '/transcript', '/context', '/visual', '/safety-findings', '/frames/frm-00000']) {
      const res = await fetch(`${app.url}/api/media/${bad}${suffix}`);
      expect([400, 404], `${bad}${suffix}`).toContain(res.status);
      const text = await res.text();
      expect(text).not.toMatch(/passwd|windows|root:|\/Users|\/private|\/var\/|ENOENT/);
    }
    expect([204, 404]).toContain((await fetch(`${app.url}/api/media/${bad}`, { method: 'DELETE' })).status);
  });
  it('frame ids must match the server format exactly', async () => {
    app = await startTestApp({ extraction: {} });
    app.login();
    for (const f of ['frm-1', 'frm-000000', '../frm-00001', 'FRM-00001', 'frm-0000a', 'frm-00001.jpg', 'frm-00001%2f..']) {
      expect((await fetch(`${app.url}/api/media/${ID}/frames/${f}`)).status, f).toBe(404);
    }
  });
  it('a stranger’s artifact names cannot be requested: only manifest frame ids resolve', async () => {
    app = await startTestApp({ extraction: {} });
    const res = await upload(app, mp4(), 'a.mp4');
    const id = ((await res.json()) as MediaResponse).media.asset.id;
    await waitForExtraction(app, id);
    expect((await fetch(`${app.url}/api/media/${id}/frames/frm-00000`)).status).toBe(200);
    for (const p of ['audio/aud-0.wav', '..%2F..%2F' + id + '.media', 'frames%2ffrm-00000.jpg']) {
      expect((await fetch(`${app.url}/api/media/${id}/frames/${p}`)).status, p).toBe(404);
    }
  });
});

describe('filenames are display text, never paths', () => {
  const names = [
    '../../../etc/passwd.mp4', '..\\..\\windows\\system32\\cmd.mp4', '/etc/passwd.mp4', 'C:\\x\\y.mp4', 'a\0b.mp4', 'a\nb.mp4', '$(rm -rf).mp4',
    '`id`.mp4', 'a;b|c&d.mp4', '<script>alert(1)</script>.mp4', '.mp4', 'con.mp4', 'x'.repeat(400) + '.mp4', '😀.mp4', '\u202eevil4pm.mp4',
  ];
  it.each(names)('upload named %j stores only a server-generated uuid name, and no response or log contains a path', async (name) => {
    app = await startTestApp();
    const res = await upload(app, mp4(), name);
    expect([202, 400, 415]).toContain(res.status);
    const text = await res.text();
    expect(text).not.toContain(app.storageDir);
    for (const f of await readdir(app.storageDir)) expect(f).toMatch(/^([0-9a-f-]{36}\.(media|part|extraction)|\.safewatch-storage)$/);
    expect(JSON.stringify(app.logs)).not.toContain(app.storageDir);
    expect(existsSync('/etc/passwd.mp4')).toBe(false);
  });
  it('an undecodable or oversized filename header is a clean 400', async () => {
    app = await startTestApp();
    for (const h of ['%E0%A4%A', 'x'.repeat(2000), '']) {
      const res = await fetch(`${app.url}/api/media`, { method: 'POST', headers: { 'content-type': 'video/mp4', 'x-safewatch-filename': h }, body: mp4() });
      expect(res.status, h.slice(0, 10)).toBe(400);
    }
    expect(await app.files()).toEqual([]);
  });
});

describe('upload streams', () => {
  it('an oversize upload (declared and undeclared) is cut off, answers 413, and leaves no file or accounting', async () => {
    app = await startTestApp({ maxUploadBytes: 1024 });
    const padded = new Uint8Array(5000); padded.set(mp4().subarray(0, 64));
    const declared = await upload(app, padded, 'big.mp4');
    expect(declared.status).toBe(413);
    expect((await err(declared)).code).toBe('FILE_TOO_LARGE');
    const undeclared = await fetch(`${app.url}/api/media`, { method: 'POST', headers: { 'content-type': 'video/mp4', 'x-safewatch-filename': 'big.mp4' }, body: new ReadableStream({ start(c) { c.enqueue(padded); c.enqueue(new Uint8Array(4000)); c.close(); } }), duplex: 'half' } as RequestInit);
    expect(undeclared.status).toBe(413);
    expect(await app.files()).toEqual([]);
    expect(app.quota.usage().items).toBe(0);
  });
  it('a client that disconnects mid-upload leaves no partial file and releases its reservation', async () => {
    app = await startTestApp();
    const u = new URL(app.url);
    await new Promise<void>((resolve) => {
      const s = connect(Number(u.port), u.hostname, () => {
        s.write(`POST /api/media HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: video/mp4\r\nX-SafeWatch-Filename: a.mp4\r\nContent-Length: ${mp4().length}\r\n\r\n`);
        s.write(Buffer.from(mp4().subarray(0, 100)));
        setTimeout(() => { s.destroy(); resolve(); }, 80);
      });
      s.on('error', () => undefined);
    });
    await eventually(() => app.logs.some((l) => l.msg === 'upload rejected')); // the server has finished handling (and cleaning up) the failed upload
    expect(await app.files()).toEqual([]);
    expect(app.quota.usage().items).toBe(0);
    expect(app.repository.expired(Number.MAX_SAFE_INTEGER)).toEqual([]);
  });
  it('a truncated upload (fewer bytes than declared) never becomes a media item', async () => {
    app = await startTestApp();
    const u = new URL(app.url);
    const status = await new Promise<string>((resolve) => {
      const s = connect(Number(u.port), u.hostname, () => {
        s.write(`POST /api/media HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: video/mp4\r\nX-SafeWatch-Filename: a.mp4\r\nContent-Length: 999999\r\nConnection: close\r\n\r\n`);
        s.write(Buffer.from(mp4()));
        s.end(); // half-close: the body ends early
      });
      let data = '';
      s.on('data', (d) => { data += d.toString(); });
      s.on('close', () => resolve(data.split('\r\n')[0] ?? ''));
      s.on('error', () => resolve('error'));
    });
    expect(['', 'error'].includes(status) || /^HTTP\/1\.1 (400|408|500)/.test(status)).toBe(true); // never a 2xx
    await eventually(() => app.logs.some((l) => l.msg === 'upload rejected')); // the server has finished handling (and cleaning up) the failed upload
    expect(await app.files()).toEqual([]);
    expect(app.quota.usage().items).toBe(0);
  });
  it('a body that is not a supported container is refused before processing and removed', async () => {
    app = await startTestApp();
    const res = await upload(app, new TextEncoder().encode('#!/bin/sh\nrm -rf /\n'.repeat(100)), 'run.mp4');
    expect(res.status).toBe(415);
    expect(await app.files()).toEqual([]);
  });
  it('the file extension and declared type are never taken as proof: the bytes decide', async () => {
    app = await startTestApp();
    const res = await upload(app, mp4(), 'movie.mkv', 'video/x-matroska'); // MP4 bytes, Matroska claims
    expect(res.status).toBe(415);
    expect(await app.files()).toEqual([]);
  });
});

describe('storage: links and planted files', () => {
  it('never writes through a symlink planted at the upload path (exclusive create)', async () => {
    const storage = new LocalDiskMediaStorage(scratch);
    await storage.exists(ID); // initialises the directory
    const target = join(scratch, '..', `sw-victim-${Date.now()}.txt`);
    await writeFile(target, 'original');
    await symlink(target, join(scratch, `${ID}.part`));
    await expect(storage.save(ID, stream(mp4()), { maxBytes: 1e9 })).rejects.toBeInstanceOf(StorageError);
    expect(await readFile(target, 'utf8')).toBe('original');
    await rm(target, { force: true });
  });
  it('treats a symlink in place of a media file as not found, and never reads its target', async () => {
    const storage = new LocalDiskMediaStorage(scratch);
    await storage.exists(ID);
    const secret = join(scratch, '..', `sw-secret-${Date.now()}.txt`);
    await writeFile(secret, 'TOP SECRET');
    await symlink(secret, join(scratch, `${ID}.media`));
    expect(await storage.exists(ID)).toBe(false);
    await expect(storage.withLocalFile(ID, async () => 'reached')).rejects.toMatchObject({ kind: 'not-found' });
    let leaked = '';
    try { for await (const c of storage.read(ID)) leaked += Buffer.from(c).toString(); } catch { /* O_NOFOLLOW refuses */ }
    expect(leaked).toBe('');
    await rm(secret, { force: true });
  });
  it('refuses an extraction directory that is a symlink, and artifacts behind a planted link', async () => {
    const storage = new LocalDiskMediaStorage(scratch);
    await storage.exists(ID);
    const elsewhere = await mkdtemp(join(tmpdir(), 'sw-elsewhere-'));
    await writeFile(join(elsewhere, 'x.jpg'), 'IMAGE');
    await symlink(elsewhere, join(scratch, `${ID}.extraction`));
    await expect(storage.withExtractionDir(ID, async () => 'reached')).rejects.toBeInstanceOf(StorageError);
    await expect(storage.withArtifactFile(ID, 'frames/x.jpg', async () => 'reached')).rejects.toMatchObject({ kind: 'not-found' });
    // Deleting the media removes the link itself, never what it points to.
    await storage.delete(ID);
    expect(existsSync(join(elsewhere, 'x.jpg'))).toBe(true);
    await rm(elsewhere, { recursive: true, force: true });
  });
  it('cleanup and purge remove links as links and leave their targets alone', async () => {
    const storage = new LocalDiskMediaStorage(scratch);
    await storage.exists(ID);
    const elsewhere = await mkdtemp(join(tmpdir(), 'sw-elsewhere-'));
    await writeFile(join(elsewhere, 'keep.txt'), 'keep');
    await symlink(elsewhere, join(scratch, `${ID}.extraction`));
    await storage.purge();
    expect(existsSync(join(elsewhere, 'keep.txt'))).toBe(true);
    expect((await readdir(scratch)).filter((n) => n !== '.safewatch-storage')).toEqual([]);
    await rm(elsewhere, { recursive: true, force: true });
  });
  it('does not touch foreign files that merely look similar', async () => {
    const storage = new LocalDiskMediaStorage(scratch);
    await storage.exists(ID);
    for (const n of [`${ID}.media.bak`, `${ID}.txt`, 'notes.media', `${ID.toUpperCase()}.media`, '.hidden']) await writeFile(join(scratch, n), 'mine');
    await mkdir(join(scratch, 'subdir'));
    await storage.purge();
    expect((await readdir(scratch)).sort()).toEqual(['.hidden', '.safewatch-storage', 'notes.media', 'subdir', `${ID}.media.bak`, `${ID}.txt`, `${ID.toUpperCase()}.media`].sort());
  });
  it('refuses to adopt a directory that already holds other files', async () => {
    await writeFile(join(scratch, 'precious.doc'), 'x');
    const storage = new LocalDiskMediaStorage(scratch);
    await expect(storage.save(ID, stream(mp4()), { maxBytes: 1e9 })).rejects.toBeInstanceOf(StorageError);
    expect(await readFile(join(scratch, 'precious.doc'), 'utf8')).toBe('x');
  });
  it('created files are owner-only', async () => {
    const storage = new LocalDiskMediaStorage(join(scratch, 'store'));
    await storage.save(ID, stream(mp4()), { maxBytes: 1e9 });
    const { statSync } = await import('node:fs');
    expect(statSync(join(scratch, 'store')).mode & 0o077).toBe(0);
    expect(statSync(join(scratch, 'store', `${ID}.media`)).mode & 0o077).toBe(0);
  });
});

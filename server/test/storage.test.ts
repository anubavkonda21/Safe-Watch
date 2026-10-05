import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { StorageError } from '../src/application/ports';
import { LocalDiskMediaStorage } from '../src/infrastructure/storage/localDiskMediaStorage';

let dir: string;
let root: string;
let storage: LocalDiskMediaStorage;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'sw-storage-')); root = dir; storage = new LocalDiskMediaStorage(dir); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function* chunks(...parts: string[]) { for (const p of parts) yield Buffer.from(p); }
async function readAll(it: AsyncIterable<Uint8Array>) { const out: Buffer[] = []; for await (const c of it) out.push(Buffer.from(c)); return Buffer.concat(out).toString(); }
const names = async () => (await readdir(dir)).filter((n) => n !== '.safewatch-storage');

describe('LocalDiskMediaStorage', () => {
  it('writes a stream, then exists/read/delete work', async () => {
    const id = randomUUID();
    expect(await storage.exists(id)).toBe(false);
    expect(await storage.save(id, chunks('hello ', 'world'), { maxBytes: 100 })).toEqual({ sizeBytes: 11 });
    expect(await storage.exists(id)).toBe(true);
    expect(await readAll(storage.read(id))).toBe('hello world');
    await storage.delete(id);
    expect(await storage.exists(id)).toBe(false);
    await expect(storage.delete(id)).resolves.toBeUndefined(); // idempotent
  });
  it('stores files with owner-only permissions in an owner-only directory', async () => {
    const id = randomUUID();
    await storage.save(id, chunks('x'), { maxBytes: 10 });
    expect((await stat(join(dir, `${id}.media`))).mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });
  it('writes to .part and only publishes .media when complete', async () => {
    const id = randomUUID();
    let during: string[] = [];
    async function* slow() {
      yield Buffer.from('a');
      // The write stream opens its file asynchronously: wait for it rather than assume timing.
      for (let i = 0; i < 100 && !(await names()).length; i++) await new Promise((r) => setTimeout(r, 10));
      during = await names();
      yield Buffer.from('b');
    }
    await storage.save(id, slow(), { maxBytes: 10 });
    expect(during).toEqual([`${id}.part`]);
    expect(await names()).toEqual([`${id}.media`]);
  });
  it('rejects oversized streams and leaves nothing behind', async () => {
    const id = randomUUID();
    await expect(storage.save(id, chunks('123456', '789012'), { maxBytes: 10 })).rejects.toMatchObject({ kind: 'too-large' });
    expect(await names()).toEqual([]);
  });
  it('cleans up when the source fails mid-stream, preserving the original error', async () => {
    const id = randomUUID();
    async function* broken() { yield Buffer.from('partial'); throw new Error('client went away'); }
    await expect(storage.save(id, broken(), { maxBytes: 100 })).rejects.toThrow('client went away');
    expect(await names()).toEqual([]);
  });
  it('cleans up and reports aborted when the signal fires', async () => {
    const id = randomUUID();
    const ac = new AbortController();
    async function* endless() { for (;;) { yield Buffer.from('x'); await new Promise((r) => setTimeout(r, 5)); } }
    setTimeout(() => ac.abort(), 30);
    await expect(storage.save(id, endless(), { maxBytes: 1e9, signal: ac.signal })).rejects.toMatchObject({ kind: 'aborted' });
    expect(await names()).toEqual([]);
  });
  it('refuses ids that are not server-generated UUIDs (path traversal)', async () => {
    for (const bad of ['../evil', '../../etc/passwd', 'a/b', '', 'x'.repeat(40), `${randomUUID()}/../x`]) {
      await expect(storage.save(bad, chunks('x'), { maxBytes: 10 })).rejects.toBeInstanceOf(StorageError);
      await expect(storage.delete(bad)).rejects.toBeInstanceOf(StorageError);
    }
    expect(await names()).toEqual([]);
  });
  it('hands out a local path only inside withLocalFile, and reports missing files', async () => {
    const id = randomUUID();
    await expect(storage.withLocalFile(id, async () => 1)).rejects.toMatchObject({ kind: 'not-found' });
    await storage.save(id, chunks('data'), { maxBytes: 10 });
    const p = await storage.withLocalFile(id, async (f) => f.path);
    expect(p).toBe(join(dir, `${id}.media`));
  });
  it('cleanup removes only owned files older than the threshold', async () => {
    const old = randomUUID(), fresh = randomUUID();
    await storage.save(old, chunks('x'), { maxBytes: 10 });
    await storage.save(fresh, chunks('y'), { maxBytes: 10 });
    const past = new Date(Date.now() - 2 * 3600_000);
    await utimes(join(dir, `${old}.media`), past, past);
    await writeFile(join(dir, 'notes.txt'), 'not ours');
    await utimes(join(dir, 'notes.txt'), past, past);
    expect(await storage.cleanup({ olderThanMs: 3600_000 })).toEqual({ removed: 1 });
    expect((await names()).sort()).toEqual([`${fresh}.media`, 'notes.txt'].sort());
  });
  it('purge removes every owned file but never foreign files', async () => {
    await storage.save(randomUUID(), chunks('x'), { maxBytes: 10 });
    await storage.save(randomUUID(), chunks('y'), { maxBytes: 10 });
    await writeFile(join(dir, 'keep.txt'), 'mine');
    expect(await storage.purge()).toEqual({ removed: 2 });
    expect(await names()).toEqual(['keep.txt']);
  });
  it('refuses to adopt a non-empty directory it did not create', async () => {
    const foreign = await mkdtemp(join(tmpdir(), 'sw-foreign-'));
    await writeFile(join(foreign, 'important.doc'), 'precious');
    const s = new LocalDiskMediaStorage(foreign);
    await expect(s.purge()).rejects.toBeInstanceOf(StorageError);
    expect(await readdir(foreign)).toEqual(['important.doc']);
    await rm(foreign, { recursive: true, force: true });
  });

  it('provides a private extraction directory per media and removes it with the media', async () => {
    const id = randomUUID();
    await storage.save(id, chunks('video'), { maxBytes: 100 });
    const dir = await storage.withExtractionDir(id, async (ws) => {
      await writeFile(join(ws.dir, 'x.txt'), 'derived');
      return ws.dir;
    });
    expect(dir).toBe(join(root, `${id}.extraction`));
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    await storage.delete(id);
    expect(await names()).toEqual([]);
  });
  it('only reads and deletes artifacts with server-generated names', async () => {
    const id = randomUUID();
    await storage.withExtractionDir(id, async (ws) => {
      await mkdir(join(ws.dir, 'frames'), { recursive: true });
      await writeFile(join(ws.dir, 'frames', 'frm-00000.jpg'), 'jpegbytes');
    });
    expect(await readAll(storage.readArtifact(id, 'frames/frm-00000.jpg'))).toBe('jpegbytes');
    await storage.deleteArtifact(id, 'frames/frm-00000.jpg');
    await expect(readAll(storage.readArtifact(id, 'frames/frm-00000.jpg'))).rejects.toThrow();
    for (const bad of ['../evil.jpg', 'frames/../../evil.jpg', 'frames/a b.jpg', '/etc/passwd', 'x.jpg']) {
      expect(() => storage.readArtifact(id, bad)).toThrow(StorageError);
    }
  });
  it('purge and age-based cleanup also remove extraction directories', async () => {
    const a = randomUUID(), b = randomUUID();
    await storage.withExtractionDir(a, async (ws) => writeFile(join(ws.dir, 'f'), 'x'));
    await storage.withExtractionDir(b, async (ws) => writeFile(join(ws.dir, 'f'), 'x'));
    const old = new Date(Date.now() - 2 * 3600_000);
    await utimes(join(root, `${a}.extraction`), old, old);
    expect(await storage.cleanup({ olderThanMs: 3600_000 })).toEqual({ removed: 1 });
    expect(await names()).toEqual([`${b}.extraction`]);
    expect(await storage.purge()).toEqual({ removed: 1 });
    expect(await names()).toEqual([]);
  });
});

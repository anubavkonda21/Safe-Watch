import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { StorageError, type LocalMediaFile, type MediaStorage } from '../../application/ports';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The only file names this storage will ever create, list or delete. */
const OWNED = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(media|part)$/;
const MARKER = '.safewatch-storage';

/**
 * Local-disk adapter. Files are named `<uuid>.media` (complete) or
 * `<uuid>.part` (upload in progress). Uploads are written to `.part` and
 * renamed only when complete, so a crash can never leave a half-written file
 * that looks finished. Directory 0700, files 0600.
 *
 * Safety: ids are validated before any path is built; the directory must
 * carry a marker file written by this class; purge/cleanup only touch names
 * matching OWNED, so a misconfigured directory is never wiped.
 */
export class LocalDiskMediaStorage implements MediaStorage {
  private readonly root: string;
  private ready: Promise<void> | null = null;

  constructor(rootDir: string) {
    this.root = resolve(rootDir);
  }

  private init(): Promise<void> {
    this.ready ??= (async () => {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const entries = await readdir(this.root);
      const foreign = entries.filter((n) => n !== MARKER);
      if (!entries.includes(MARKER)) {
        if (foreign.length > 0) {
          throw new StorageError('failed', 'Storage directory is not empty and was not created by SafeWatch');
        }
        await writeFile(join(this.root, MARKER), 'SafeWatch temporary media storage. Contents are deleted automatically.\n', { mode: 0o600 });
      }
    })().catch((e) => { this.ready = null; throw e instanceof StorageError ? e : new StorageError('failed'); });
    return this.ready;
  }

  private pathFor(id: string, ext: 'media' | 'part'): string {
    if (!ID.test(id)) throw new StorageError('failed', 'Invalid media id');
    const p = resolve(this.root, `${id}.${ext}`);
    if (!p.startsWith(this.root + sep)) throw new StorageError('failed', 'Invalid media path');
    return p;
  }

  async save(id: string, source: AsyncIterable<Uint8Array>, options: { maxBytes: number; signal?: AbortSignal }) {
    await this.init();
    const part = this.pathFor(id, 'part');
    const final = this.pathFor(id, 'media');
    let size = 0;
    const limited = async function* (): AsyncGenerator<Uint8Array> {
      for await (const chunk of source) {
        size += chunk.length;
        if (size > options.maxBytes) throw new StorageError('too-large');
        yield chunk;
      }
    };
    try {
      await pipeline(Readable.from(limited(), { objectMode: false }), createWriteStream(part, { flags: 'wx', mode: 0o600 }), { signal: options.signal });
      await rename(part, final);
      return { sizeBytes: size };
    } catch (e) {
      await rm(part, { force: true }).catch(() => undefined);
      await rm(final, { force: true }).catch(() => undefined);
      if (options.signal?.aborted) throw new StorageError('aborted');
      if (e instanceof Error && 'syscall' in e) throw new StorageError('failed'); // fs errors (ENOSPC, EACCES, ...)
      throw e;
    }
  }

  async exists(id: string): Promise<boolean> {
    await this.init();
    try { return (await stat(this.pathFor(id, 'media'))).isFile(); } catch { return false; }
  }

  read(id: string): AsyncIterable<Uint8Array> {
    return createReadStream(this.pathFor(id, 'media'));
  }

  async withLocalFile<T>(id: string, fn: (file: LocalMediaFile) => Promise<T>): Promise<T> {
    if (!(await this.exists(id))) throw new StorageError('not-found');
    return fn({ path: this.pathFor(id, 'media') });
  }

  async delete(id: string): Promise<void> {
    await this.init();
    await rm(this.pathFor(id, 'media'), { force: true });
    await rm(this.pathFor(id, 'part'), { force: true });
  }

  async cleanup({ olderThanMs }: { olderThanMs: number }) {
    await this.init();
    const cutoff = Date.now() - olderThanMs;
    return { removed: await this.removeOwned((s) => s.mtimeMs < cutoff) };
  }

  async purge() {
    await this.init();
    return { removed: await this.removeOwned(() => true) };
  }

  private async removeOwned(predicate: (s: { mtimeMs: number }) => boolean): Promise<number> {
    let removed = 0;
    for (const name of await readdir(this.root)) {
      if (!OWNED.test(name)) continue;
      const file = join(this.root, name);
      try {
        if (!predicate(await stat(file))) continue;
        await rm(file, { force: true });
        removed += 1;
      } catch {
        // Leave it for the next sweep.
      }
    }
    return removed;
  }
}

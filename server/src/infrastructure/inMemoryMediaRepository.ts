import type { MediaRepository } from '../application/ports';
import type { MediaRecord } from '../domain/mediaRecord';

/** Process-local registry. Lost on restart by design: storage is purged at startup to match. */
export class InMemoryMediaRepository implements MediaRepository {
  private readonly records = new Map<string, MediaRecord>();
  get = (id: string) => this.records.get(id);
  set = (record: MediaRecord) => { this.records.set(record.asset.id, record); };
  delete = (id: string) => { this.records.delete(id); };
  expired = (now: number) => [...this.records.values()].filter((r) => r.expiresAt <= now);
}

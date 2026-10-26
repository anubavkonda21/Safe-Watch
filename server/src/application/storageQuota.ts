export interface QuotaLimits {
  totalBytes: number;
  perOwnerBytes: number;
  maxMediaPerOwner: number;
}

export type QuotaDenial = 'total' | 'owner' | 'count';

export interface Reservation {
  readonly id: string;
  readonly bytes: number;
}

/**
 * Byte and item accounting for everything SafeWatch keeps on disk. Capacity is RESERVED before bytes are written, so
 * concurrent uploads cannot jointly exceed a budget (all operations are synchronous: no await between check and
 * reservation). A media item is charged for its original file and, while it is being extracted, for the worst case
 * its derived files can take; the charge is settled to the real size when extraction ends, and released when the media
 * is deleted, fails or expires. Nothing here ever deletes anything: it only says yes or no.
 */
export class StorageQuota {
  private readonly items = new Map<string, { owner: string; bytes: number }>();
  private total = 0;
  private readonly perOwner = new Map<string, { bytes: number; count: number }>();

  constructor(private readonly limits: QuotaLimits) {}

  /** Tries to reserve `bytes` for a new item. Returns the reservation or the reason it was refused. */
  reserve(id: string, owner: string, bytes: number): Reservation | QuotaDenial {
    if (!Number.isSafeInteger(bytes) || bytes < 0) return 'total';
    if (this.items.has(id)) return 'count';
    const o = this.perOwner.get(owner) ?? { bytes: 0, count: 0 };
    if (o.count >= this.limits.maxMediaPerOwner) return 'count';
    if (o.bytes + bytes > this.limits.perOwnerBytes) return 'owner';
    if (this.total + bytes > this.limits.totalBytes) return 'total';
    this.items.set(id, { owner, bytes });
    this.total += bytes;
    this.perOwner.set(owner, { bytes: o.bytes + bytes, count: o.count + 1 });
    return { id, bytes };
  }

  /** Changes an existing item's charge to `bytes` (smaller always succeeds; larger only within the budgets). */
  resize(id: string, bytes: number): boolean {
    const item = this.items.get(id);
    if (!item || !Number.isSafeInteger(bytes) || bytes < 0) return false;
    const delta = bytes - item.bytes;
    const o = this.perOwner.get(item.owner)!;
    if (delta > 0 && (o.bytes + delta > this.limits.perOwnerBytes || this.total + delta > this.limits.totalBytes)) return false;
    item.bytes = bytes;
    this.total += delta;
    o.bytes += delta;
    return true;
  }

  release(id: string): void {
    const item = this.items.get(id);
    if (!item) return;
    this.items.delete(id);
    this.total -= item.bytes;
    const o = this.perOwner.get(item.owner);
    if (o) {
      o.bytes -= item.bytes;
      o.count -= 1;
      if (o.count <= 0) this.perOwner.delete(item.owner);
    }
  }

  /** Ids that currently hold a charge (the sweep uses this to find accounting that no record backs any more). */
  ids(): string[] { return [...this.items.keys()]; }

  usage() {
    return { totalBytes: this.total, items: this.items.size, owners: this.perOwner.size };
  }
  bytesOf(id: string): number | undefined { return this.items.get(id)?.bytes; }
  ownerUsage(owner: string) { return this.perOwner.get(owner) ?? { bytes: 0, count: 0 }; }
}

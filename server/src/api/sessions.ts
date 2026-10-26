import { createHash, randomBytes } from 'node:crypto';

export const SESSION_COOKIE = 'sw_session';
const TOKEN = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes, base64url

/**
 * Anonymous per-browser sessions. A session is a 256-bit random secret held by the browser in an HttpOnly cookie;
 * the server keeps only its SHA-256 digest (the "owner id" that media records carry), so neither a media id nor a
 * memory/log dump of the owner ids is enough to act as that browser. There are no accounts and no passwords: this
 * separates browsers/profiles from each other on one machine, it does not identify people.
 *
 * Bounded: at most `maxSessions` live at once (the least recently used is dropped when a new one is needed) and each
 * expires after `ttlMs` without use. State is in memory and is lost on restart (as is all media).
 */
export class SessionStore {
  private readonly sessions = new Map<string, number>(); // ownerId -> last used (epoch ms); insertion order = LRU order

  constructor(
    private readonly options: { ttlMs: number; maxSessions: number; now?: () => number; random?: (n: number) => Buffer },
  ) {}

  private now() { return (this.options.now ?? Date.now)(); }

  static ownerOf(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /** Creates a session and returns the secret to hand to the browser, the owner id to store, and owners that were dropped to make room. */
  create(): { token: string; ownerId: string; dropped: string[] } {
    const dropped = this.prune();
    while (this.sessions.size >= this.options.maxSessions) {
      const oldest = this.sessions.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
      dropped.push(oldest);
    }
    const token = (this.options.random ?? randomBytes)(32).toString('base64url');
    const ownerId = SessionStore.ownerOf(token);
    this.sessions.set(ownerId, this.now());
    return { token, ownerId, dropped };
  }

  /** The owner id for a valid, unexpired token (refreshing it), otherwise null. */
  authenticate(token: string | undefined): string | null {
    if (token === undefined || !TOKEN.test(token)) return null;
    const ownerId = SessionStore.ownerOf(token);
    const last = this.sessions.get(ownerId);
    if (last === undefined) return null;
    if (this.now() - last > this.options.ttlMs) { this.sessions.delete(ownerId); return null; }
    this.sessions.delete(ownerId); // move to the most-recent end
    this.sessions.set(ownerId, this.now());
    return ownerId;
  }

  /** Drops expired sessions. Returns their owner ids so the caller can release anything they held. */
  prune(): string[] {
    const cutoff = this.now() - this.options.ttlMs;
    const gone: string[] = [];
    for (const [id, last] of this.sessions) {
      if (last >= cutoff) break; // ordered by last use
      this.sessions.delete(id);
      gone.push(id);
    }
    return gone;
  }

  has(ownerId: string): boolean { return this.sessions.has(ownerId); }
  get size() { return this.sessions.size; }
}

/** Extracts the session token from a Cookie header, without trusting its shape. */
export function tokenFromCookie(header: string | undefined): string | undefined {
  if (!header || header.length > 4096) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE) return part.slice(eq + 1).trim();
  }
  return undefined;
}

export function sessionCookie(token: string, options: { maxAgeSeconds: number; secure: boolean }): string {
  // Path=/api: sent for every API call (including frame images) and nowhere else. SameSite=Strict: never sent on cross-site requests.
  return `${SESSION_COOKIE}=${token}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${options.maxAgeSeconds}${options.secure ? '; Secure' : ''}`;
}

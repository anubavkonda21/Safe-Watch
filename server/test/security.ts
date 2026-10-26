import { SessionStore } from '../src/api/sessions';
import type { RateConfig, SecurityConfig } from '../src/config';
import { StorageQuota, type QuotaLimits } from '../src/application/storageQuota';

const MB = 1024 * 1024;

/** Generous defaults for tests and local check scripts: security is ON, but limits are far from ordinary use. */
export function testSecurity(opts: { quota?: Partial<QuotaLimits>; rate?: Partial<RateConfig>; security?: Partial<SecurityConfig>; now?: () => number; maxSessions?: number } = {}) {
  const security: SecurityConfig = {
    allowedHosts: ['127.0.0.1', 'localhost'],
    cookieSecure: false,
    sessionTtlMs: 60 * 60_000,
    maxSessions: opts.maxSessions ?? 100,
    ...opts.security,
  };
  const rate: RateConfig = { uploadsPerMinute: 1000, analysisPerMinute: 1000, readsPerMinute: 100_000, otherPerMinute: 100_000, maxKeys: 1000, ...opts.rate };
  const quota = new StorageQuota({ totalBytes: 1024 * MB * 100, perOwnerBytes: 1024 * MB * 50, maxMediaPerOwner: 1000, ...opts.quota });
  const sessions = new SessionStore({ ttlMs: security.sessionTtlMs, maxSessions: security.maxSessions, now: opts.now });
  return { security, rate, quota, sessions };
}

const jars = new Map<string, string>(); // origin -> cookie header value
let original: typeof fetch | null = null;

/**
 * Makes the global fetch behave like one browser profile: it stores the session cookie a server sets and sends it back
 * to that origin. A request that carries its own `cookie` header, or `x-test-no-jar`, bypasses the jar so a test can
 * play a different browser or an anonymous client.
 */
export function installCookieJar(): void {
  if (original) return;
  original = globalThis.fetch;
  const real = original;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url);
    const headers = new Headers(init?.headers);
    const bypass = headers.has('x-test-no-jar');
    headers.delete('x-test-no-jar');
    if (!bypass && !headers.has('cookie') && jars.has(url.origin)) headers.set('cookie', jars.get(url.origin)!);
    const res = await real(input, { ...init, headers });
    const set = res.headers.getSetCookie?.() ?? [];
    if (!bypass && set.length > 0) {
      const pair = set[0]!.split(';')[0]!;
      jars.set(url.origin, pair);
    }
    return res;
  }) as typeof fetch;
}

export const cookieOf = (res: Response): string | undefined => res.headers.getSetCookie?.()[0]?.split(';')[0];
export const forgetCookies = (): void => jars.clear();

/** Plays "this browser already has a session": the jar sends `cookie` to `origin` from now on. */
export const setCookie = (origin: string, cookiePair: string): void => { jars.set(origin, cookiePair); };

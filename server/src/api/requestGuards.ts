/**
 * Request-level guards that need no state.
 *
 * checkHost: DNS-rebinding defence. A malicious web page can make its own domain resolve to 127.0.0.1 and then talk to
 * this server "same-origin" from the browser's point of view; the only thing that differs is the Host header. The API
 * therefore answers only to host names it was configured with.
 *
 * checkOrigin: browsers attach `Origin` to cross-origin requests and to every non-GET request, and `Sec-Fetch-Site` to
 * all requests. A request is refused if it declares an origin that is neither allow-listed nor the server's own, or if
 * the browser says it is cross-site. Requests without those headers (curl, scripts, server-to-server) carry no ambient
 * browser credentials and are governed by the session cookie alone.
 */
export function checkHost(host: string | undefined, allowedHosts: readonly string[]): boolean {
  if (typeof host !== 'string' || host.length === 0 || host.length > 255) return false;
  const h = host.toLowerCase();
  if (allowedHosts.includes(h)) return true; // "name:port" entries match exactly
  // A bare name matches on any port: the attack is about the NAME the browser resolved, not the port.
  const name = h.startsWith('[') ? h.slice(0, h.indexOf(']') + 1) : h.split(':')[0]!;
  return name.length > 0 && allowedHosts.includes(name);
}

export function checkOrigin(
  origin: string | string[] | undefined,
  fetchSite: string | string[] | undefined,
  host: string | undefined,
  allowedOrigins: readonly string[],
): boolean {
  if (Array.isArray(origin) || Array.isArray(fetchSite)) return false;
  if (fetchSite === 'cross-site') return false;
  if (origin === undefined) return true;
  if (allowedOrigins.includes(origin)) return true;
  // Same origin as the page that was served from this very host (the SPA and API behind one name).
  if (typeof host === 'string') {
    try {
      const o = new URL(origin);
      if (o.host.toLowerCase() === host.toLowerCase() && (o.protocol === 'http:' || o.protocol === 'https:')) return true;
    } catch { /* "null" and other non-URLs fall through */ }
  }
  return false;
}

import type { IncomingMessage, ServerResponse } from 'node:http';

const ALLOW_HEADERS = 'content-type, x-safewatch-filename, x-request-id';

/**
 * Explicit-origin CORS. Responses never use "*". Credentials are not enabled
 * (the API has no cookies). A browser on any other origin gets no CORS
 * headers and is blocked by the browser itself.
 *
 * Returns true if the request was a preflight and has been fully answered.
 */
export function applyCors(req: IncomingMessage, res: ServerResponse, allowedOrigins: readonly string[]): boolean {
  const origin = req.headers.origin;
  const allowed = typeof origin === 'string' && allowedOrigins.includes(origin);
  res.setHeader('Vary', 'Origin');
  if (allowed) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Expose-Headers', 'x-request-id, location');
  }
  if (req.method !== 'OPTIONS') return false;
  if (allowed) {
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', ALLOW_HEADERS);
    res.setHeader('Access-Control-Max-Age', '600');
    res.writeHead(204).end();
  } else {
    res.writeHead(403).end();
  }
  return true;
}

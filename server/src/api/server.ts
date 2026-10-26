import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { API_PATHS, FILENAME_HEADER, type ApiErrorCode, type HealthResponse } from '@/domain/api/contract';
import { MediaServiceError } from '../application/errors';
import type { MediaService } from '../application/mediaService';
import type { Logger } from '../application/ports';
import { MAX_SAFETY_BODY_BYTES, parseSafetyTerms, readLimitedBody } from './safetyRequest';
import { applyCors } from './cors';
import { STATUS_FOR, errorBody } from './errors';
import { RateLimiter } from './rateLimiter';
import { SessionStore, sessionCookie, tokenFromCookie } from './sessions';
import { checkHost, checkOrigin } from './requestGuards';
import type { RateConfig, SecurityConfig } from '../config';

export interface ApiDeps {
  mediaService: MediaService;
  logger: Logger;
  limits: { uploadTimeoutMs: number };
  allowedOrigins: readonly string[];
  security: SecurityConfig;
  rate: RateConfig;
  sessions: SessionStore;
  /** Test hook: a clock for the rate limiters. */
  now?: () => number;
  health: { version: string; environment: string; tools: { ffmpeg: boolean; ffprobe: boolean }; speech: { provider: string; available: boolean }; vision: { provider: string; available: boolean } };
}

const REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/;

/**
 * A boolean query option. Only the exact strings "true" and "false" are accepted, and unknown parameters are refused,
 * so a typo or a probing request is an error instead of being silently reinterpreted.
 */
function flag(url: URL, name: string, allowed: readonly string[]): boolean {
  for (const key of url.searchParams.keys()) if (!allowed.includes(key)) throw new MediaServiceError('INVALID_REQUEST');
  const all = url.searchParams.getAll(name);
  if (all.length === 0) return true;
  if (all.length > 1 || (all[0] !== 'true' && all[0] !== 'false')) throw new MediaServiceError('INVALID_REQUEST');
  return all[0] === 'true';
}
const noQuery = (url: URL) => { if ([...url.searchParams.keys()].length > 0) throw new MediaServiceError('INVALID_REQUEST'); };
const MAX_FILENAME_HEADER = 1024;

/**
 * HTTP adapter. Parses requests, calls the application layer, and renders
 * responses. It contains no media rules, storage or FFmpeg code.
 */
type Limiters = Record<'upload' | 'analysis' | 'read' | 'other', RateLimiter>;

export function createApiServer(deps: ApiDeps): Server {
  const mk = (limit: number) => new RateLimiter({ limit, windowMs: 60_000, maxKeys: deps.rate.maxKeys, now: deps.now });
  const limiters: Limiters = { upload: mk(deps.rate.uploadsPerMinute), analysis: mk(deps.rate.analysisPerMinute), read: mk(deps.rate.readsPerMinute), other: mk(deps.rate.otherPerMinute) };
  const server = createServer((req, res) => {
    void handle(req, res, deps, limiters);
  });
  server.maxConnections = 256;
  // Slow-header attacks are cut off quickly; the body deadline is enforced per upload.
  server.headersTimeout = 15_000;
  server.requestTimeout = deps.limits.uploadTimeoutMs + 60_000;
  server.keepAliveTimeout = 5_000;
  return server;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(payload);
}

function sendError(req: IncomingMessage, res: ServerResponse, code: ApiErrorCode, requestId: string, closeConnection = false, extra: Record<string, string> = {}): void {
  const headers: Record<string, string> = { ...extra };
  if (code === 'SERVER_BUSY') headers['retry-after'] = '5';
  if (closeConnection) {
    // The body was not (fully) consumed: do not reuse this connection.
    headers.connection = 'close';
    res.once('finish', () => req.destroy());
  }
  sendJson(res, STATUS_FOR[code], errorBody(code, requestId), headers);
}

async function handle(req: IncomingMessage, res: ServerResponse, deps: ApiDeps, limiters: Limiters): Promise<void> {
  const started = Date.now();
  const incoming = req.headers['x-request-id'];
  const requestId = typeof incoming === 'string' && REQUEST_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader('x-request-id', requestId);
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  let code: ApiErrorCode | null = null;
  let consumedBody = false;

  const unsafe = req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS';
  try {
    // 1. Which server is the browser talking to? A rebinding page reaches us with its own Host name: refuse it.
    if (!checkHost(req.headers.host, deps.security.allowedHosts)) {
      code = 'INVALID_REQUEST';
      return sendJson(res, 403, errorBody(code, requestId), unsafe ? { connection: 'close' } : {});
    }
    // 2. Who is asking? A foreign Origin (or a cross-site fetch) is refused before anything else happens.
    if (!checkOrigin(req.headers.origin, req.headers['sec-fetch-site'], req.headers.host, deps.allowedOrigins)) {
      code = 'INVALID_REQUEST';
      return sendJson(res, 403, errorBody(code, requestId), unsafe ? { connection: 'close' } : {});
    }
    if (applyCors(req, res, deps.allowedOrigins)) return;

    // 3. Session (cookie → owner) and rate limit. Limits are per session, or per address before a session exists.
    const owner = deps.sessions.authenticate(tokenFromCookie(req.headers.cookie));
    const isUpload = path === API_PATHS.media && req.method === 'POST';
    const isAnalysis = req.method === 'POST' && /^\/api\/media\/[^/]+\/safety-findings$/.test(path);
    const klass: keyof Limiters = isUpload ? 'upload' : isAnalysis ? 'analysis' : path.startsWith('/api/media/') && req.method === 'GET' ? 'read' : 'other';
    const hit = limiters[klass].hit(owner ? `s:${owner}` : `a:${req.socket.remoteAddress ?? 'unknown'}`);
    if (!hit.allowed) {
      code = 'RATE_LIMITED';
      return sendError(req, res, code, requestId, unsafe, { 'retry-after': String(Math.ceil(hit.retryAfterMs / 1000)) });
    }

    if (path === API_PATHS.health) {
      if (req.method !== 'GET') {
        code = 'NOT_FOUND';
        return sendError(req, res, code, requestId);
      }
      const { tools, version, environment, speech, vision } = deps.health;
      const body: HealthResponse = { status: tools.ffmpeg && tools.ffprobe ? 'ok' : 'degraded', service: 'safewatch-api', version, environment, tools, speech, vision };
      return sendJson(res, 200, body);
    }

    if (path === API_PATHS.media && req.method === 'POST') {
      consumedBody = true;
      // The first upload of a browser starts its session. The secret goes back only in an HttpOnly cookie.
      let ownerId = owner;
      const headers: Record<string, string> = {};
      if (ownerId === null) {
        const created = deps.sessions.create();
        if (created.dropped.length > 0) void deps.mediaService.deleteOwners(created.dropped);
        ownerId = created.ownerId;
        headers['set-cookie'] = sessionCookie(created.token, { maxAgeSeconds: Math.floor(deps.security.sessionTtlMs / 1000), secure: deps.security.cookieSecure });
      }
      const resource = await uploadHandler(req, deps, requestId, ownerId);
      return sendJson(res, 202, { media: resource }, { location: `${API_PATHS.media}/${resource.asset.id}`, ...headers });
    }

    // Everything below belongs to a session. No (or an unknown/expired) session: 401, the same for every id.
    if (owner === null && path.startsWith('/api/media')) {
      code = 'UNAUTHENTICATED';
      return sendError(req, res, code, requestId, unsafe);
    }

    const extractionMatch = /^\/api\/media\/([^/]+)\/extraction$/.exec(path);
    if (extractionMatch?.[1] && req.method === 'GET') {
      noQuery(url);
      return sendJson(res, 200, { extraction: deps.mediaService.getExtraction(extractionMatch[1], owner!) });
    }

    const transcriptMatch = /^\/api\/media\/([^/]+)\/transcript$/.exec(path);
    if (transcriptMatch?.[1] && req.method === 'GET') {
      return sendJson(res, 200, { textAnalysis: deps.mediaService.getTextAnalysis(transcriptMatch[1], owner!, { words: flag(url, 'words', ['words']) }) });
    }

    const safetyMatch = /^\/api\/media\/([^/]+)\/safety-findings$/.exec(path);
    if (safetyMatch?.[1] && (req.method === 'GET' || req.method === 'POST')) {
      noQuery(url);
      let terms: ReturnType<typeof parseSafetyTerms> = [];
      if (req.method === 'POST') {
        consumedBody = true;
        terms = parseSafetyTerms(await readLimitedBody(req, MAX_SAFETY_BODY_BYTES), req.headers['content-type']);
      }
      return sendJson(res, 200, { safety: await deps.mediaService.getSafetyFindings(safetyMatch[1], owner!, terms) });
    }

    const contextMatch = /^\/api\/media\/([^/]+)\/context$/.exec(path);
    if (contextMatch?.[1] && req.method === 'GET') {
      return sendJson(res, 200, { context: deps.mediaService.getContext(contextMatch[1], owner!, { evidence: flag(url, 'evidence', ['evidence']) }) });
    }

    const visualMatch = /^\/api\/media\/([^/]+)\/visual$/.exec(path);
    if (visualMatch?.[1] && req.method === 'GET') {
      return sendJson(res, 200, { visualAnalysis: deps.mediaService.getVisualAnalysis(visualMatch[1], owner!, { observations: flag(url, 'observations', ['observations']) }) });
    }

    const frameMatch = /^\/api\/media\/([^/]+)\/frames\/(frm-\d{5})$/.exec(path);
    if (frameMatch?.[1] && frameMatch[2] && req.method === 'GET') {
      noQuery(url);
      return await sendFrame(res, deps.mediaService.getFrame(frameMatch[1], owner!, frameMatch[2]));
    }

    const match = /^\/api\/media\/([^/]+)$/.exec(path);
    if (match?.[1] && (req.method === 'GET' || req.method === 'DELETE')) {
      noQuery(url);
      const id = match[1];
      if (req.method === 'GET') return sendJson(res, 200, { media: deps.mediaService.get(id, owner!) });
      await deps.mediaService.delete(id, owner!);
      res.writeHead(204).end();
      return;
    }

    code = 'NOT_FOUND';
    sendError(req, res, code, requestId);
  } catch (e) {
    code = e instanceof MediaServiceError ? e.code : 'INTERNAL_ERROR';
    if (!(e instanceof MediaServiceError)) deps.logger.error('unhandled request error', { op: 'http', requestId, reason: e instanceof Error ? e.name : 'unknown' });
    sendError(req, res, code, requestId, consumedBody);
  } finally {
    deps.logger.info('request', { op: 'http', requestId, method: req.method, path: path.startsWith('/api/media/') ? path.replace(/^\/api\/media\/[^/]+/, '/api/media/:id') : path, status: res.statusCode, errorCode: code, durationMs: Date.now() - started });
  }
}

/** Sampled frames are derived media: served as images only, never sniffed, never executed or embedded elsewhere. */
async function sendFrame(res: ServerResponse, frame: { stream: AsyncIterable<Uint8Array>; sizeBytes: number }): Promise<void> {
  res.writeHead(200, {
    'content-type': 'image/jpeg',
    'content-length': frame.sizeBytes,
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox",
  });
  try {
    for await (const chunk of frame.stream) if (!res.write(chunk)) await new Promise<void>((r) => res.once('drain', r));
    res.end();
  } catch {
    res.destroy();
  }
}

async function uploadHandler(req: IncomingMessage, deps: ApiDeps, requestId: string, ownerId: string) {
  const rawName = req.headers[FILENAME_HEADER];
  if (typeof rawName !== 'string' || rawName.length === 0 || rawName.length > MAX_FILENAME_HEADER) throw new MediaServiceError('INVALID_FILE');
  let filename: string;
  try { filename = decodeURIComponent(rawName); } catch { throw new MediaServiceError('INVALID_FILE'); }

  const mimeType = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  const lengthHeader = req.headers['content-length'];
  let contentLength: number | null = null;
  if (lengthHeader !== undefined) {
    contentLength = Number(lengthHeader);
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) throw new MediaServiceError('INVALID_FILE');
  }

  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), deps.limits.uploadTimeoutMs);
  try {
    return await deps.mediaService.upload({ body: req, filename, mimeType, contentLength, signal: deadline.signal, requestId, ownerId });
  } finally {
    clearTimeout(timer);
  }
}

import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { API_PATHS, FILENAME_HEADER, type ApiErrorCode, type HealthResponse } from '@/domain/api/contract';
import { MediaServiceError } from '../application/errors';
import type { MediaService } from '../application/mediaService';
import type { Logger } from '../application/ports';
import { applyCors } from './cors';
import { STATUS_FOR, errorBody } from './errors';

export interface ApiDeps {
  mediaService: MediaService;
  logger: Logger;
  limits: { uploadTimeoutMs: number };
  allowedOrigins: readonly string[];
  health: { version: string; environment: string; tools: { ffmpeg: boolean; ffprobe: boolean }; speech: { provider: string; available: boolean } };
}

const REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/;
const MAX_FILENAME_HEADER = 1024;

/**
 * HTTP adapter. Parses requests, calls the application layer, and renders
 * responses. It contains no media rules, storage or FFmpeg code.
 */
export function createApiServer(deps: ApiDeps): Server {
  const server = createServer((req, res) => {
    void handle(req, res, deps);
  });
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

function sendError(req: IncomingMessage, res: ServerResponse, code: ApiErrorCode, requestId: string, closeConnection = false): void {
  const headers: Record<string, string> = {};
  if (code === 'SERVER_BUSY') headers['retry-after'] = '5';
  if (closeConnection) {
    // The body was not (fully) consumed: do not reuse this connection.
    headers.connection = 'close';
    res.once('finish', () => req.destroy());
  }
  sendJson(res, STATUS_FOR[code], errorBody(code, requestId), headers);
}

async function handle(req: IncomingMessage, res: ServerResponse, deps: ApiDeps): Promise<void> {
  const started = Date.now();
  const incoming = req.headers['x-request-id'];
  const requestId = typeof incoming === 'string' && REQUEST_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader('x-request-id', requestId);
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  let code: ApiErrorCode | null = null;
  let consumedBody = false;

  try {
    if (applyCors(req, res, deps.allowedOrigins)) return;

    if (path === API_PATHS.health) {
      if (req.method !== 'GET') {
        code = 'NOT_FOUND';
        return sendError(req, res, code, requestId);
      }
      const { tools, version, environment, speech } = deps.health;
      const body: HealthResponse = { status: tools.ffmpeg && tools.ffprobe ? 'ok' : 'degraded', service: 'safewatch-api', version, environment, tools, speech };
      return sendJson(res, 200, body);
    }

    if (path === API_PATHS.media && req.method === 'POST') {
      consumedBody = true;
      const resource = await uploadHandler(req, deps, requestId);
      return sendJson(res, 202, { media: resource }, { location: `${API_PATHS.media}/${resource.asset.id}` });
    }

    const extractionMatch = /^\/api\/media\/([^/]+)\/extraction$/.exec(path);
    if (extractionMatch?.[1] && req.method === 'GET') {
      return sendJson(res, 200, { extraction: deps.mediaService.getExtraction(extractionMatch[1]) });
    }

    const transcriptMatch = /^\/api\/media\/([^/]+)\/transcript$/.exec(path);
    if (transcriptMatch?.[1] && req.method === 'GET') {
      return sendJson(res, 200, { textAnalysis: deps.mediaService.getTextAnalysis(transcriptMatch[1], { words: url.searchParams.get('words') !== 'false' }) });
    }

    const match = /^\/api\/media\/([^/]+)$/.exec(path);
    if (match?.[1] && (req.method === 'GET' || req.method === 'DELETE')) {
      const id = match[1];
      if (req.method === 'GET') return sendJson(res, 200, { media: deps.mediaService.get(id) });
      await deps.mediaService.delete(id);
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

async function uploadHandler(req: IncomingMessage, deps: ApiDeps, requestId: string) {
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
    return await deps.mediaService.upload({ body: req, filename, mimeType, contentLength, signal: deadline.signal, requestId });
  } finally {
    clearTimeout(timer);
  }
}

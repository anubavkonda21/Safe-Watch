import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface ServerConfig {
  environment: 'development' | 'production' | 'test';
  host: string;
  port: number;
  /** Dedicated directory for temporary media. Never exposed to clients. */
  storageDir: string;
  maxUploadBytes: number;
  /** Explicit origins allowed to call the API cross-origin. "*" is rejected. */
  allowedOrigins: string[];
  uploadTimeoutMs: number;
  processingTimeoutMs: number;
  maxConcurrentUploads: number;
  maxConcurrentProcessing: number;
  maxQueuedProcessing: number;
  /** How long a stored upload (and its record) may live. */
  retentionMs: number;
  sweepIntervalMs: number;
  ffmpegPath: string;
  ffprobePath: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error' | 'silent';
}

type Env = Record<string, string | undefined>;

function int(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`Invalid ${name} "${raw}": expected an integer between ${min} and ${max}.`);
  }
  return n;
}

function oneOf<T extends string>(env: Env, name: string, allowed: readonly T[], fallback: T): T {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!(allowed as readonly string[]).includes(raw)) throw new Error(`Invalid ${name} "${raw}": expected one of ${allowed.join(', ')}.`);
  return raw as T;
}

function origins(env: Env): string[] {
  const raw = env.SAFEWATCH_ALLOWED_ORIGINS?.trim() ?? 'http://localhost:5173,http://127.0.0.1:5173';
  return raw.split(',').map((o) => o.trim()).filter(Boolean).map((o) => {
    let url: URL;
    try { url = new URL(o); } catch { throw new Error(`Invalid SAFEWATCH_ALLOWED_ORIGINS entry "${o}": not a URL.`); }
    if (o === '*' || url.origin !== o.replace(/\/$/, '')) {
      throw new Error(`Invalid SAFEWATCH_ALLOWED_ORIGINS entry "${o}": use exact origins such as https://app.example.com (no wildcard, path or trailing slash).`);
    }
    return url.origin;
  });
}

/** Parses and validates server configuration. Throws on invalid values so misconfiguration fails at startup. */
export function parseServerConfig(env: Env): ServerConfig {
  const MIN = 60_000;
  return {
    environment: oneOf(env, 'NODE_ENV', ['development', 'production', 'test'] as const, 'development'),
    host: env.SAFEWATCH_HOST?.trim() || '127.0.0.1',
    port: int(env, 'SAFEWATCH_PORT', 8787, 0, 65535),
    storageDir: env.SAFEWATCH_STORAGE_DIR?.trim() || join(tmpdir(), 'safewatch-media'),
    maxUploadBytes: int(env, 'SAFEWATCH_MAX_UPLOAD_MB', 2048, 1, 8192) * 1024 * 1024,
    allowedOrigins: origins(env),
    uploadTimeoutMs: int(env, 'SAFEWATCH_UPLOAD_TIMEOUT_MS', 30 * MIN, 1000, 6 * 60 * MIN),
    processingTimeoutMs: int(env, 'SAFEWATCH_PROCESSING_TIMEOUT_MS', MIN, 1000, 60 * MIN),
    maxConcurrentUploads: int(env, 'SAFEWATCH_MAX_CONCURRENT_UPLOADS', 4, 1, 100),
    maxConcurrentProcessing: int(env, 'SAFEWATCH_MAX_CONCURRENT_PROCESSING', 2, 1, 32),
    maxQueuedProcessing: int(env, 'SAFEWATCH_MAX_QUEUED_PROCESSING', 20, 0, 1000),
    retentionMs: int(env, 'SAFEWATCH_RETENTION_MINUTES', 60, 1, 7 * 24 * 60) * MIN,
    sweepIntervalMs: int(env, 'SAFEWATCH_SWEEP_INTERVAL_SECONDS', 60, 1, 3600) * 1000,
    ffmpegPath: env.SAFEWATCH_FFMPEG_PATH?.trim() || 'ffmpeg',
    ffprobePath: env.SAFEWATCH_FFPROBE_PATH?.trim() || 'ffprobe',
    logLevel: oneOf(env, 'SAFEWATCH_LOG_LEVEL', ['debug', 'info', 'warn', 'error', 'silent'] as const, 'info'),
  };
}

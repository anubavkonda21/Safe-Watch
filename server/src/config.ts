import { tmpdir } from 'node:os';
import { DEFAULT_CONTEXT_CONFIG, type ContextConfig } from '@/domain/context/contextEvent';
import { join, resolve } from 'node:path';

/** Everything that bounds extraction work. See SAFEWATCH_MEDIA_ARCHITECTURE.md for the reasoning behind the defaults. */
export interface ExtractionConfig {
  /** Wall-clock limit for one whole extraction job. */
  timeoutMs: number;
  maxConcurrent: number;
  maxQueued: number;
  frame: { intervalSeconds: number; maxFrames: number; maxWidth: number; maxHeight: number };
  /** Maximum total bytes of all sampled frames for one media item. */
  maxFrameBytes: number;
  /** Maximum total bytes of all extracted audio of one media item (WAV, 16 kHz mono ≈ 115 MB per hour per track). */
  maxAudioBytes: number;
  maxAudioTracks: number;
  /** Per subtitle track. */
  maxCues: number;
  maxSubtitleBytes: number;
}

export interface SpeechConfig {
  /** `none`: no speech-to-text (subtitle evidence is still collected). */
  provider: 'none' | 'whispercpp';
  binaryPath: string;
  /** Path of the model file. Server-side only; never exposed through the API. */
  modelPath: string | null;
  /** Display name of the model (derived from the file name; no path). */
  modelName: string;
  /** `auto` = detect the spoken language; otherwise an ISO 639-1 code to force (also the preferred audio-track language). */
  language: string;
  /** Wall-clock limit per transcribed audio track. */
  timeoutMs: number;
  maxAudioBytes: number;
  maxDurationSeconds: number;
  maxConcurrent: number;
  maxQueued: number;
  /** How many audio tracks to transcribe per media item. */
  maxTracks: number;
  threads: number;
}

export interface VisionConfig {
  /** `none`: no visual analysis. `apple-vision`: on-device Apple Vision through the safewatch-vision helper (macOS only). */
  provider: 'none' | 'apple-vision';
  binaryPath: string;
  /** Wall-clock limit per batch of frames. The first run after a reboot compiles Apple's models and can take ~30 s. */
  timeoutMs: number;
  /** Frames beyond this many are skipped (reported, never silent). */
  maxFrames: number;
  /** Frames handed to one helper process. */
  batchSize: number;
  /** Per-frame size limit; larger frames are refused before decoding. */
  maxFrameBytes: number;
  minConfidence: number;
  maxLabelsPerFrame: number;
  maxObservationsPerFrame: number;
  maxConcurrent: number;
  maxQueued: number;
}

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
  extraction: ExtractionConfig;
  speech: SpeechConfig;
  vision: VisionConfig;
  /** Temporal correlation settings (see src/domain/context/contextEvent.ts for the reasoning behind the defaults). */
  context: ContextConfig;
  logLevel: 'debug' | 'info' | 'warn' | 'error' | 'silent';
  security: SecurityConfig;
  rate: RateConfig;
  quota: QuotaConfig;
  sandbox: 'auto' | 'seatbelt' | 'none';
  /** Startup fails if the OS sandbox is requested/required and cannot be applied. */
  requireSandbox: boolean;
  /** How long shutdown waits for child processes after asking them to stop. */
  shutdownGraceMs: number;
}

export interface SecurityConfig {
  /** Host header values (name or name:port) the API answers to. Anything else is refused (DNS-rebinding defence). */
  allowedHosts: string[];
  /** Adds the Secure attribute to the session cookie. Required behind HTTPS; browsers reject Secure cookies on plain http (except localhost in some). */
  cookieSecure: boolean;
  sessionTtlMs: number;
  maxSessions: number;
}

export interface RateConfig {
  uploadsPerMinute: number;
  analysisPerMinute: number;
  readsPerMinute: number;
  otherPerMinute: number;
  /** Upper bound on distinct limiter keys held in memory (oldest evicted). */
  maxKeys: number;
}

export interface QuotaConfig {
  totalBytes: number;
  perSessionBytes: number;
  maxMediaPerSession: number;
  /** Free space that must remain on the storage volume after an upload is accepted. */
  minFreeDiskBytes: number;
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

function speech(env: Env): SpeechConfig {
  const provider = oneOf(env, 'SAFEWATCH_SPEECH_PROVIDER', ['none', 'whispercpp'] as const, 'none');
  const modelRaw = env.SAFEWATCH_SPEECH_MODEL_PATH?.trim() || null;
  const modelPath = modelRaw ? resolve(modelRaw) : null;
  if (provider === 'whispercpp' && !modelPath) throw new Error('SAFEWATCH_SPEECH_MODEL_PATH is required when SAFEWATCH_SPEECH_PROVIDER=whispercpp.');
  const language = (env.SAFEWATCH_SPEECH_LANGUAGE?.trim() || 'auto').toLowerCase();
  if (language !== 'auto' && !/^[a-z]{2,3}$/.test(language)) throw new Error(`Invalid SAFEWATCH_SPEECH_LANGUAGE "${language}": expected "auto" or a language code such as "en" or "hi".`);
  return {
    provider,
    binaryPath: absIfPath(env.SAFEWATCH_SPEECH_BINARY?.trim() || 'whisper-cli'),
    modelPath,
    modelName: modelPath ? (modelPath.split(/[\\/]/).pop() ?? '').replace(/\.bin$/, '') || 'model' : 'none',
    language,
    timeoutMs: int(env, 'SAFEWATCH_SPEECH_TIMEOUT_MS', 10 * 60_000, 1000, 6 * 60 * 60_000),
    maxAudioBytes: int(env, 'SAFEWATCH_SPEECH_MAX_AUDIO_MB', 256, 1, 4096) * 1024 * 1024,
    maxDurationSeconds: int(env, 'SAFEWATCH_SPEECH_MAX_DURATION_SECONDS', 3600, 1, 6 * 3600),
    maxConcurrent: int(env, 'SAFEWATCH_MAX_CONCURRENT_SPEECH', 1, 1, 4),
    maxQueued: int(env, 'SAFEWATCH_MAX_QUEUED_SPEECH', 20, 0, 1000),
    maxTracks: int(env, 'SAFEWATCH_SPEECH_MAX_TRACKS', 1, 1, 8),
    threads: int(env, 'SAFEWATCH_SPEECH_THREADS', 4, 1, 32),
  };
}

function vision(env: Env): VisionConfig {
  const minConfidence = Number(env.SAFEWATCH_VISION_MIN_CONFIDENCE?.trim() || '0.1');
  if (!Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1) throw new Error(`Invalid SAFEWATCH_VISION_MIN_CONFIDENCE "${env.SAFEWATCH_VISION_MIN_CONFIDENCE}": expected a number between 0 and 1.`);
  return {
    provider: oneOf(env, 'SAFEWATCH_VISION_PROVIDER', ['none', 'apple-vision'] as const, 'none'),
    binaryPath: absIfPath(env.SAFEWATCH_VISION_BINARY?.trim() || 'bin/safewatch-vision'),
    timeoutMs: int(env, 'SAFEWATCH_VISION_TIMEOUT_MS', 2 * 60_000, 1000, 60 * 60_000),
    maxFrames: int(env, 'SAFEWATCH_VISION_MAX_FRAMES', 300, 1, 2000),
    batchSize: int(env, 'SAFEWATCH_VISION_BATCH_SIZE', 8, 1, 32),
    maxFrameBytes: int(env, 'SAFEWATCH_VISION_MAX_FRAME_MB', 8, 1, 64) * 1024 * 1024,
    minConfidence,
    maxLabelsPerFrame: int(env, 'SAFEWATCH_VISION_MAX_LABELS', 8, 1, 50),
    maxObservationsPerFrame: int(env, 'SAFEWATCH_VISION_MAX_OBSERVATIONS_PER_FRAME', 64, 1, 500),
    maxConcurrent: int(env, 'SAFEWATCH_MAX_CONCURRENT_VISION', 1, 1, 4),
    maxQueued: int(env, 'SAFEWATCH_MAX_QUEUED_VISION', 20, 0, 1000),
  };
}

const isLoopback = (h: string) => h === '127.0.0.1' || h === '::1' || h === 'localhost' || h.startsWith('127.');

/** A command name such as `ffmpeg` is looked up on PATH; anything with a separator is made absolute so a changed working directory cannot redirect it. */
const absIfPath = (p: string): string => (p.includes('/') || p.includes('\\') ? resolve(p) : p);

function hosts(env: Env, host: string, port: number): string[] {
  const raw = env.SAFEWATCH_ALLOWED_HOSTS?.trim();
  const list = raw ? raw.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean) : [];
  for (const h of list) if (!/^[a-z0-9.-]+(:\d{1,5})?$|^\[[0-9a-f:]+\](:\d{1,5})?$/.test(h)) throw new Error(`Invalid SAFEWATCH_ALLOWED_HOSTS entry "${h}": expected host or host:port.`);
  if (list.length > 0) return list;
  // Default: the loopback names a browser can legitimately use, on any port (the dev proxy keeps the browser's Host).
  void host; void port;
  return ['localhost', '127.0.0.1', '[::1]'];
}

/** Parses and validates server configuration. Throws on invalid values so misconfiguration fails at startup. */
export function parseServerConfig(env: Env): ServerConfig {
  const MIN = 60_000;
  const MB = 1024 * 1024;
  const environment = oneOf(env, 'NODE_ENV', ['development', 'production', 'test'] as const, 'development');
  const host = env.SAFEWATCH_HOST?.trim() || '127.0.0.1';
  const port = int(env, 'SAFEWATCH_PORT', 8787, 0, 65535);
  if (!isLoopback(host)) {
    // Network exposure is a deliberate decision: it needs an explicit opt-in and an explicit list of host names.
    if (env.SAFEWATCH_ALLOW_NETWORK_BIND?.trim() !== 'true') throw new Error(`SAFEWATCH_HOST "${host}" is not a loopback address. Binding beyond this machine requires SAFEWATCH_ALLOW_NETWORK_BIND=true and SAFEWATCH_ALLOWED_HOSTS (and SafeWatch has no multi-user accounts: see the security documentation).`);
    if (!env.SAFEWATCH_ALLOWED_HOSTS?.trim()) throw new Error('SAFEWATCH_ALLOWED_HOSTS is required when SAFEWATCH_HOST is not a loopback address.');
  }
  if (environment === 'production' && !env.SAFEWATCH_STORAGE_DIR?.trim()) throw new Error('SAFEWATCH_STORAGE_DIR is required in production (a dedicated directory, not the shared temp directory).');
  const sandbox = oneOf(env, 'SAFEWATCH_SANDBOX', ['auto', 'seatbelt', 'none'] as const, 'auto');
  const requireSandbox = (env.SAFEWATCH_REQUIRE_SANDBOX?.trim() ?? (environment === 'production' ? 'true' : 'false')) === 'true';
  if (requireSandbox && sandbox === 'none') throw new Error('SAFEWATCH_REQUIRE_SANDBOX=true conflicts with SAFEWATCH_SANDBOX=none.');
  const maxUploadBytes = int(env, 'SAFEWATCH_MAX_UPLOAD_MB', 2048, 1, 8192) * MB;
  const perSessionBytes = int(env, 'SAFEWATCH_QUOTA_SESSION_MB', 4096, 1, 1_048_576) * MB;
  const totalBytes = int(env, 'SAFEWATCH_QUOTA_TOTAL_MB', 10_240, 1, 10_485_760) * MB;
  if (perSessionBytes < maxUploadBytes) throw new Error('SAFEWATCH_QUOTA_SESSION_MB must be at least SAFEWATCH_MAX_UPLOAD_MB, or the largest allowed upload could never be accepted.');
  if (totalBytes < perSessionBytes) throw new Error('SAFEWATCH_QUOTA_TOTAL_MB must be at least SAFEWATCH_QUOTA_SESSION_MB.');
  return {
    environment,
    host,
    port,
    storageDir: resolve(env.SAFEWATCH_STORAGE_DIR?.trim() || join(tmpdir(), 'safewatch-media')),
    security: {
      allowedHosts: hosts(env, host, port),
      cookieSecure: (env.SAFEWATCH_COOKIE_SECURE?.trim() ?? 'false') === 'true',
      sessionTtlMs: int(env, 'SAFEWATCH_SESSION_TTL_MINUTES', 24 * 60, 1, 30 * 24 * 60) * MIN,
      maxSessions: int(env, 'SAFEWATCH_MAX_SESSIONS', 200, 1, 100_000),
    },
    rate: {
      uploadsPerMinute: int(env, 'SAFEWATCH_RATE_UPLOADS_PER_MINUTE', 10, 1, 10_000),
      analysisPerMinute: int(env, 'SAFEWATCH_RATE_ANALYSIS_PER_MINUTE', 60, 1, 100_000),
      readsPerMinute: int(env, 'SAFEWATCH_RATE_READS_PER_MINUTE', 3000, 1, 1_000_000),
      otherPerMinute: int(env, 'SAFEWATCH_RATE_OTHER_PER_MINUTE', 300, 1, 1_000_000),
      maxKeys: int(env, 'SAFEWATCH_RATE_MAX_KEYS', 10_000, 10, 1_000_000),
    },
    quota: {
      totalBytes,
      perSessionBytes,
      maxMediaPerSession: int(env, 'SAFEWATCH_MAX_MEDIA_PER_SESSION', 5, 1, 1000),
      minFreeDiskBytes: int(env, 'SAFEWATCH_MIN_FREE_DISK_MB', 512, 0, 10_485_760) * MB,
    },
    sandbox,
    requireSandbox,
    shutdownGraceMs: int(env, 'SAFEWATCH_SHUTDOWN_GRACE_MS', 5000, 100, 120_000),
    maxUploadBytes,
    allowedOrigins: origins(env),
    uploadTimeoutMs: int(env, 'SAFEWATCH_UPLOAD_TIMEOUT_MS', 30 * MIN, 1000, 6 * 60 * MIN),
    processingTimeoutMs: int(env, 'SAFEWATCH_PROCESSING_TIMEOUT_MS', MIN, 1000, 60 * MIN),
    maxConcurrentUploads: int(env, 'SAFEWATCH_MAX_CONCURRENT_UPLOADS', 4, 1, 100),
    maxConcurrentProcessing: int(env, 'SAFEWATCH_MAX_CONCURRENT_PROCESSING', 2, 1, 32),
    maxQueuedProcessing: int(env, 'SAFEWATCH_MAX_QUEUED_PROCESSING', 20, 0, 1000),
    retentionMs: int(env, 'SAFEWATCH_RETENTION_MINUTES', 60, 1, 7 * 24 * 60) * MIN,
    sweepIntervalMs: int(env, 'SAFEWATCH_SWEEP_INTERVAL_SECONDS', 60, 1, 3600) * 1000,
    extraction: {
      timeoutMs: int(env, 'SAFEWATCH_EXTRACTION_TIMEOUT_MS', 10 * MIN, 1000, 6 * 60 * MIN),
      maxConcurrent: int(env, 'SAFEWATCH_MAX_CONCURRENT_EXTRACTION', 1, 1, 8),
      maxQueued: int(env, 'SAFEWATCH_MAX_QUEUED_EXTRACTION', 20, 0, 1000),
      frame: {
        intervalSeconds: int(env, 'SAFEWATCH_FRAME_INTERVAL_SECONDS', 10, 1, 3600),
        maxFrames: int(env, 'SAFEWATCH_FRAME_MAX_COUNT', 300, 1, 2000),
        maxWidth: int(env, 'SAFEWATCH_FRAME_MAX_WIDTH', 768, 64, 3840),
        maxHeight: int(env, 'SAFEWATCH_FRAME_MAX_HEIGHT', 768, 64, 2160),
      },
      maxFrameBytes: int(env, 'SAFEWATCH_FRAME_MAX_TOTAL_MB', 64, 1, 4096) * 1024 * 1024,
      maxAudioBytes: int(env, 'SAFEWATCH_AUDIO_MAX_MB', 512, 1, 4096) * 1024 * 1024,
      maxAudioTracks: int(env, 'SAFEWATCH_AUDIO_MAX_TRACKS', 8, 1, 32),
      maxCues: int(env, 'SAFEWATCH_SUBTITLE_MAX_CUES', 50_000, 1, 500_000),
      maxSubtitleBytes: int(env, 'SAFEWATCH_SUBTITLE_MAX_MB', 8, 1, 256) * 1024 * 1024,
    },
    speech: speech(env),
    vision: vision(env),
    context: {
      windowBeforeMs: int(env, 'SAFEWATCH_CONTEXT_WINDOW_BEFORE_MS', DEFAULT_CONTEXT_CONFIG.windowBeforeMs, 0, 60_000),
      windowAfterMs: int(env, 'SAFEWATCH_CONTEXT_WINDOW_AFTER_MS', DEFAULT_CONTEXT_CONFIG.windowAfterMs, 0, 60_000),
      maxContextMs: int(env, 'SAFEWATCH_CONTEXT_MAX_MS', DEFAULT_CONTEXT_CONFIG.maxContextMs, 1000, 600_000),
      maxVisualCoverageMs: int(env, 'SAFEWATCH_CONTEXT_MAX_VISUAL_COVERAGE_MS', DEFAULT_CONTEXT_CONFIG.maxVisualCoverageMs, 0, 60_000),
    },
    ffmpegPath: absIfPath(env.SAFEWATCH_FFMPEG_PATH?.trim() || 'ffmpeg'),
    ffprobePath: absIfPath(env.SAFEWATCH_FFPROBE_PATH?.trim() || 'ffprobe'),
    logLevel: oneOf(env, 'SAFEWATCH_LOG_LEVEL', ['debug', 'info', 'warn', 'error', 'silent'] as const, 'info'),
  };
}

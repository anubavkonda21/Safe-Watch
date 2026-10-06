import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

function speech(env: Env): SpeechConfig {
  const provider = oneOf(env, 'SAFEWATCH_SPEECH_PROVIDER', ['none', 'whispercpp'] as const, 'none');
  const modelPath = env.SAFEWATCH_SPEECH_MODEL_PATH?.trim() || null;
  if (provider === 'whispercpp' && !modelPath) throw new Error('SAFEWATCH_SPEECH_MODEL_PATH is required when SAFEWATCH_SPEECH_PROVIDER=whispercpp.');
  const language = (env.SAFEWATCH_SPEECH_LANGUAGE?.trim() || 'auto').toLowerCase();
  if (language !== 'auto' && !/^[a-z]{2,3}$/.test(language)) throw new Error(`Invalid SAFEWATCH_SPEECH_LANGUAGE "${language}": expected "auto" or a language code such as "en" or "hi".`);
  return {
    provider,
    binaryPath: env.SAFEWATCH_SPEECH_BINARY?.trim() || 'whisper-cli',
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
    ffmpegPath: env.SAFEWATCH_FFMPEG_PATH?.trim() || 'ffmpeg',
    ffprobePath: env.SAFEWATCH_FFPROBE_PATH?.trim() || 'ffprobe',
    logLevel: oneOf(env, 'SAFEWATCH_LOG_LEVEL', ['debug', 'info', 'warn', 'error', 'silent'] as const, 'info'),
  };
}

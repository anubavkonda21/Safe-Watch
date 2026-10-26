import { parseServerConfig } from '../src/config';

describe('parseServerConfig', () => {
  it('has safe defaults', () => {
    const c = parseServerConfig({});
    expect(c).toMatchObject({ host: '127.0.0.1', port: 8787, environment: 'development', maxUploadBytes: 2048 * 1024 * 1024, ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' });
    expect(c.allowedOrigins).toEqual(['http://localhost:5173', 'http://127.0.0.1:5173']);
  });
  it('reads overrides', () => {
    const c = parseServerConfig({ SAFEWATCH_PORT: '9000', SAFEWATCH_MAX_UPLOAD_MB: '10', SAFEWATCH_RETENTION_MINUTES: '5', NODE_ENV: 'production', SAFEWATCH_STORAGE_DIR: '/var/lib/safewatch-test' });
    expect(c).toMatchObject({ port: 9000, maxUploadBytes: 10 * 1024 * 1024, retentionMs: 5 * 60_000, environment: 'production' });
  });
  it.each([
    ['SAFEWATCH_PORT', '70000'], ['SAFEWATCH_PORT', 'abc'], ['SAFEWATCH_MAX_UPLOAD_MB', '0'],
    ['SAFEWATCH_MAX_CONCURRENT_PROCESSING', '0'], ['NODE_ENV', 'staging'], ['SAFEWATCH_LOG_LEVEL', 'loud'],
  ])('rejects invalid %s=%s', (k, v) => {
    expect(() => parseServerConfig({ [k]: v })).toThrow(new RegExp(k));
  });
  it('rejects wildcard and malformed CORS origins', () => {
    expect(() => parseServerConfig({ SAFEWATCH_ALLOWED_ORIGINS: '*' })).toThrow(/SAFEWATCH_ALLOWED_ORIGINS/);
    expect(() => parseServerConfig({ SAFEWATCH_ALLOWED_ORIGINS: 'https://a.example.com/path' })).toThrow(/exact origins/);
    expect(() => parseServerConfig({ SAFEWATCH_ALLOWED_ORIGINS: 'not a url' })).toThrow(/not a URL/);
    expect(parseServerConfig({ SAFEWATCH_ALLOWED_ORIGINS: 'https://app.example.com, http://localhost:3000' }).allowedOrigins).toEqual(['https://app.example.com', 'http://localhost:3000']);
  });
  it('has bounded extraction defaults', () => {
    expect(parseServerConfig({}).extraction).toEqual({
      timeoutMs: 600_000, maxConcurrent: 1, maxQueued: 20,
      frame: { intervalSeconds: 10, maxFrames: 300, maxWidth: 768, maxHeight: 768 },
      maxFrameBytes: 64 * 1024 * 1024, maxAudioBytes: 512 * 1024 * 1024, maxAudioTracks: 8, maxCues: 50_000, maxSubtitleBytes: 8 * 1024 * 1024,
    });
  });
  it('reads extraction overrides and rejects unbounded or invalid ones', () => {
    expect(parseServerConfig({ SAFEWATCH_FRAME_MAX_COUNT: '50', SAFEWATCH_MAX_CONCURRENT_EXTRACTION: '2' }).extraction).toMatchObject({ maxConcurrent: 2, frame: { maxFrames: 50 } });
    for (const [k, v] of [['SAFEWATCH_FRAME_MAX_COUNT', '0'], ['SAFEWATCH_FRAME_MAX_COUNT', '5000'], ['SAFEWATCH_FRAME_INTERVAL_SECONDS', '0'], ['SAFEWATCH_MAX_CONCURRENT_EXTRACTION', '99'], ['SAFEWATCH_AUDIO_MAX_MB', '-1'], ['SAFEWATCH_FRAME_MAX_WIDTH', '10']]) {
      expect(() => parseServerConfig({ [k as string]: v as string })).toThrow(new RegExp(k as string));
    }
  });
  it('speech-to-text is off by default and needs a model path when enabled', () => {
    expect(parseServerConfig({}).speech).toMatchObject({ provider: 'none', modelPath: null, modelName: 'none', language: 'auto', maxTracks: 1, maxConcurrent: 1, maxDurationSeconds: 3600 });
    expect(() => parseServerConfig({ SAFEWATCH_SPEECH_PROVIDER: 'whispercpp' })).toThrow(/SAFEWATCH_SPEECH_MODEL_PATH/);
    const c = parseServerConfig({ SAFEWATCH_SPEECH_PROVIDER: 'whispercpp', SAFEWATCH_SPEECH_MODEL_PATH: '/models/ggml-base.bin', SAFEWATCH_SPEECH_LANGUAGE: 'HI', SAFEWATCH_SPEECH_MAX_DURATION_SECONDS: '600' }).speech;
    expect(c).toMatchObject({ provider: 'whispercpp', modelPath: '/models/ggml-base.bin', modelName: 'ggml-base', language: 'hi', maxDurationSeconds: 600, binaryPath: 'whisper-cli' });
  });
  it('visual analysis is off by default; settings are validated and bounded', () => {
    expect(parseServerConfig({}).vision).toMatchObject({ provider: 'none', binaryPath: expect.stringMatching(/^\/.*\/bin\/safewatch-vision$/), maxFrames: 300, batchSize: 8, minConfidence: 0.1, maxConcurrent: 1 });
    expect(parseServerConfig({ SAFEWATCH_VISION_PROVIDER: 'apple-vision', SAFEWATCH_VISION_BATCH_SIZE: '4', SAFEWATCH_VISION_MIN_CONFIDENCE: '0.3', SAFEWATCH_VISION_MAX_FRAME_MB: '2' }).vision)
      .toMatchObject({ provider: 'apple-vision', batchSize: 4, minConfidence: 0.3, maxFrameBytes: 2 * 1024 * 1024 });
    for (const [k, v] of [['SAFEWATCH_VISION_PROVIDER', 'openai'], ['SAFEWATCH_VISION_MIN_CONFIDENCE', '2'], ['SAFEWATCH_VISION_MIN_CONFIDENCE', 'abc'], ['SAFEWATCH_VISION_BATCH_SIZE', '0'], ['SAFEWATCH_VISION_MAX_FRAMES', '99999'], ['SAFEWATCH_VISION_TIMEOUT_MS', '5'], ['SAFEWATCH_MAX_CONCURRENT_VISION', '0']]) {
      expect(() => parseServerConfig({ [k as string]: v as string })).toThrow(new RegExp(k as string));
    }
  });
  it('context correlation settings default to the documented values and are bounded', () => {
    expect(parseServerConfig({}).context).toEqual({ windowBeforeMs: 500, windowAfterMs: 1000, maxContextMs: 20_000, maxVisualCoverageMs: 5000 });
    expect(parseServerConfig({ SAFEWATCH_CONTEXT_WINDOW_AFTER_MS: '2000', SAFEWATCH_CONTEXT_MAX_MS: '30000' }).context).toMatchObject({ windowAfterMs: 2000, maxContextMs: 30_000 });
    for (const [k, v] of [['SAFEWATCH_CONTEXT_WINDOW_BEFORE_MS', '-1'], ['SAFEWATCH_CONTEXT_WINDOW_AFTER_MS', 'abc'], ['SAFEWATCH_CONTEXT_MAX_MS', '5'], ['SAFEWATCH_CONTEXT_MAX_VISUAL_COVERAGE_MS', '99999999']]) {
      expect(() => parseServerConfig({ [k as string]: v as string })).toThrow(new RegExp(k as string));
    }
  });
  it('rejects invalid speech settings, including anything that is not a language code', () => {
    for (const [k, v] of [['SAFEWATCH_SPEECH_PROVIDER', 'openai'], ['SAFEWATCH_SPEECH_LANGUAGE', 'en; rm -rf /'], ['SAFEWATCH_SPEECH_LANGUAGE', 'english'], ['SAFEWATCH_SPEECH_TIMEOUT_MS', '10'], ['SAFEWATCH_MAX_CONCURRENT_SPEECH', '0'], ['SAFEWATCH_SPEECH_MAX_TRACKS', '99'], ['SAFEWATCH_SPEECH_MAX_AUDIO_MB', '0']]) {
      expect(() => parseServerConfig({ SAFEWATCH_SPEECH_PROVIDER: 'none', [k as string]: v as string })).toThrow(new RegExp(k as string));
    }
  });

  describe('security and production settings (CP10)', () => {
    it('binds to loopback by default, with the loopback host names allowed and no sandbox forced in development', () => {
      const c = parseServerConfig({});
      expect(c.host).toBe('127.0.0.1');
      expect(c.security.allowedHosts).toEqual(['localhost', '127.0.0.1', '[::1]']);
      expect(c.security.cookieSecure).toBe(false);
      expect(c.requireSandbox).toBe(false);
      expect(c.sandbox).toBe('auto');
    });
    it('refuses a non-loopback host without an explicit opt-in AND an explicit host list', () => {
      expect(() => parseServerConfig({ SAFEWATCH_HOST: '0.0.0.0' })).toThrow(/SAFEWATCH_ALLOW_NETWORK_BIND/);
      expect(() => parseServerConfig({ SAFEWATCH_HOST: '0.0.0.0', SAFEWATCH_ALLOW_NETWORK_BIND: 'true' })).toThrow(/SAFEWATCH_ALLOWED_HOSTS/);
      expect(() => parseServerConfig({ SAFEWATCH_HOST: '192.168.1.5', SAFEWATCH_ALLOW_NETWORK_BIND: 'yes', SAFEWATCH_ALLOWED_HOSTS: 'x.test' })).toThrow(/SAFEWATCH_ALLOW_NETWORK_BIND/);
      const c = parseServerConfig({ SAFEWATCH_HOST: '0.0.0.0', SAFEWATCH_ALLOW_NETWORK_BIND: 'true', SAFEWATCH_ALLOWED_HOSTS: 'Safewatch.local, safewatch.local:8787' });
      expect(c.security.allowedHosts).toEqual(['safewatch.local', 'safewatch.local:8787']);
    });
    it('rejects malformed host entries', () => {
      for (const bad of ['a b', 'x/y', 'http://x', 'x;y', '*', 'a:99999999']) expect(() => parseServerConfig({ SAFEWATCH_ALLOWED_HOSTS: bad }), bad).toThrow(/SAFEWATCH_ALLOWED_HOSTS/);
    });
    it('production needs an explicit storage directory and requires a process sandbox by default', () => {
      expect(() => parseServerConfig({ NODE_ENV: 'production' })).toThrow(/SAFEWATCH_STORAGE_DIR/);
      const c = parseServerConfig({ NODE_ENV: 'production', SAFEWATCH_STORAGE_DIR: '/srv/sw' });
      expect(c.requireSandbox).toBe(true);
      expect(c.storageDir).toBe('/srv/sw');
      expect(() => parseServerConfig({ NODE_ENV: 'production', SAFEWATCH_STORAGE_DIR: '/srv/sw', SAFEWATCH_SANDBOX: 'none' })).toThrow(/SANDBOX/);
      expect(parseServerConfig({ NODE_ENV: 'production', SAFEWATCH_STORAGE_DIR: '/srv/sw', SAFEWATCH_REQUIRE_SANDBOX: 'false' }).requireSandbox).toBe(false);
    });
    it('quota settings are bounded and consistent with the upload limit', () => {
      const c = parseServerConfig({});
      expect(c.quota).toEqual({ totalBytes: 10_240 * 1024 * 1024, perSessionBytes: 4096 * 1024 * 1024, maxMediaPerSession: 5, minFreeDiskBytes: 512 * 1024 * 1024 });
      expect(() => parseServerConfig({ SAFEWATCH_MAX_UPLOAD_MB: '2048', SAFEWATCH_QUOTA_SESSION_MB: '1024' })).toThrow(/SAFEWATCH_QUOTA_SESSION_MB/);
      expect(() => parseServerConfig({ SAFEWATCH_QUOTA_SESSION_MB: '4096', SAFEWATCH_QUOTA_TOTAL_MB: '2048' })).toThrow(/SAFEWATCH_QUOTA_TOTAL_MB/);
      for (const [k, v] of [['SAFEWATCH_MAX_MEDIA_PER_SESSION', '0'], ['SAFEWATCH_QUOTA_TOTAL_MB', '-1'], ['SAFEWATCH_MIN_FREE_DISK_MB', 'x']]) expect(() => parseServerConfig({ [k as string]: v as string })).toThrow(new RegExp(k as string));
    });
    it('rate limits have sane defaults and bounds', () => {
      expect(parseServerConfig({}).rate).toEqual({ uploadsPerMinute: 10, analysisPerMinute: 60, readsPerMinute: 3000, otherPerMinute: 300, maxKeys: 10_000 });
      for (const [k, v] of [['SAFEWATCH_RATE_UPLOADS_PER_MINUTE', '0'], ['SAFEWATCH_RATE_MAX_KEYS', '1'], ['SAFEWATCH_RATE_READS_PER_MINUTE', 'lots']]) expect(() => parseServerConfig({ [k as string]: v as string })).toThrow(new RegExp(k as string));
    });
    it('session settings are bounded', () => {
      expect(parseServerConfig({}).security).toMatchObject({ sessionTtlMs: 24 * 60 * 60_000, maxSessions: 200 });
      expect(() => parseServerConfig({ SAFEWATCH_SESSION_TTL_MINUTES: '0' })).toThrow(/SAFEWATCH_SESSION_TTL_MINUTES/);
      expect(() => parseServerConfig({ SAFEWATCH_MAX_SESSIONS: '0' })).toThrow(/SAFEWATCH_MAX_SESSIONS/);
    });
    it('tool and model paths with a directory are made absolute; bare command names stay as they are (looked up on PATH)', () => {
      const c = parseServerConfig({ SAFEWATCH_FFMPEG_PATH: 'bin/ffmpeg', SAFEWATCH_SPEECH_PROVIDER: 'whispercpp', SAFEWATCH_SPEECH_MODEL_PATH: 'models/m.bin' });
      expect(c.ffmpegPath.startsWith('/')).toBe(true);
      expect(c.ffprobePath).toBe('ffprobe');
      expect(c.speech.modelPath!.startsWith('/')).toBe(true);
      expect(c.speech.binaryPath).toBe('whisper-cli');
    });
    it('the sandbox mode must be one of the known values', () => {
      expect(() => parseServerConfig({ SAFEWATCH_SANDBOX: 'docker' })).toThrow(/SAFEWATCH_SANDBOX/);
    });
  });
});

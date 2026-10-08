import { parseServerConfig } from '../src/config';

describe('parseServerConfig', () => {
  it('has safe defaults', () => {
    const c = parseServerConfig({});
    expect(c).toMatchObject({ host: '127.0.0.1', port: 8787, environment: 'development', maxUploadBytes: 2048 * 1024 * 1024, ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' });
    expect(c.allowedOrigins).toEqual(['http://localhost:5173', 'http://127.0.0.1:5173']);
  });
  it('reads overrides', () => {
    const c = parseServerConfig({ SAFEWATCH_PORT: '9000', SAFEWATCH_MAX_UPLOAD_MB: '10', SAFEWATCH_RETENTION_MINUTES: '5', NODE_ENV: 'production' });
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
    expect(parseServerConfig({}).vision).toMatchObject({ provider: 'none', binaryPath: 'bin/safewatch-vision', maxFrames: 300, batchSize: 8, minConfidence: 0.1, maxConcurrent: 1 });
    expect(parseServerConfig({ SAFEWATCH_VISION_PROVIDER: 'apple-vision', SAFEWATCH_VISION_BATCH_SIZE: '4', SAFEWATCH_VISION_MIN_CONFIDENCE: '0.3', SAFEWATCH_VISION_MAX_FRAME_MB: '2' }).vision)
      .toMatchObject({ provider: 'apple-vision', batchSize: 4, minConfidence: 0.3, maxFrameBytes: 2 * 1024 * 1024 });
    for (const [k, v] of [['SAFEWATCH_VISION_PROVIDER', 'openai'], ['SAFEWATCH_VISION_MIN_CONFIDENCE', '2'], ['SAFEWATCH_VISION_MIN_CONFIDENCE', 'abc'], ['SAFEWATCH_VISION_BATCH_SIZE', '0'], ['SAFEWATCH_VISION_MAX_FRAMES', '99999'], ['SAFEWATCH_VISION_TIMEOUT_MS', '5'], ['SAFEWATCH_MAX_CONCURRENT_VISION', '0']]) {
      expect(() => parseServerConfig({ [k as string]: v as string })).toThrow(new RegExp(k as string));
    }
  });
  it('rejects invalid speech settings, including anything that is not a language code', () => {
    for (const [k, v] of [['SAFEWATCH_SPEECH_PROVIDER', 'openai'], ['SAFEWATCH_SPEECH_LANGUAGE', 'en; rm -rf /'], ['SAFEWATCH_SPEECH_LANGUAGE', 'english'], ['SAFEWATCH_SPEECH_TIMEOUT_MS', '10'], ['SAFEWATCH_MAX_CONCURRENT_SPEECH', '0'], ['SAFEWATCH_SPEECH_MAX_TRACKS', '99'], ['SAFEWATCH_SPEECH_MAX_AUDIO_MB', '0']]) {
      expect(() => parseServerConfig({ SAFEWATCH_SPEECH_PROVIDER: 'none', [k as string]: v as string })).toThrow(new RegExp(k as string));
    }
  });
});

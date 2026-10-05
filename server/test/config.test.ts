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
});

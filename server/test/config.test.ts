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
});

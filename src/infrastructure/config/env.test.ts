import { parseConfig } from './env';

describe('parseConfig', () => {
  it('uses defaults', () => {
    expect(parseConfig({})).toEqual({ appName: 'SafeWatch', maxUploadBytes: 2048 * 1024 * 1024, apiBaseUrl: '', mediaBackend: 'server' });
  });
  it('reads a custom limit', () => {
    expect(parseConfig({ VITE_MAX_UPLOAD_MB: '10' }).maxUploadBytes).toBe(10 * 1024 * 1024);
  });
  it.each(['0', '-1', 'abc', '1.5', '99999'])('rejects invalid limit %s', (v) => {
    expect(() => parseConfig({ VITE_MAX_UPLOAD_MB: v })).toThrow(/VITE_MAX_UPLOAD_MB/);
  });
  it('normalises the API URL to an origin and rejects bad values', () => {
    expect(parseConfig({ VITE_API_URL: 'https://api.example.com/' }).apiBaseUrl).toBe('https://api.example.com');
    expect(() => parseConfig({ VITE_API_URL: 'nope' })).toThrow(/VITE_API_URL/);
    expect(() => parseConfig({ VITE_API_URL: 'ftp://x.example.com' })).toThrow(/http or https/);
  });
  it('selects the media backend', () => {
    expect(parseConfig({ VITE_MEDIA_BACKEND: 'browser' }).mediaBackend).toBe('browser');
    expect(() => parseConfig({ VITE_MEDIA_BACKEND: 'cloud' })).toThrow(/VITE_MEDIA_BACKEND/);
  });
});

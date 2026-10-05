import { parseConfig } from './env';

describe('parseConfig', () => {
  it('uses defaults', () => {
    expect(parseConfig({})).toEqual({ appName: 'SafeWatch', maxUploadBytes: 2048 * 1024 * 1024 });
  });
  it('reads a custom limit', () => {
    expect(parseConfig({ VITE_MAX_UPLOAD_MB: '10' }).maxUploadBytes).toBe(10 * 1024 * 1024);
  });
  it.each(['0', '-1', 'abc', '1.5', '99999'])('rejects invalid limit %s', (v) => {
    expect(() => parseConfig({ VITE_MAX_UPLOAD_MB: v })).toThrow(/VITE_MAX_UPLOAD_MB/);
  });
});

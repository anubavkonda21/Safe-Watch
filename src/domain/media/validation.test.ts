import { containerMatchesExtension, sanitizeFilename, validateMediaFile } from './validation';

const MB = 1024 * 1024;
const ok = (name = 'clip.mp4', type = 'video/mp4', size = MB) => validateMediaFile({ name, type, size }, 10 * MB);

describe('validateMediaFile', () => {
  it('accepts valid videos', () => {
    expect(ok()).toEqual({ ok: true });
    expect(ok('film.MKV', '')).toEqual({ ok: true });
    expect(ok('a.mov', 'video/quicktime')).toEqual({ ok: true });
  });
  it('rejects an invalid extension even with a video MIME type', () => {
    expect(ok('a.exe')).toEqual({ ok: false, code: 'unsupported-type' });
    expect(ok('a.mp4.exe')).toEqual({ ok: false, code: 'unsupported-type' });
    expect(ok('noextension')).toEqual({ ok: false, code: 'unsupported-type' });
  });
  it('rejects an invalid MIME type even with a video extension', () => {
    expect(ok('a.mp4', 'text/html')).toEqual({ ok: false, code: 'unsupported-type' });
    expect(ok('a.mp4', 'video/ogg')).toEqual({ ok: false, code: 'unsupported-type' });
  });
  it('does not treat inherited object keys as extensions', () => {
    expect(ok('a.constructor')).toEqual({ ok: false, code: 'unsupported-type' });
    expect(ok('a.__proto__')).toEqual({ ok: false, code: 'unsupported-type' });
  });
  it('rejects empty and oversized files', () => {
    expect(ok('a.mp4', 'video/mp4', 0)).toEqual({ ok: false, code: 'empty-file' });
    expect(ok('a.mp4', 'video/mp4', 10 * MB + 1)).toEqual({ ok: false, code: 'file-too-large' });
    expect(ok('a.mp4', 'video/mp4', 10 * MB)).toEqual({ ok: true });
  });
  it('treats an empty filename as unsupported', () => {
    expect(ok('')).toEqual({ ok: false, code: 'unsupported-type' });
  });
});

describe('containerMatchesExtension', () => {
  it('matches plausible pairs and rejects mismatches or unknown content', () => {
    expect(containerMatchesExtension('a.mp4', 'mp4')).toBe(true);
    expect(containerMatchesExtension('a.mov', 'quicktime')).toBe(true);
    expect(containerMatchesExtension('a.mkv', 'webm')).toBe(true);
    expect(containerMatchesExtension('a.avi', 'mp4')).toBe(false);
    expect(containerMatchesExtension('a.mp4', null)).toBe(false);
  });
});

describe('sanitizeFilename', () => {
  it('strips path traversal and separators', () => {
    expect(sanitizeFilename('../../etc/passwd.mp4')).toBe('passwd.mp4');
    expect(sanitizeFilename('C:\\Users\\x\\movie.mov')).toBe('movie.mov');
  });
  it('neutralises shell metacharacters', () => {
    expect(sanitizeFilename('a;$(rm -rf).mp4')).toBe('a___rm -rf_.mp4');
    expect(sanitizeFilename('`id`|&>.mkv')).toBe('_id____.mkv');
  });
  it('removes bidi override, zero-width and control characters', () => {
    expect(sanitizeFilename('a\u202Eb\u200Bc\u0000d.mp4')).toBe('a_b_c_d.mp4');
    expect(sanitizeFilename('movie\u202Egpj.mp4')).not.toMatch(/[\u202A-\u202E\u2066-\u2069]/);
  });
  it('normalises compatibility characters (fullwidth dot/slash tricks)', () => {
    expect(sanitizeFilename('．．／evil.mp4')).toBe('evil.mp4');
  });
  it('handles empty, dot-only and separator-only names', () => {
    expect(sanitizeFilename('')).toBe('video');
    expect(sanitizeFilename('///')).toBe('video');
    expect(sanitizeFilename('...')).toBe('video');
    expect(sanitizeFilename('.hidden.mp4')).toBe('hidden.mp4');
  });
  it('caps length while preserving the extension', () => {
    const out = sanitizeFilename(`${'a'.repeat(300)}.mp4`);
    expect(out).toHaveLength(120);
    expect(out.endsWith('.mp4')).toBe(true);
  });
});

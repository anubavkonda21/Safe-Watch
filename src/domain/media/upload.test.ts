import { formatBytes, formatDuration, sanitizeFilename, validateVideoFile } from './upload';

const MB = 1024 * 1024;

describe('validateVideoFile', () => {
  it('accepts a normal mp4', () => {
    expect(validateVideoFile({ name: 'clip.mp4', size: MB, type: 'video/mp4' }, 10 * MB)).toEqual({ ok: true });
  });
  it('accepts mkv reported with an empty MIME type', () => {
    expect(validateVideoFile({ name: 'film.MKV', size: MB, type: '' }, 10 * MB).ok).toBe(true);
  });
  it('rejects non-video extensions even with a video MIME type', () => {
    expect(validateVideoFile({ name: 'a.exe', size: MB, type: 'video/mp4' }, 10 * MB)).toEqual({ ok: false, reason: 'unsupported-type' });
  });
  it('rejects a video extension with a non-video MIME type', () => {
    expect(validateVideoFile({ name: 'a.mp4', size: MB, type: 'text/html' }, 10 * MB)).toEqual({ ok: false, reason: 'unsupported-type' });
  });
  it('rejects empty and oversized files', () => {
    expect(validateVideoFile({ name: 'a.mp4', size: 0, type: 'video/mp4' }, MB)).toEqual({ ok: false, reason: 'empty-file' });
    expect(validateVideoFile({ name: 'a.mp4', size: MB + 1, type: 'video/mp4' }, MB)).toEqual({ ok: false, reason: 'too-large' });
  });
});

describe('sanitizeFilename', () => {
  it('strips path traversal and separators', () => {
    expect(sanitizeFilename('../../etc/passwd.mp4')).toBe('passwd.mp4');
    expect(sanitizeFilename('C:\\Users\\x\\movie.mov')).toBe('movie.mov');
  });
  it('removes control and bidi override characters and shell metacharacters', () => {
    expect(sanitizeFilename('a\u202Eb;$(rm -rf).mp4')).toBe('a_b___rm -rf_.mp4');
  });
  it('removes leading dots and falls back for empty names', () => {
    expect(sanitizeFilename('.hidden.mp4')).toBe('hidden.mp4');
    expect(sanitizeFilename('///')).toBe('video');
  });
  it('caps length while preserving the extension', () => {
    const out = sanitizeFilename(`${'a'.repeat(300)}.mp4`);
    expect(out.length).toBe(120);
    expect(out.endsWith('.mp4')).toBe(true);
  });
});

describe('formatters', () => {
  it('formats bytes and durations', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1.5 * MB)).toBe('1.5 MB');
    expect(formatDuration(65)).toBe('1:05');
    expect(formatDuration(3725)).toBe('1:02:05');
  });
});

import { HEADERS } from '@/test/files';
import { detectContainer } from './container';

describe('detectContainer', () => {
  it.each([
    ['mp4', 'mp4'],
    ['quicktime', 'quicktime'],
    ['matroska', 'matroska'],
    ['webm', 'webm'],
    ['avi', 'avi'],
  ] as const)('detects %s', (key, expected) => {
    expect(detectContainer(HEADERS[key])).toBe(expected);
  });
  it('detects legacy QuickTime files that start with a moov/mdat atom', () => {
    const b = new Uint8Array(16);
    b.set([0, 0, 0, 8, 0x6d, 0x6f, 0x6f, 0x76], 0); // size, "moov"
    expect(detectContainer(b)).toBe('quicktime');
  });
  it('returns null for non-video content and too-short input', () => {
    expect(detectContainer(HEADERS.html)).toBeNull();
    expect(detectContainer(new Uint8Array(4))).toBeNull();
    expect(detectContainer(new Uint8Array(0))).toBeNull();
  });
});

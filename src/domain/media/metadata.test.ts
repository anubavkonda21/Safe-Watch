import { normalizeMetadata } from './metadata';

describe('normalizeMetadata', () => {
  it('reports full metadata as available and rounds dimensions', () => {
    const m = normalizeMetadata({ durationSeconds: 12.5, width: 1920.4, height: 1080 }, 'browser');
    expect(m).toMatchObject({ availability: 'available', source: 'browser', durationSeconds: 12.5, width: 1920, height: 1080, unavailableReason: null });
  });
  it('reports partial metadata when only duration is known', () => {
    const m = normalizeMetadata({ durationSeconds: 30, width: 0, height: 0 }, 'browser');
    expect(m).toMatchObject({ availability: 'partial', durationSeconds: 30, width: null, height: null });
  });
  it('treats nothing-reported as unavailable with the supplied reason', () => {
    expect(normalizeMetadata({}, 'browser', 'timeout')).toMatchObject({ availability: 'unavailable', unavailableReason: 'timeout' });
    expect(normalizeMetadata({ durationSeconds: 0, width: 0, height: 0 }, 'browser')).toMatchObject({ availability: 'unavailable', unavailableReason: 'unsupported-by-browser' });
  });
  it.each([
    ['NaN', { durationSeconds: NaN, width: NaN, height: NaN }],
    ['Infinity (live stream)', { durationSeconds: Infinity, width: 0, height: 0 }],
    ['negative values', { durationSeconds: -5, width: -1, height: -1 }],
    ['strings', { durationSeconds: '12', width: '1920', height: '1080' }],
    ['absurd dimensions', { durationSeconds: 0, width: 1e9, height: 1e9 }],
    ['absurd duration', { durationSeconds: 1e12, width: 0, height: 0 }],
  ])('flags malformed metadata: %s', (_n, raw) => {
    expect(normalizeMetadata(raw, 'browser')).toMatchObject({ availability: 'unavailable', unavailableReason: 'malformed', durationSeconds: null, width: null });
  });
  it('never invents unknown stream facts', () => {
    const m = normalizeMetadata({ durationSeconds: 10, width: 640, height: 360 }, 'browser');
    expect([m.hasAudio, m.hasSubtitles, m.videoCodec, m.audioCodec, m.frameRate]).toEqual([null, null, null, null, null]);
  });
});

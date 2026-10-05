import { createExtraction, type Frame, type MediaExtraction, type SubtitleTrack } from './extraction';
import { validateExtraction } from './validate';

const frame = (i: number, t: number, over: Partial<Frame> = {}): Frame => ({ id: `frm-${i}`, index: i, timestampSeconds: t, width: 640, height: 360, format: 'jpeg', sizeBytes: 100, artifact: `frames/frm-${i}.jpg`, ...over });
const base = (): MediaExtraction => ({
  ...createExtraction('m', 'x'),
  frames: { config: { intervalSeconds: 10, maxFrames: 5, maxWidth: 768, maxHeight: 768 }, effectiveIntervalSeconds: 10, totalSizeBytes: 200, frames: [frame(0, 5), frame(1, 15)] },
});
const track = (over: Partial<SubtitleTrack> = {}): SubtitleTrack => ({
  id: 'sub-0', ordinal: 0, streamIndex: 3, language: 'eng', title: null, codec: 'subrip', kind: 'text', textExtraction: 'extracted',
  disposition: { default: false, forced: false, original: false, hearingImpaired: false, commentary: false },
  cueCount: 1, cues: [{ index: 0, startSeconds: 1, endSeconds: 2, text: 'hi' }], ...over,
});

describe('validateExtraction', () => {
  it('accepts a consistent manifest', () => {
    expect(validateExtraction({ ...base(), subtitles: [track()] }, 30)).toEqual([]);
  });
  it('flags frame problems: order, index, size limits, beyond duration, totals, too many', () => {
    const e = base();
    e.frames!.frames = [frame(0, 15), frame(2, 5), frame(2, 99, { width: 5000 })];
    e.frames!.totalSizeBytes = 1;
    e.frames!.config.maxFrames = 2;
    const problems = validateExtraction(e, 30).join('\n');
    expect(problems).toMatch(/more frames than maxFrames/);
    expect(problems).toMatch(/index 2 is not 1/);
    expect(problems).toMatch(/not strictly increasing/);
    expect(problems).toMatch(/outside limits/);
    expect(problems).toMatch(/beyond media duration/);
    expect(problems).toMatch(/totalSizeBytes mismatch/);
    expect(problems).toMatch(/duplicate frame id/);
  });
  it('flags subtitle problems: bad timing, order, empty text, wrong counts, cues without extraction', () => {
    const bad = track({ cueCount: 5, cues: [{ index: 0, startSeconds: 5, endSeconds: 6, text: 'a' }, { index: 1, startSeconds: 1, endSeconds: 1, text: '' }] });
    const problems = validateExtraction({ ...base(), subtitles: [bad, track({ id: 'sub-1', kind: 'image', textExtraction: 'extracted', cueCount: 0, cues: [] }), track({ id: 'sub-2', textExtraction: 'unsupported', kind: 'image' })] }, 30).join('\n');
    expect(problems).toMatch(/invalid timing/);
    expect(problems).toMatch(/out of order/);
    expect(problems).toMatch(/empty cue/);
    expect(problems).toMatch(/cueCount mismatch/);
    expect(problems).toMatch(/non-text track/);
    expect(problems).toMatch(/cues present without extraction/);
  });
  it('flags audio problems: negative values, missing artifact, unknown duplicate target', () => {
    const e = base();
    e.audio = [
      { id: 'aud-0', ordinal: 0, streamIndex: 1, language: null, title: null, disposition: track().disposition, source: { codec: null, sampleRate: null, channels: null, bitRate: null }, format: { container: 'wav', codec: 'pcm_s16le', sampleRate: 16000, channels: 1 }, durationSeconds: -1, sizeBytes: 5, artifact: null, duplicateOf: null },
      { id: 'aud-1', ordinal: 1, streamIndex: 2, language: null, title: null, disposition: track().disposition, source: { codec: null, sampleRate: null, channels: null, bitRate: null }, format: { container: 'wav', codec: 'pcm_s16le', sampleRate: 16000, channels: 1 }, durationSeconds: 1, sizeBytes: 0, artifact: null, duplicateOf: 'nope' },
    ];
    const problems = validateExtraction(e, 30).join('\n');
    expect(problems).toMatch(/invalid duration or size/);
    expect(problems).toMatch(/missing artifact/);
    expect(problems).toMatch(/unknown duplicateOf/);
  });
  it('allows unknown media duration (no beyond-duration check)', () => {
    expect(validateExtraction(base(), null)).toEqual([]);
  });
});

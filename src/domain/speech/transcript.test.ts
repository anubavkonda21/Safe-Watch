import { roundTime, validateTranscript, type Transcript } from './transcript';

const base = (): Transcript => ({
  mediaId: 'm', audioTrackId: 'aud-0', streamIndex: 1, language: 'en', languageConfidence: null, durationSeconds: 10, hasWordTimestamps: false, wordTiming: null, provider: { name: 'p', model: 'm' }, issues: [],
  segments: [{ index: 0, startSeconds: 0, endSeconds: 1, text: 'a', originalText: null, confidence: null, words: null }, { index: 1, startSeconds: 1, endSeconds: 2, text: 'b', originalText: null, confidence: 0.5, words: null }],
});

describe('validateTranscript', () => {
  it('accepts a consistent transcript', () => expect(validateTranscript(base())).toEqual([]));
  it('flags index, timing, order, empty text, confidence and late segments', () => {
    const t = base();
    t.segments = [
      { ...t.segments[0]!, index: 5 },
      { ...t.segments[1]!, startSeconds: 3, endSeconds: 3 },
      { ...t.segments[1]!, index: 2, startSeconds: 0.5, endSeconds: 1, text: '', confidence: 2 },
      { ...t.segments[1]!, index: 3, startSeconds: 99, endSeconds: 100 },
    ];
    const p = validateTranscript(t).join('\n');
    for (const re of [/index 5/, /invalid timing/, /out of order/, /empty text/, /confidence out of range/, /after the audio ends/]) expect(p).toMatch(re);
  });
  it('flags bad words and a hasWordTimestamps mismatch', () => {
    const t = base();
    t.segments[0]!.words = [{ startSeconds: 0.5, endSeconds: 0.4, text: 'a', confidence: null }, { startSeconds: 0.45, endSeconds: 0.9, text: '', confidence: 3 }];
    const p = validateTranscript(t).join('\n');
    expect(p).toMatch(/invalid word timing/);
    expect(p).toMatch(/empty word/);
    expect(p).toMatch(/word confidence out of range/);
    expect(p).toMatch(/hasWordTimestamps does not match/);
  });
  it('rounds time to a consistent millisecond precision', () => {
    expect(roundTime(1.23456)).toBe(1.235);
    expect(roundTime(0.0004)).toBe(0);
  });
});

import { normalizeTranscriptText, normalizeTranscription, type NormalizeContext, type RawTranscription } from './normalize';
import { validateTranscript } from './transcript';

const ctx: NormalizeContext = { mediaId: 'm', audioTrackId: 'aud-0', streamIndex: 1, durationSeconds: 10, provider: { name: 'test', model: 'tiny' } };
const norm = (raw: RawTranscription) => normalizeTranscription(raw, ctx);

describe('normalizeTranscription', () => {
  it('maps a valid response, rounds time to milliseconds and preserves word timing and confidence', () => {
    const t = norm({
      language: 'EN', languageConfidence: 0.97,
      segments: [{ start: 1.2344, end: 2.5006, text: ' Hello   world ', confidence: 0.9, words: [
        { start: 1.234, end: 1.7, text: 'Hello', confidence: 0.95 }, { start: 1.72, end: 2.5, text: 'world', confidence: 0.85 }] }],
    });
    expect(t).toMatchObject({ mediaId: 'm', audioTrackId: 'aud-0', streamIndex: 1, language: 'en', languageConfidence: 0.97, durationSeconds: 10, hasWordTimestamps: true, wordTiming: 'decoder', provider: { name: 'test', model: 'tiny' }, issues: [] });
    expect(t.segments[0]).toEqual({
      index: 0, startSeconds: 1.234, endSeconds: 2.501, text: 'Hello world', originalText: ' Hello   world ', confidence: 0.9,
      words: [{ startSeconds: 1.234, endSeconds: 1.7, text: 'Hello', confidence: 0.95 }, { startSeconds: 1.72, endSeconds: 2.5, text: 'world', confidence: 0.85 }],
    });
    expect(validateTranscript(t)).toEqual([]);
  });
  it('never invents confidence: missing, out-of-range or non-numeric values become null', () => {
    const t = norm({ segments: [
      { start: 0, end: 1, text: 'a' }, { start: 1, end: 2, text: 'b', confidence: 1.5 }, { start: 2, end: 3, text: 'c', confidence: 'high' }, { start: 3, end: 4, text: 'd', confidence: 0 },
    ] });
    expect(t.segments.map((s) => s.confidence)).toEqual([null, null, null, 0]);
    expect(t.languageConfidence).toBeNull();
    expect(t.language).toBeNull();
  });
  it('records how word times were obtained, so consumers know how far to trust them', () => {
    const seg = { start: 0, end: 1, text: 'a', words: [{ start: 0, end: 1, text: 'a' }] };
    expect(norm({ wordTiming: 'alignment', segments: [seg] }).wordTiming).toBe('alignment');
    expect(norm({ segments: [seg] }).wordTiming).toBe('decoder');
    expect(norm({ wordTiming: 'alignment', segments: [{ start: 0, end: 1, text: 'a' }] }).wordTiming).toBeNull();
  });
  it('supports providers without word timestamps', () => {
    const t = norm({ segments: [{ start: 0, end: 1, text: 'no words' }] });
    expect(t.hasWordTimestamps).toBe(false);
    expect(t.segments[0]!.words).toBeNull();
  });
  it('drops segments with missing, malformed or impossible timestamps and counts them', () => {
    const t = norm({ segments: [
      { start: 0, end: 1, text: 'ok' }, { start: undefined, end: 2, text: 'missing' }, { start: NaN, end: 2, text: 'nan' }, { start: '1', end: 2, text: 'string' },
      { start: -1, end: 2, text: 'negative' }, { start: 3, end: 3, text: 'zero length' }, { start: 5, end: 4, text: 'backwards' }, { start: Infinity, end: 9, text: 'inf' },
    ] });
    expect(t.segments.map((s) => s.text)).toEqual(['ok']);
    expect(t.issues).toEqual([{ code: 'invalid-timestamp', count: 7 }]);
  });
  it('drops empty segments and exact duplicates, keeps overlapping segments untouched but counted', () => {
    const t = norm({ segments: [
      { start: 0, end: 2, text: 'one' }, { start: 0, end: 2, text: 'one' }, { start: 1, end: 3, text: 'two' }, { start: 4, end: 5, text: '   ​ ' }, { start: 6, end: 7, text: 'one' },
    ] });
    expect(t.segments.map((s) => [s.text, s.startSeconds, s.endSeconds])).toEqual([['one', 0, 2], ['two', 1, 3], ['one', 6, 7]]);
    expect(t.issues).toEqual(expect.arrayContaining([{ code: 'duplicate-segment', count: 1 }, { code: 'empty-segment', count: 1 }, { code: 'overlapping-segments', count: 1 }]));
  });
  it('orders segments by time (stable) and renumbers them', () => {
    const t = norm({ segments: [{ start: 5, end: 6, text: 'later' }, { start: 1, end: 2, text: 'first' }, { start: 1, end: 2, text: 'second' }] });
    expect(t.segments.map((s) => [s.index, s.text])).toEqual([[0, 'first'], [1, 'second'], [2, 'later']]);
  });
  it('is deterministic: the same raw response always gives the same transcript', () => {
    const raw: RawTranscription = { language: 'hi', segments: [{ start: 0.5, end: 1.5, text: ' नमस्ते  दुनिया ' }, { start: 2, end: 3, text: 'bye' }] };
    expect(norm(raw)).toEqual(norm(structuredClone(raw)));
  });
  it('normalises text without destroying speech: NFC, controls and bidi removed, words and punctuation kept', () => {
    const t = norm({ segments: [{ start: 0, end: 1, text: 'Café ‮evil‬ <b>x</b>\u0000 don’t!' }] });
    expect(t.segments[0]!.text).toBe('Café evil <b>x</b> don’t!');
    expect(t.segments[0]!.originalText).toContain('‮');
  });
  it('keeps hostile transcript text as inert plain text', () => {
    const t = norm({ segments: [{ start: 0, end: 1, text: '<script>alert(1)</script> $(rm -rf /) `id` ; | &' }] });
    expect(t.segments[0]!.text).toBe('<script>alert(1)</script> $(rm -rf /) `id` ; | &');
  });
  it('treats unreliable word timestamps as absent for that segment (and says so), keeping the text', () => {
    const t = norm({ segments: [
      { start: 1, end: 2, text: 'outside', words: [{ start: 10, end: 11, text: 'outside' }] },
      { start: 2, end: 3, text: 'bad order', words: [{ start: 2.5, end: 2.9, text: 'order' }, { start: 2.0, end: 2.4, text: 'bad' }] },
      { start: 3, end: 4, text: 'nan', words: [{ start: NaN, end: 3.5, text: 'nan' }] },
    ] });
    expect(t.segments.map((s) => s.words)).toEqual([null, null, null]);
    expect(t.segments.map((s) => s.text)).toEqual(['outside', 'bad order', 'nan']);
    expect(t.issues).toEqual([{ code: 'words-unreliable', count: 3 }]);
    expect(t.hasWordTimestamps).toBe(false);
  });
  it('tolerates words that overlap by rounding or sit slightly outside the segment', () => {
    const t = norm({ segments: [{ start: 1, end: 2, text: 'a b', words: [{ start: 0.9, end: 1.5, text: 'a' }, { start: 1.48, end: 2.1, text: 'b' }] }] });
    expect(t.segments[0]!.words).toHaveLength(2);
  });
  it('drops empty words but keeps the rest', () => {
    const t = norm({ segments: [{ start: 0, end: 1, text: 'a b', words: [{ start: 0, end: 0.4, text: 'a' }, { start: 0.4, end: 0.5, text: '  ' }, { start: 0.5, end: 1, text: 'b' }] }] });
    expect(t.segments[0]!.words!.map((w) => w.text)).toEqual(['a', 'b']);
  });
  it('caps very long text and flags it', () => {
    const t = norm({ segments: [{ start: 0, end: 1, text: 'x'.repeat(5000) }] });
    expect(t.segments[0]!.text).toHaveLength(2000);
    expect(t.issues).toEqual([{ code: 'text-truncated', count: 1 }]);
  });
  it('rejects a response with no usable shape', () => {
    expect(() => norm(null as never)).toThrow();
    expect(() => norm({} as never)).toThrow();
    expect(() => norm({ segments: 'nope' } as never)).toThrow();
  });
  it('an empty but well-formed response is a valid, empty transcript (silence)', () => {
    const t = norm({ language: 'en', segments: [] });
    expect(t.segments).toEqual([]);
    expect(validateTranscript(t)).toEqual([]);
  });
  it('ignores non-string text safely', () => {
    expect(normalizeTranscriptText(42)).toBe('');
    expect(normalizeTranscriptText(undefined)).toBe('');
  });
});

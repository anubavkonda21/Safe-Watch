import type { CustomFilter, MatchMode } from './customFilter';
import { createCustomFilter } from './customFilter';
import { findTextMatches, MAX_MATCHES } from './textMatch';
import type { TextEvent } from './textEvent';

const filter = (phrase: string, mode: MatchMode, over: Partial<CustomFilter> = {}): CustomFilter => {
  const r = createCustomFilter(phrase, mode, [], { id: `f-${phrase}-${mode}`, now: 'x' });
  if (!r.ok) throw new Error(r.reason);
  return { ...r.filter, ...over };
};
const w = (text: string, startSeconds: number, endSeconds: number, confidence: number | null = null) => ({ text, startSeconds, endSeconds, confidence });
const speech = (text: string, words: TextEvent['words'], start = 0, end = 5, over: Partial<TextEvent> = {}): TextEvent =>
  ({ id: 'spe-aud-0-0', source: 'speech', startSeconds: start, endSeconds: end, text, language: 'en', trackId: 'aud-0', streamIndex: 1, confidence: null, words, evidence: 'speech-only', ...over });
const cue = (text: string, start = 1, end = 3, id = 'sub-sub-0-0'): TextEvent =>
  ({ id, source: 'subtitle', startSeconds: start, endSeconds: end, text, language: 'en', trackId: 'sub-0', streamIndex: 3, confidence: null, words: null, evidence: 'subtitle-only' });

const HELLO = speech('Hello, this is a SafeWatch test', [w('Hello,', 0.05, 0.41, 0.97), w('this', 0.73, 0.88, 0.96), w('is', 0.9, 1.06, 0.99), w('a', 1.06, 1.14, 0.98), w('SafeWatch', 1.2, 1.9, 0.8), w('test', 1.95, 2.3, 0.9)], 0, 2.4);

describe('findTextMatches — speech with word timestamps', () => {
  it('reports the exact word timing, source, matched text and the lowest known word confidence', () => {
    const [m] = findTextMatches([filter('SafeWatch', 'word-boundary')], [HELLO]);
    expect(m).toMatchObject({ source: 'speech', matchedText: 'SafeWatch', startSeconds: 1.2, endSeconds: 1.9, confidence: 0.8, granularity: 'word', phrase: 'SafeWatch', trackId: 'aud-0', eventId: 'spe-aud-0-0', matchMode: 'word-boundary' });
  });
  it('matches multi-word phrases across words and spans their combined time', () => {
    const [m] = findTextMatches([filter('is a SafeWatch', 'word-boundary')], [HELLO]);
    expect(m).toMatchObject({ startSeconds: 0.9, endSeconds: 1.9, matchedText: 'is a SafeWatch', confidence: 0.8 });
  });
  it('ignores punctuation attached to words', () => {
    expect(findTextMatches([filter('hello', 'word-boundary')], [HELLO])[0]).toMatchObject({ matchedText: 'Hello', startSeconds: 0.05, endSeconds: 0.41 });
  });
  it('uses null confidence when the provider gave none (never fabricated)', () => {
    const ev = speech('SafeWatch', [w('SafeWatch', 1, 2)]);
    expect(findTextMatches([filter('safewatch', 'word-boundary')], [ev])[0]!.confidence).toBeNull();
  });
});

describe('modes', () => {
  const ev = speech('The party starts, this is smart art. ICE-cream and Ice Cream and icecream', null);
  const count = (f: CustomFilter, e: TextEvent = ev) => findTextMatches([f], [e]).length;
  it('exact is case-sensitive', () => {
    expect(count(filter('Ice Cream', 'exact'))).toBe(1);
    expect(count(filter('ice cream', 'exact'))).toBe(0);
  });
  it('case-insensitive ignores case and matches inside longer words', () => {
    expect(count(filter('ICE CREAM', 'case-insensitive'))).toBe(2); // "ICE-cream" and "Ice Cream"
    expect(findTextMatches([filter('art', 'case-insensitive')], [ev]).map((m) => m.matchedText)).toEqual(['party', 'starts', 'smart', 'art']);
  });
  it('word-boundary matches whole words only: "art" ≠ "party"/"smart"', () => {
    expect(findTextMatches([filter('art', 'word-boundary')], [ev]).map((m) => m.matchedText)).toEqual(['art']);
    expect(count(filter('part', 'word-boundary'))).toBe(0);
  });
  it('phrase tolerates spacing and punctuation between words', () => {
    expect(findTextMatches([filter('ice cream', 'phrase')], [ev]).map((m) => m.matchedText)).toEqual(['ICE cream', 'Ice Cream', 'icecream']);
  });
  it('phrase bridges how a speech model may split a name: "SafeWatch" ~ "safe watch"', () => {
    const heard = speech('this is a safe watch test', [w('this', 0, 0.2), w('is', 0.2, 0.3), w('a', 0.3, 0.4), w('safe', 0.5, 0.8, 0.9), w('watch', 0.8, 1.1, 0.7), w('test', 1.2, 1.5)], 0, 1.6);
    const [m] = findTextMatches([filter('SafeWatch', 'phrase')], [heard]);
    expect(m).toMatchObject({ matchedText: 'safe watch', startSeconds: 0.5, endSeconds: 1.1, confidence: 0.7 });
    expect(findTextMatches([filter('SafeWatch', 'word-boundary')], [heard])).toEqual([]); // the stricter mode does not
  });
  it('phrase does not match unrelated text or partial words', () => {
    expect(findTextMatches([filter('safe watch', 'phrase')], [speech('unsafe watchdog', null)])).toEqual([]);
  });
});

describe('Unicode', () => {
  it('matches across NFC/NFD, fullwidth and curly-apostrophe differences', () => {
    expect(findTextMatches([filter('Café', 'word-boundary')], [cue('un café s’il vous plaît')])).toHaveLength(1);
    expect(findTextMatches([filter('ＳａｆｅＷａｔｃｈ', 'word-boundary')], [cue('use SafeWatch today')])).toHaveLength(1);
    expect(findTextMatches([filter("don't", 'word-boundary')], [cue('I don’t know')])).toHaveLength(1);
  });
  it('does not treat accented and plain letters as equal (no corruption of legitimate words)', () => {
    expect(findTextMatches([filter('resume', 'word-boundary')], [cue('my résumé')])).toEqual([]);
  });
  it('works in Devanagari', () => {
    const hi = speech('मुझे सेफवॉच पसंद है', [w('मुझे', 0, 0.4), w('सेफवॉच', 0.4, 1), w('पसंद', 1, 1.4), w('है', 1.4, 1.6)], 0, 2, { language: 'hi' });
    expect(findTextMatches([filter('सेफवॉच', 'word-boundary')], [hi])[0]).toMatchObject({ startSeconds: 0.4, endSeconds: 1, matchedText: 'सेफवॉच' });
  });
  it('ignores bidi/zero-width characters hidden in text or phrase', () => {
    expect(findTextMatches([filter('bad​word', 'word-boundary')], [cue('a ‮badword‬ here')])).toHaveLength(1);
  });
});

describe('subtitles and segments (no word timestamps)', () => {
  it('matches subtitle cues with the cue timing, null confidence and source "subtitle"', () => {
    const [m] = findTextMatches([filter('safewatch', 'word-boundary')], [cue('Welcome to <i>SafeWatch</i>!'.replace(/<\/?i>/g, ''), 4.5, 6.25)]);
    expect(m).toMatchObject({ source: 'subtitle', startSeconds: 4.5, endSeconds: 6.25, confidence: null, granularity: 'cue', trackId: 'sub-0' });
  });
  it('reports the whole segment span (honestly marked) when speech has no word timing', () => {
    const [m] = findTextMatches([filter('test', 'word-boundary')], [speech('this is a test', null, 3, 6, { confidence: 0.9 })]);
    expect(m).toMatchObject({ source: 'speech', startSeconds: 3, endSeconds: 6, granularity: 'segment', confidence: 0.9 });
  });
  it('finds the same phrase in both sources', () => {
    const out = findTextMatches([filter('SafeWatch', 'phrase')], [HELLO, cue('SafeWatch test', 2, 4)]);
    expect(out.map((m) => [m.source, m.matchedText])).toEqual([['speech', 'SafeWatch'], ['subtitle', 'SafeWatch']]);
  });
});

describe('engine behaviour', () => {
  it('skips disabled filters and returns nothing for no filters or no events', () => {
    expect(findTextMatches([filter('test', 'word-boundary', { enabled: false })], [HELLO])).toEqual([]);
    expect(findTextMatches([], [HELLO])).toEqual([]);
    expect(findTextMatches([filter('test', 'word-boundary')], [])).toEqual([]);
  });
  it('finds repeated occurrences, non-overlapping, ordered by time', () => {
    const ev = speech('go go go', [w('go', 1, 1.2), w('go', 2, 2.2), w('go', 3, 3.2)]);
    expect(findTextMatches([filter('go', 'word-boundary')], [ev]).map((m) => m.startSeconds)).toEqual([1, 2, 3]);
    expect(findTextMatches([filter('go go', 'word-boundary')], [ev])).toHaveLength(1);
  });
  it('treats regex/shell metacharacters in phrases as plain text, safely', () => {
    const text = 'a.*b (c) [d] $(x) $HOME `id`';
    for (const phrase of ['.*', '(c)', '[d]', '$(x)', '`id`', '\\', '^$']) {
      expect(() => findTextMatches([{ ...filter('x', 'case-insensitive'), phrase, normalizedPhrase: phrase }], [cue(text)])).not.toThrow();
    }
    expect(findTextMatches([filter('a.*b', 'case-insensitive')], [cue('a.*b')]).length).toBe(1);
    expect(findTextMatches([filter('a.*b', 'case-insensitive')], [cue('axxb')])).toEqual([]);
  });
  it('is deterministic and bounded', () => {
    const many = Array.from({ length: MAX_MATCHES + 50 }, (_, i) => cue('hit', i, i + 1, `sub-sub-0-${i}`));
    const a = findTextMatches([filter('hit', 'word-boundary')], many);
    expect(a).toHaveLength(MAX_MATCHES);
    expect(findTextMatches([filter('hit', 'word-boundary')], many)).toEqual(a);
  });
  it('never mutates its inputs', () => {
    const ev = structuredClone(HELLO);
    const f = filter('SafeWatch', 'phrase');
    const before = JSON.stringify([ev, f]);
    findTextMatches([f], [ev]);
    expect(JSON.stringify([ev, f])).toBe(before);
  });
});

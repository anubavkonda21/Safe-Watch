import { alignText, textSimilarity } from './alignment';
import { buildTimeline, eventsFromSubtitleTrack, eventsFromTranscript, type TextEvent } from './textEvent';
import type { SubtitleTrack } from '../extraction/extraction';
import type { Transcript } from '../speech/transcript';

const ev = (source: 'speech' | 'subtitle', id: string, start: number, end: number, text: string, language: string | null = 'en'): TextEvent =>
  ({ id, source, startSeconds: start, endSeconds: end, text, language, trackId: source === 'speech' ? 'aud-0' : 'sub-0', streamIndex: 1, confidence: null, words: null, evidence: source === 'speech' ? 'speech-only' : 'subtitle-only' });
const evidenceOf = (events: TextEvent[], id: string) => events.find((e) => e.id === id)!.evidence;

describe('alignText', () => {
  it('links an obvious speech/subtitle pair: both', () => {
    const r = alignText([ev('speech', 's1', 1, 3, 'Hello everyone'), ev('subtitle', 'c1', 1.2, 3.1, 'Hello everyone!')]);
    expect(r.events.map((e) => e.evidence)).toEqual(['both', 'both']);
    expect(r.links).toEqual([{ speechEventId: 's1', subtitleEventIds: ['c1'], similarity: 1 }]);
    expect(r.counts).toEqual({ both: 2, speechOnly: 0, subtitleOnly: 0 });
  });
  it('keeps speech with no subtitle as speech-only, and a cue with no speech as subtitle-only', () => {
    const r = alignText([ev('speech', 's1', 1, 3, 'Only spoken'), ev('subtitle', 'c1', 10, 12, 'Only written')]);
    expect(evidenceOf(r.events, 's1')).toBe('speech-only');
    expect(evidenceOf(r.events, 'c1')).toBe('subtitle-only');
    expect(r.links).toEqual([]);
  });
  it('does not link nearby events whose words differ', () => {
    const r = alignText([ev('speech', 's1', 1, 3, 'Good morning to you all'), ev('subtitle', 'c1', 1, 3, 'The weather is sunny today')]);
    expect(r.counts).toMatchObject({ both: 0, speechOnly: 1, subtitleOnly: 1 });
  });
  it('does not link identical text that is far apart in time', () => {
    const r = alignText([ev('speech', 's1', 1, 3, 'Hello everyone'), ev('subtitle', 'c1', 30, 32, 'Hello everyone')]);
    expect(r.counts.both).toBe(0);
  });
  it('tolerates typical subtitle lag but not large drift', () => {
    expect(alignText([ev('speech', 's1', 5, 7, 'See you soon'), ev('subtitle', 'c1', 7.8, 9, 'See you soon')]).counts.both).toBe(2);
    expect(alignText([ev('speech', 's1', 5, 7, 'See you soon'), ev('subtitle', 'c1', 9, 11, 'See you soon')]).counts.both).toBe(0);
  });
  it('links a speech segment to several cues that split its sentence', () => {
    const r = alignText([ev('speech', 's1', 0, 6, 'this is the first half and this is the second half'), ev('subtitle', 'c1', 0, 3, 'this is the first half'), ev('subtitle', 'c2', 3, 6, 'and this is the second half')]);
    expect(r.links[0]).toMatchObject({ speechEventId: 's1', subtitleEventIds: ['c1', 'c2'] });
    expect(r.counts).toEqual({ both: 3, speechOnly: 0, subtitleOnly: 0 });
  });
  it('links one cue that covers several short speech segments (reverse pass)', () => {
    const r = alignText([ev('speech', 's1', 0, 1.5, 'hello there'), ev('speech', 's2', 1.5, 3, 'my friend'), ev('subtitle', 'c1', 0, 3, 'Hello there, my friend')]);
    expect(r.counts).toEqual({ both: 3, speechOnly: 0, subtitleOnly: 0 });
  });
  it('does not align across different known languages, but allows unknown language', () => {
    expect(alignText([ev('speech', 's1', 1, 3, 'hello everyone', 'en'), ev('subtitle', 'c1', 1, 3, 'hello everyone', 'es')]).counts.both).toBe(0);
    expect(alignText([ev('speech', 's1', 1, 3, 'hello everyone', 'en'), ev('subtitle', 'c1', 1, 3, 'hello everyone', null)]).counts.both).toBe(2);
    expect(alignText([ev('speech', 's1', 1, 3, 'hello everyone', 'en-US'), ev('subtitle', 'c1', 1, 3, 'hello everyone', 'en-GB')]).counts.both).toBe(2);
  });
  it('treats three-letter container tags and two-letter model codes as the same language ("eng" = "en", "hin" = "hi")', () => {
    expect(alignText([ev('speech', 's1', 1, 3, 'hello everyone', 'en'), ev('subtitle', 'c1', 1, 3, 'hello everyone', 'eng')]).counts.both).toBe(2);
    expect(alignText([ev('speech', 's1', 1, 3, 'नमस्ते दोस्तों', 'hi'), ev('subtitle', 'c1', 1, 3, 'नमस्ते दोस्तों', 'hin')]).counts.both).toBe(2);
    expect(alignText([ev('speech', 's1', 1, 3, 'hello everyone', 'en'), ev('subtitle', 'c1', 1, 3, 'hello everyone', 'spa')]).counts.both).toBe(0);
  });
  it('is deterministic, order-preserving and does not mutate its input', () => {
    const input = [ev('speech', 's1', 1, 3, 'Hello everyone'), ev('subtitle', 'c1', 1, 3, 'Hello everyone')];
    const copy = structuredClone(input);
    const a = alignText(input);
    expect(input).toEqual(copy);
    expect(alignText(input)).toEqual(a);
    expect(a.events.map((e) => e.id)).toEqual(['s1', 'c1']);
  });
  it('handles an empty timeline', () => {
    expect(alignText([])).toEqual({ events: [], links: [], counts: { both: 0, speechOnly: 0, subtitleOnly: 0 } });
  });
});

describe('textSimilarity', () => {
  it('is order-insensitive, multiset-aware and bounded', () => {
    expect(textSimilarity(['a', 'b'], ['b', 'a'])).toBe(1);
    expect(textSimilarity(['a', 'a'], ['a'])).toBeCloseTo(2 / 3);
    expect(textSimilarity([], ['a'])).toBe(0);
    expect(textSimilarity(['a'], ['b'])).toBe(0);
  });
});

describe('TextEvent builders', () => {
  const transcript: Transcript = {
    mediaId: 'm', audioTrackId: 'aud-1', streamIndex: 2, language: 'hi', languageConfidence: 0.9, durationSeconds: 5, hasWordTimestamps: true, wordTiming: 'alignment', provider: { name: 'p', model: 'm' }, issues: [],
    segments: [{ index: 0, startSeconds: 1, endSeconds: 2, text: 'नमस्ते', originalText: null, confidence: 0.8, words: [{ startSeconds: 1, endSeconds: 2, text: 'नमस्ते', confidence: 0.8 }] }],
  };
  const track = (over: Partial<SubtitleTrack> = {}): SubtitleTrack => ({
    id: 'sub-1', ordinal: 1, streamIndex: 4, language: 'spa', title: null, codec: 'subrip', kind: 'text', textExtraction: 'extracted',
    disposition: { default: false, forced: false, original: false, hearingImpaired: false, commentary: false }, cueCount: 2,
    cues: [{ index: 0, startSeconds: 0.5, endSeconds: 1.5, text: 'hola' }, { index: 1, startSeconds: 2, endSeconds: 3, text: 'adios' }], ...over,
  });
  it('turns transcript segments into speech events with language, confidence and words', () => {
    expect(eventsFromTranscript(transcript)).toEqual([{ id: 'spe-aud-1-0', source: 'speech', startSeconds: 1, endSeconds: 2, text: 'नमस्ते', language: 'hi', trackId: 'aud-1', streamIndex: 2, confidence: 0.8, words: transcript.segments[0]!.words, evidence: 'speech-only' }]);
  });
  it('turns extracted subtitle cues into subtitle events (no confidence, no words)', () => {
    const events = eventsFromSubtitleTrack(track());
    expect(events.map((e) => [e.id, e.source, e.startSeconds, e.endSeconds, e.text, e.language, e.confidence, e.words])).toEqual([
      ['sub-sub-1-0', 'subtitle', 0.5, 1.5, 'hola', 'spa', null, null], ['sub-sub-1-1', 'subtitle', 2, 3, 'adios', 'spa', null, null]]);
  });
  it('contributes nothing for image, unknown or failed subtitle tracks (they are not text)', () => {
    for (const textExtraction of ['unsupported', 'failed'] as const) expect(eventsFromSubtitleTrack(track({ textExtraction, cues: [] }))).toEqual([]);
  });
  it('orders the timeline deterministically: time, then speech before subtitle, then id', () => {
    const t = buildTimeline([ev('subtitle', 'b', 1, 2, 'x'), ev('speech', 'z', 1, 2, 'x'), ev('speech', 'a', 0, 1, 'x'), ev('speech', 'y', 1, 2, 'x')]);
    expect(t.map((e) => e.id)).toEqual(['a', 'y', 'z', 'b']);
  });
});

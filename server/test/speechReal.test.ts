import type { MediaResponse } from '@/domain/api/contract';
import { createCustomFilter, type MatchMode } from '@/domain/text/customFilter';
import { findTextMatches } from '@/domain/text/textMatch';
import type { TextAnalysis } from '@/domain/text/textAnalysis';
import { fixture, hasFfmpeg, hasRealSpeech, realSpeech, startTestApp, upload, waitForTextAnalysis, type TestApp } from './helpers';

/** Word error rate: word-level Levenshtein distance / reference length (punctuation and case ignored). */
export function wer(reference: string, hypothesis: string): number {
  const words = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' ').split(/\s+/).filter(Boolean);
  const r = words(reference);
  const h = words(hypothesis);
  const d = Array.from({ length: r.length + 1 }, (_, i) => [i, ...Array<number>(h.length).fill(0)]);
  for (let j = 1; j <= h.length; j++) d[0]![j] = j;
  for (let i = 1; i <= r.length; i++) for (let j = 1; j <= h.length; j++) {
    d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (r[i - 1] === h[j - 1] ? 0 : 1));
  }
  return d[r.length]![h.length]! / r.length;
}

const MIME: Record<string, string> = { mkv: 'video/x-matroska', mp4: 'video/mp4' };
let app: TestApp;
afterEach(async () => { await app?.close(); });

async function run(file: string, language = 'auto'): Promise<TextAnalysis> {
  app = await startTestApp({ extraction: {}, speech: { provider: realSpeech, limits: { language, timeoutMs: 120_000 } } });
  const { media } = (await (await upload(app, new Uint8Array(fixture(file)), file, MIME[file.split('.').pop()!])).json()) as MediaResponse;
  return waitForTextAnalysis(app, media.asset.id, 120_000);
}
const speechText = (t: TextAnalysis) => t.timeline.filter((e) => e.source === 'speech').map((e) => e.text).join(' ');
const filter = (phrase: string, mode: MatchMode) => { const r = createCustomFilter(phrase, mode, [], { id: `${phrase}-${mode}`, now: 'x' }); if (!r.ok) throw new Error(r.reason); return r.filter; };

// REAL speech-to-text: whisper.cpp + the multilingual `base` model on this machine. Skipped (and reported as skipped) if the model/binary is absent.
describe.skipIf(!hasRealSpeech || !hasFfmpeg)('real speech inference (whisper.cpp, ggml-base)', () => {
  const EXPECTED = 'Hello, this is a SafeWatch test. The quick brown fox jumps over the lazy dog.';

  it('audio → real model → normalised SafeWatch transcript (English, US voice)', async () => {
    const t = await run('speech-en.mp4');
    expect(t.status).toBe('ready');
    expect(t.provider).toEqual({ name: 'whisper.cpp', model: 'ggml-base' });
    const tr = t.speech[0]!.transcript!;
    expect(tr).toMatchObject({ language: 'en', hasWordTimestamps: true, wordTiming: 'alignment', audioTrackId: 'aud-0', issues: [] });
    expect(wer(EXPECTED, speechText(t))).toBeLessThanOrEqual(0.2); // baseline: "SafeWatch" is heard as "safe watch" (2 of 14 reference words)
    expect(speechText(t).toLowerCase()).toContain('quick brown fox jumps over the lazy dog');
    // Timestamps: media time, ordered, inside the audio, with word-level detail and provider confidence preserved.
    const words = tr.segments.flatMap((s) => s.words ?? []);
    expect(words.length).toBeGreaterThanOrEqual(14);
    words.forEach((w, i) => {
      expect(w.startSeconds).toBeGreaterThanOrEqual(0);
      expect(w.endSeconds).toBeLessThanOrEqual(tr.durationSeconds + 0.6);
      if (i > 0) expect(w.startSeconds).toBeGreaterThanOrEqual(words[i - 1]!.startSeconds - 0.001);
      expect(w.confidence === null || (w.confidence >= 0 && w.confidence <= 1)).toBe(true);
    });
    expect(words[0]!.startSeconds).toBeLessThan(1);
    expect(tr.segments[0]!.confidence).toBeGreaterThan(0.5);
  });

  it('Indian-accented English voice (baseline)', async () => {
    const t = await run('speech-en-in.mp4');
    expect(t.speech[0]!.transcript!.language).toBe('en');
    expect(wer(EXPECTED, speechText(t))).toBeLessThanOrEqual(0.2);
  });

  it('word START times follow real speech onsets after a known pause (alignment timing)', async () => {
    // speech-gap.mp4 = "The first sentence is right here." (0–1.82 s) + exactly 1.5 s of silence + "The second sentence comes after a pause." (3.323–5.77 s)
    const t = await run('speech-gap.mp4');
    const words = t.speech[0]!.transcript!.segments.flatMap((s) => s.words ?? []);
    const second = words.find((w, i) => w.text.toLowerCase() === 'the' && i > 0 && w.startSeconds > 2.5)!;
    expect(Math.abs(second.startSeconds - 3.323)).toBeLessThanOrEqual(0.35);
    expect(words[0]!.startSeconds).toBeLessThanOrEqual(0.5);
    // Ends are upper bounds, not measurements: the first sentence's last word must not start inside the silence.
    const hereIdx = words.findIndex((w) => w.text.toLowerCase().startsWith('here'));
    expect(words[hereIdx]!.startSeconds).toBeLessThan(2.1);
  });

  it('silence produces no text (no hallucinated transcript)', async () => {
    const t = await run('speech-silence.mp4');
    expect(t.status).toBe('ready');
    expect(t.speech[0]).toMatchObject({ status: 'completed', transcript: { segments: [] } });
    expect(t.timeline).toEqual([]);
  });

  it('Hindi: language is detected as Hindi and timestamps are produced; script quality is a documented limitation of the base model', async () => {
    const t = await run('speech-hi.mp4');
    const tr = t.speech[0]!.transcript!;
    expect(tr.language).toBe('hi');
    expect(tr.segments.length).toBeGreaterThan(0);
    expect(tr.hasWordTimestamps).toBe(true);
    expect(tr.segments.every((s) => s.text.length > 0)).toBe(true);
  });

  it('code-mixed Hindi/English is NOT reliably transcribed (recorded behaviour, not a quality claim)', async () => {
    const t = await run('speech-mixed.mp4');
    const tr = t.speech[0]!.transcript!;
    expect(tr.language).not.toBeNull(); // a single language is reported for the whole track
    expect(tr.segments.length).toBeGreaterThan(0);
    // The model reports ONE language for the clip; it does not mark the mixed passages. Consumers must not assume a mixed track is faithfully transcribed.
  });

  it('multi-track: the preferred-language track is the one transcribed', async () => {
    const english = await run('speech-multi.mkv', 'en');
    expect(english.speech.find((s) => s.status === 'completed')).toMatchObject({ audioTrackId: 'aud-1', containerLanguage: 'eng', transcript: { language: 'en' } });
    expect(speechText(english).toLowerCase()).toContain('quick brown fox');
    await app.close();
    const auto = await run('speech-multi.mkv');
    expect(auto.speech.find((s) => s.status === 'completed')).toMatchObject({ audioTrackId: 'aud-0', containerLanguage: 'hin', transcript: { language: 'hi' } });
  });

  it('speech + subtitles: real transcript aligned with the subtitle track; a written-only cue stays subtitle-only', async () => {
    const t = await run('speech-subs.mkv');
    expect(t.status).toBe('ready');
    const bySource = (s: 'speech' | 'subtitle') => t.timeline.filter((e) => e.source === s);
    expect(bySource('speech').every((e) => e.evidence === 'both')).toBe(true);
    expect(bySource('subtitle').map((e) => [e.text, e.evidence])).toEqual([
      ['Hello, this is a SafeWatch test.', 'both'], ['The quick brown fox jumps over the lazy dog.', 'both'], ['A line that is only written.', 'subtitle-only'],
    ]);
  });

  it('CUSTOM PHRASE DEMONSTRATION: "SafeWatch" is detected in speech AND subtitles with timestamps; nothing is muted or altered', async () => {
    const t = await run('speech-subs.mkv');
    const phrase = findTextMatches([filter('SafeWatch', 'phrase')], t.timeline);
    const speech = phrase.find((m) => m.source === 'speech')!;
    const subtitle = phrase.find((m) => m.source === 'subtitle')!;
    // Speech: the model heard "safe watch"; word timing locates it near the true position (≈1.2–2.0 s in the audio).
    expect(speech).toMatchObject({ granularity: 'word', matchedText: expect.stringMatching(/^safe watch$/i), phrase: 'SafeWatch', matchMode: 'phrase' });
    expect(speech.startSeconds).toBeGreaterThan(0.9);
    expect(speech.endSeconds).toBeLessThan(3.2);
    expect(speech.endSeconds).toBeGreaterThan(speech.startSeconds);
    expect(speech.confidence).toBeGreaterThan(0);
    // Subtitle: the whole cue (no word timing exists for subtitles).
    expect(subtitle).toMatchObject({ source: 'subtitle', matchedText: 'SafeWatch', granularity: 'cue', startSeconds: 0.3, endSeconds: 2.9, confidence: null });
    // The stricter whole-word mode finds only what is literally written: it does NOT match the model's "safe watch".
    expect(findTextMatches([filter('SafeWatch', 'word-boundary')], t.timeline).map((m) => m.source)).toEqual(['subtitle']);
    // Evidence only: the media and transcript are untouched.
    expect(t.timeline.every((e) => e.text.length > 0)).toBe(true);
  });
});

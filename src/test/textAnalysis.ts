import { createTextAnalysis, type SpeechTrackResult, type TextAnalysis } from '@/domain/text/textAnalysis';
import type { TextEvent } from '@/domain/text/textEvent';
import type { Transcript } from '@/domain/speech/transcript';

const w = (text: string, startSeconds: number, endSeconds: number, confidence: number | null = 0.9) => ({ text, startSeconds, endSeconds, confidence });

export const transcript = (mediaId: string, over: Partial<Transcript> = {}): Transcript => ({
  mediaId, audioTrackId: 'aud-0', streamIndex: 1, language: 'en', languageConfidence: null, durationSeconds: 9, hasWordTimestamps: true, wordTiming: 'alignment',
  provider: { name: 'whisper.cpp', model: 'ggml-base' }, issues: [],
  segments: [{ index: 0, startSeconds: 0.3, endSeconds: 2.7, text: 'Hello, this is a safe watch test.', originalText: null, confidence: 0.88, words: [
    w('Hello,', 0.3, 0.8), w('this', 0.8, 1.1), w('is', 1.1, 1.3), w('a', 1.3, 1.5), w('safe', 1.5, 1.9, 0.6), w('watch', 1.9, 2.4, 0.9), w('test.', 2.4, 2.7)] }],
  ...over,
});

const speechEvent = (mediaId: string): TextEvent => ({
  id: 'spe-aud-0-0', source: 'speech', startSeconds: 0.3, endSeconds: 2.7, text: 'Hello, this is a safe watch test.', language: 'en', trackId: 'aud-0', streamIndex: 1, confidence: 0.88,
  words: transcript(mediaId).segments[0]!.words, evidence: 'both',
});
const cueEvent = (): TextEvent => ({ id: 'sub-sub-0-0', source: 'subtitle', startSeconds: 0.2, endSeconds: 2.9, text: 'Hello, this is a SafeWatch test.', language: 'eng', trackId: 'sub-0', streamIndex: 2, confidence: null, words: null, evidence: 'both' });
const writtenOnly = (): TextEvent => ({ id: 'sub-sub-0-1', source: 'subtitle', startSeconds: 6.5, endSeconds: 8.5, text: 'A line that is only written.', language: 'eng', trackId: 'sub-0', streamIndex: 2, confidence: null, words: null, evidence: 'subtitle-only' });

export const readyTextAnalysis = (mediaId: string, over: Partial<TextAnalysis> = {}): TextAnalysis => {
  const speech: SpeechTrackResult = { audioTrackId: 'aud-0', streamIndex: 1, containerLanguage: 'eng', status: 'completed', skipReason: null, error: null, transcript: transcript(mediaId), processingMs: 300 };
  return {
    ...createTextAnalysis(mediaId, '2026-01-01T00:00:00.000Z'), status: 'ready', completedAt: '2026-01-01T00:00:02.000Z', speech: [speech],
    timeline: [speechEvent(mediaId), cueEvent(), writtenOnly()], alignment: { links: [], counts: { both: 2, speechOnly: 0, subtitleOnly: 1 } },
    provider: { name: 'whisper.cpp', model: 'ggml-base' }, metrics: { durationMs: 400, speechMs: 300, audioSeconds: 9 }, ...over,
  };
};

export const processingTextAnalysis = (mediaId: string, phase: TextAnalysis['phase']): TextAnalysis => ({ ...createTextAnalysis(mediaId, 'x'), status: 'processing', phase });

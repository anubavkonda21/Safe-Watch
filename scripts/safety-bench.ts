/**
 * Manual measurement of safety classification cost (not part of the test suite).
 * Builds synthetic speech (with word timing) and subtitle evidence for videos of increasing length and times
 * `analyzeSafety` with a realistic and a maximal term list. This is the only work the safety endpoint does after the context is built.
 *
 *   npm run check:safety
 */
import { buildContextAnalysis } from '@/domain/context/contextAnalysis';
import { analyzeSafety } from '@/domain/safety/analyze';
import { createCustomFilter, MAX_FILTERS, type CustomFilter, type MatchMode } from '@/domain/text/customFilter';
import { createTextAnalysis, type TextAnalysis } from '@/domain/text/textAnalysis';
import type { TextEvent } from '@/domain/text/textEvent';

const WORDS = 'the quick brown fox jumps over a lazy dog while we talk about weather travel music and many other ordinary things today'.split(' ');
function textFor(minutes: number): TextAnalysis {
  const timeline: TextEvent[] = [];
  for (let t = 0, n = 0; t < minutes * 60; t += 6, n++) {
    const words = Array.from({ length: 12 }, (_, i) => ({ text: WORDS[(n + i) % WORDS.length]!, startSeconds: t + i * 0.25, endSeconds: t + i * 0.25 + 0.22, confidence: 0.9 }));
    const text = words.map((w) => w.text).join(' ');
    timeline.push({ id: `spe-aud-0-${n}`, source: 'speech', startSeconds: t, endSeconds: t + 3.2, text, language: 'en', trackId: 'aud-0', streamIndex: 1, confidence: 0.9, words, evidence: 'speech-only' });
    timeline.push({ id: `sub-sub-0-${n}`, source: 'subtitle', startSeconds: t, endSeconds: t + 3.2, text, language: 'en', trackId: 'sub-0', streamIndex: 2, confidence: null, words: null, evidence: 'subtitle-only' });
  }
  return { ...createTextAnalysis('m', 'x'), status: 'ready', timeline, speech: [{ audioTrackId: 'aud-0', streamIndex: 1, containerLanguage: 'eng', status: 'completed', skipReason: null, error: null, transcript: null, processingMs: 1 }] };
}
const terms = (n: number): CustomFilter[] => {
  const out: CustomFilter[] = [];
  const modes: MatchMode[] = ['word-boundary', 'phrase', 'case-insensitive', 'exact'];
  for (let i = 0; i < n; i++) { const r = createCustomFilter(i % 5 === 0 ? WORDS[i % WORDS.length]! : `term${i} ${WORDS[i % WORDS.length]}`, modes[i % 4]!, out, { id: `t${i}`, now: 'x' }); if (r.ok) out.push(r.filter); }
  return out;
};
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

const rows: Array<Record<string, unknown>> = [];
for (const [name, minutes] of [['small (1 min)', 1], ['medium (30 min)', 30], ['large (3 h)', 180]] as const) {
  const text = textFor(minutes);
  const context = buildContextAnalysis({ mediaId: 'm', extractionStatus: 'completed', mediaDurationSeconds: minutes * 60, text, visual: null, frameStepSeconds: null });
  for (const [label, list] of [['3 terms', terms(3)], [`${MAX_FILTERS} terms`, terms(MAX_FILTERS)]] as const) {
    await analyzeSafety({ mediaId: 'm', context, text, terms: list });
    const times: number[] = [];
    let a = await analyzeSafety({ mediaId: 'm', context, text, terms: list });
    for (let i = 0; i < 5; i++) { const t0 = performance.now(); a = await analyzeSafety({ mediaId: 'm', context, text, terms: list }); times.push(performance.now() - t0); }
    rows.push({ size: name, textEvents: text.timeline.length, terms: label, findings: a.findings.length, medianMs: Number(median(times).toFixed(1)), jsonKB: Math.round(JSON.stringify(a).length / 1024), heapMB: Math.round(process.memoryUsage().heapUsed / 1048576) });
  }
}
console.table(rows);
console.log(JSON.stringify(rows));

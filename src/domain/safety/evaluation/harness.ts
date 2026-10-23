import type { ContextAnalysis, InputStatus } from '../../context/contextAnalysis';
import { correlateEvidence } from '../../context/correlate';
import { DEFAULT_CONTEXT_CONFIG } from '../../context/contextEvent';
import { buildEvidenceTimeline } from '../../evidence/evidence';
import { toMs, type Ms } from '../../context/time';
import { createCustomFilter, type MatchMode } from '../../text/customFilter';
import type { TextEvent } from '../../text/textEvent';
import type { TranscriptWord } from '../../speech/transcript';
import { analyzeSafety } from '../analyze';
import type { AbstentionReason, CategoryEvaluation, FindingStatus, FindingWarning, SafetyAnalysis } from '../finding';

/**
 * Evaluation harness for the flagged-term classifier. It runs labelled examples through the REAL pipeline
 * (`analyzeSafety`, the CP4 matcher, the CP6 context) and scores the outcome. The examples are synthetic engineering
 * fixtures written for this repository: they show the classifier behaves as documented, and say nothing about real-world accuracy.
 */
export interface Word { text: string; start: number; end: number; confidence?: number }
export interface Seg { start: number; end: number; text: string; confidence?: number | null; words?: Word[] }
export interface Cue { start: number; end: number; text: string }

export type ExampleKind = 'positive' | 'known-limitation' | 'negative' | 'lookalike' | 'normalization' | 'boundary' | 'ambiguous' | 'contradictory' | 'missing-input';

export interface ExpectedFinding { startMs: Ms; endMs: Ms; status: FindingStatus; warnings?: FindingWarning[]; evidenceModalities?: Array<'speech' | 'subtitle'> }

export interface EvalExample {
  id: string;
  kind: ExampleKind;
  description: string;
  terms: Array<{ phrase: string; mode: MatchMode; enabled?: boolean }>;
  speech?: Seg[];
  subtitles?: Cue[];
  /** State of each text input as the earlier stages would report it. Default: `used` when it has text, else `empty`. */
  inputs?: { speech?: InputStatus; subtitles?: InputStatus };
  expect: { evaluation: CategoryEvaluation; reason?: AbstentionReason; findings: ExpectedFinding[] };
  /** Documented caveat: why this expectation is what it is. */
  note?: string;
  /**
   * The label is what a HUMAN would say (intent, not the definition), and the classifier is known to get it wrong. The example is
   * scored (so its miss or false alarm is in the metrics) but is not a regression failure; it fails only if the limitation stops reproducing.
   */
  knownLimitation?: true;
}

export function eventsOf(example: EvalExample): TextEvent[] {
  const speech = (example.speech ?? []).map((s, i): TextEvent => {
    const words: TranscriptWord[] | null = s.words ? s.words.map((w) => ({ text: w.text, startSeconds: w.start, endSeconds: w.end, confidence: w.confidence ?? null })) : null;
    return { id: `spe-aud-0-${i}`, source: 'speech', startSeconds: s.start, endSeconds: s.end, text: s.text, language: 'en', trackId: 'aud-0', streamIndex: 1, confidence: s.confidence === undefined ? 0.9 : s.confidence, words, evidence: 'speech-only' };
  });
  const subs = (example.subtitles ?? []).map((c, i): TextEvent => ({ id: `sub-sub-0-${i}`, source: 'subtitle', startSeconds: c.start, endSeconds: c.end, text: c.text, language: 'en', trackId: 'sub-0', streamIndex: 2, confidence: null, words: null, evidence: 'subtitle-only' }));
  return [...speech, ...subs];
}

function contextOf(example: EvalExample, textEvents: TextEvent[]): ContextAnalysis {
  const inputs = { speech: example.inputs?.speech ?? (example.speech?.length ? 'used' : 'empty'), subtitles: example.inputs?.subtitles ?? (example.subtitles?.length ? 'used' : 'empty'), visual: 'empty' } as const;
  const { events } = correlateEvidence({ evidence: buildEvidenceTimeline(textEvents, []) });
  const unusable = (s: string) => s === 'failed' || s === 'not-enabled';
  return { mediaId: 'eval', status: unusable(inputs.speech) || unusable(inputs.subtitles) ? 'partial' : 'ready', inputs, events, counts: { eventCount: events.length, evidenceCount: 0, invalidEvidence: 0, duplicateEvidence: 0 }, config: DEFAULT_CONTEXT_CONFIG, warnings: [], durationMs: null };
}

export async function runExample(example: EvalExample): Promise<SafetyAnalysis> {
  const terms = example.terms.map((t, i) => {
    const r = createCustomFilter(t.phrase, t.mode, [], { id: `t${i}`, now: '2026-01-01T00:00:00.000Z' });
    if (!r.ok) throw new Error(`fixture ${example.id}: invalid term "${t.phrase}" (${r.reason})`);
    return { ...r.filter, enabled: t.enabled !== false };
  });
  const events = eventsOf(example);
  const context = contextOf(example, events);
  const text = { mediaId: 'eval', status: 'ready', timeline: events } as unknown as Parameters<typeof analyzeSafety>[0]['text'];
  return analyzeSafety({ mediaId: 'eval', context, text, terms });
}

export type Outcome = 'ok' | 'failed' | 'known-limitation';
export interface ExampleResult {
  id: string;
  kind: ExampleKind;
  outcome: Outcome;
  tp: number; fp: number; fn: number; tn: number;
  abstained: boolean;
  uncertainFindings: number;
  findings: number;
  /** Interval overlap (intersection over union) of each matched finding with its label. */
  iou: number[];
  /** Largest start or end error, in ms, over matched findings. */
  maxBoundaryErrorMs: number;
  failures: string[];
}

const iou = (a: { startMs: number; endMs: number }, b: { startMs: number; endMs: number }) => {
  const inter = Math.max(0, Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs));
  const union = Math.max(a.endMs, b.endMs) - Math.min(a.startMs, b.startMs);
  return union === 0 ? 1 : inter / union;
};

export function scoreExample(example: EvalExample, analysis: SafetyAnalysis): ExampleResult {
  const report = analysis.categories.find((c) => c.category === 'flagged-terms')!;
  const actual = analysis.findings.filter((f) => f.category === 'flagged-terms');
  const failures: string[] = [];
  if (report.evaluation !== example.expect.evaluation) failures.push(`evaluation: expected ${example.expect.evaluation}, got ${report.evaluation}`);
  if ((report.reason ?? undefined) !== example.expect.reason) failures.push(`reason: expected ${example.expect.reason ?? 'none'}, got ${report.reason ?? 'none'}`);

  const wanted = [...example.expect.findings];
  const used = new Set<number>();
  let tp = 0;
  const ious: number[] = [];
  let maxErr = 0;
  for (const a of actual) {
    let best = -1; let bestIou = 0;
    wanted.forEach((w, i) => { const v = iou(a, w); if (!used.has(i) && v > bestIou) { best = i; bestIou = v; } });
    if (best >= 0 && bestIou >= 0.5) {
      used.add(best);
      tp += 1; ious.push(bestIou);
      const w = wanted[best]!;
      maxErr = Math.max(maxErr, Math.abs(a.startMs - w.startMs), Math.abs(a.endMs - w.endMs));
      if (a.status !== w.status) failures.push(`finding ${a.id}: expected status ${w.status}, got ${a.status}`);
      if (w.warnings && JSON.stringify([...a.warnings].sort()) !== JSON.stringify([...w.warnings].sort())) failures.push(`finding ${a.id}: expected warnings [${w.warnings}], got [${a.warnings}]`);
      if (w.evidenceModalities && JSON.stringify([...new Set(a.evidence.map((e) => e.modality))].sort()) !== JSON.stringify([...w.evidenceModalities].sort())) failures.push(`finding ${a.id}: unexpected evidence modalities`);
    } else failures.push(`unexpected finding ${a.id} at ${a.startMs}-${a.endMs}`);
  }
  const fp = actual.length - tp;
  const fn = wanted.length - tp;
  for (let i = 0; i < wanted.length; i++) if (!used.has(i)) failures.push(`missed finding at ${wanted[i]!.startMs}-${wanted[i]!.endMs}`);
  const ran = report.evaluation === 'evaluated' || report.evaluation === 'partial';
  const tn = ran && wanted.length === 0 && actual.length === 0 ? 1 : 0;
  return {
    id: example.id, kind: example.kind,
    outcome: example.knownLimitation ? (failures.length > 0 ? 'known-limitation' : 'failed') : failures.length === 0 ? 'ok' : 'failed', tp, fp, fn, tn, abstained: report.evaluation === 'abstained',
    uncertainFindings: actual.filter((f) => f.status === 'uncertain').length, findings: actual.length, iou: ious, maxBoundaryErrorMs: maxErr, failures,
  };
}

export interface Metrics {
  examples: number;
  /** Examples that behaved as labelled. */
  passed: number;
  /** Examples where the classifier is known to be wrong (counted in the metrics above). */
  knownLimitations: number;
  /** Examples that failed unexpectedly (a regression, or a known limitation that no longer reproduces). */
  failed: number;
  tp: number; fp: number; fn: number; tn: number;
  /** null when the denominator is 0. */
  precision: number | null;
  recall: number | null;
  abstainedExamples: number;
  abstentionRate: number;
  findings: number;
  uncertainFindings: number;
  uncertainRate: number | null;
  meanIou: number | null;
  maxBoundaryErrorMs: number;
}

const ratio = (a: number, b: number) => (b === 0 ? null : Number((a / b).toFixed(4)));

export function summarize(results: readonly ExampleResult[]): Metrics {
  const sum = (k: 'tp' | 'fp' | 'fn' | 'tn' | 'findings' | 'uncertainFindings') => results.reduce((n, r) => n + r[k], 0);
  const ious = results.flatMap((r) => r.iou);
  const abstained = results.filter((r) => r.abstained).length;
  return {
    examples: results.length, passed: results.filter((r) => r.outcome === 'ok').length, knownLimitations: results.filter((r) => r.outcome === 'known-limitation').length, failed: results.filter((r) => r.outcome === 'failed').length, tp: sum('tp'), fp: sum('fp'), fn: sum('fn'), tn: sum('tn'),
    precision: ratio(sum('tp'), sum('tp') + sum('fp')), recall: ratio(sum('tp'), sum('tp') + sum('fn')), abstainedExamples: abstained, abstentionRate: Number((abstained / Math.max(1, results.length)).toFixed(4)),
    findings: sum('findings'), uncertainFindings: sum('uncertainFindings'), uncertainRate: ratio(sum('uncertainFindings'), sum('findings')),
    meanIou: ious.length ? Number((ious.reduce((a, b) => a + b, 0) / ious.length).toFixed(4)) : null, maxBoundaryErrorMs: Math.max(0, ...results.map((r) => r.maxBoundaryErrorMs)),
  };
}

export { toMs };

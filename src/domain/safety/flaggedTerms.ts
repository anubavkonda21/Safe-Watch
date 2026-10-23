import { toMs, type Ms } from '../context/time';
import { MATCH_MODE_LABEL } from '../text/customFilter';
import { MAX_MATCHES, findTextMatches, type TextMatch } from '../text/textMatch';
import type { TextEvent } from '../text/textEvent';
import { formatTimecode } from '../media/format';
import type { CategoryResult, ClassifierInput, SafetyClassifier } from './classifier';
import { TAXONOMY_VERSION, type ClassifierInfo, type EvidenceRef, type FindingWarning, type SafetyFinding } from './finding';
import type { Modality } from '../evidence/evidence';

/**
 * Policy thresholds. These are cut-offs on the reliability of the SUPPORTING EVIDENCE, chosen by us and documented. They are not probabilities.
 * A speech-only match whose recognizer confidence (the lowest word confidence of the matched words) is below this is reported as `uncertain`.
 */
export const FLAGGED_TERMS_POLICY = { uncertainBelowSourceConfidence: 0.5 } as const;

export const FLAGGED_TERMS_CLASSIFIER: ClassifierInfo = { id: 'flagged-terms-matcher', version: '1', kind: 'rule-based' };

const SOURCE_LABEL: Record<Modality, string> = { speech: 'speech', subtitle: 'subtitles', visual: 'visual' };

interface Cluster {
  filterId: string;
  matches: TextMatch[];
  startMs: Ms;
  endMs: Ms;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const overlaps = (aStart: Ms, aEnd: Ms, bStart: Ms, bEnd: Ms) => aStart <= bEnd && bStart <= aEnd;

/**
 * Looks for the user's flagged terms in speech and subtitle text, reusing the CP4 matcher (`findTextMatches`) for
 * normalisation, word boundaries and timing, and adds what the safety contract needs: evidence references with their
 * context event, the source's own confidence, agreement between speech and subtitles, and explicit abstention.
 *
 * It detects OCCURRENCE of a listed term. It does not understand meaning: a listed word in an educational or quoted
 * sentence is found just the same. It reads speech and subtitles only (not on-screen text) and ships no built-in word list.
 */
export class FlaggedTermClassifier implements SafetyClassifier {
  readonly info = FLAGGED_TERMS_CLASSIFIER;
  readonly categories = ['flagged-terms'] as const;

  classify(input: ClassifierInput): CategoryResult[] {
    const { inputs } = input.context;
    const usable = (s: string) => s === 'used' || s === 'empty';
    const evaluated: Modality[] = [];
    const missing: Modality[] = [];
    (usable(inputs.speech) ? evaluated : missing).push('speech');
    (usable(inputs.subtitles) ? evaluated : missing).push('subtitle');
    const base = { category: 'flagged-terms' as const, modalities: { evaluated, missing }, findings: [] as SafetyFinding[], warnings: [] as CategoryResult['warnings'] };

    if (input.terms.length === 0) return [{ ...base, evaluation: 'abstained', reason: 'no-terms-configured', modalities: { evaluated: [], missing: [] } }];
    if (evaluated.length === 0) return [{ ...base, evaluation: 'abstained', reason: 'text-unavailable' }];

    const matches = findTextMatches(input.terms, input.textEvents);
    const warnings: CategoryResult['warnings'] = [];
    if (matches.length >= MAX_MATCHES) warnings.push({ code: 'findings-truncated', count: matches.length });
    const findings = buildFindings(matches, input);

    const partial = missing.length > 0;
    return [{
      ...base, findings, warnings, evaluation: partial ? 'partial' : 'evaluated',
      reason: partial ? (missing[0] === 'speech' ? 'speech-unavailable' : 'subtitles-unavailable') : null,
    }];
  }
}

function buildFindings(matches: readonly TextMatch[], input: ClassifierInput): SafetyFinding[] {
  const contextOf = new Map<string, string>();
  for (const e of input.context.events) for (const m of e.members) contextOf.set(m.evidenceId, e.id);

  // Cluster overlapping matches of the SAME term across speech and subtitles into one finding; separate occurrences stay separate.
  const sorted = matches.map((m) => ({ m, s: toMs(m.startSeconds), e: toMs(m.endSeconds) }))
    .sort((a, b) => a.s - b.s || a.e - b.e || cmp(a.m.filterId, b.m.filterId) || cmp(a.m.eventId, b.m.eventId) || cmp(a.m.id, b.m.id));
  const clusters: Cluster[] = [];
  for (const { m, s, e } of sorted) {
    const open = clusters.findLast((c) => c.filterId === m.filterId && overlaps(c.startMs, c.endMs, s, e));
    if (open) { open.matches.push(m); open.startMs = Math.min(open.startMs, s); open.endMs = Math.max(open.endMs, e); } else clusters.push({ filterId: m.filterId, matches: [m], startMs: s, endMs: e });
  }
  clusters.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || cmp(a.filterId, b.filterId) || cmp(a.matches[0]!.eventId, b.matches[0]!.eventId));

  return clusters.map((c, n): SafetyFinding => {
    const evidence: EvidenceRef[] = c.matches.map((m) => ({
      evidenceId: m.eventId, modality: m.source, kind: m.source, startMs: toMs(m.startSeconds), endMs: toMs(m.endSeconds), sourceId: m.trackId,
      contextEventId: contextOf.get(m.eventId) ?? null, sourceConfidence: m.source === 'speech' ? m.confidence : null,
    })).sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || cmp(a.evidenceId, b.evidenceId));

    const hasSubtitle = c.matches.some((m) => m.source === 'subtitle');
    const hasSpeech = c.matches.some((m) => m.source === 'speech');
    const warnings: FindingWarning[] = [];
    if (c.matches.some((m) => m.granularity !== 'word')) warnings.push('coarse-timing');

    // Texts of the OTHER modality that cover the same time but do not contain the term.
    const dissent = (source: 'speech' | 'subtitle') => input.textEvents.some((e: TextEvent) => e.source === source && overlaps(toMs(e.startSeconds), toMs(e.endSeconds), c.startMs, c.endMs));
    let status: SafetyFinding['status'] = 'detected';
    if (hasSpeech && !hasSubtitle) {
      const conf = Math.min(...c.matches.map((m) => m.confidence ?? 1));
      if (conf < FLAGGED_TERMS_POLICY.uncertainBelowSourceConfidence) { status = 'uncertain'; warnings.push('low-source-confidence'); }
      if (dissent('subtitle')) { status = 'uncertain'; warnings.push('subtitle-disagrees'); }
    } else if (hasSubtitle && !hasSpeech && dissent('speech')) warnings.push('speech-did-not-confirm');

    const first = c.matches[0]!;
    const sources = [...new Set(c.matches.map((m) => SOURCE_LABEL[m.source]))].join(' and ');
    const when = `${formatTimecode(c.startMs / 1000)} to ${formatTimecode(c.endMs / 1000)}`;
    const base = `The ${sources} ${hasSpeech && hasSubtitle ? 'both contain' : 'contains'} the listed term “${clip(first.phrase)}” (${MATCH_MODE_LABEL[first.matchMode].toLowerCase()}) at ${when}.`;
    const note = status === 'uncertain'
      ? ` Only speech recognition supports it${warnings.includes('low-source-confidence') ? ', with low recognizer confidence' : ''}${warnings.includes('subtitle-disagrees') ? ', and the subtitles at that time do not contain it' : ''}, so it is reported as uncertain.`
      : '';
    return {
      id: `sf-flagged-terms-${String(n).padStart(4, '0')}`, category: 'flagged-terms', taxonomyVersion: TAXONOMY_VERSION, startMs: c.startMs, endMs: c.endMs, status,
      rawScore: null, calibratedProbability: null, evidence, explanation: base + note, warnings: [...new Set(warnings)], classifier: FLAGGED_TERMS_CLASSIFIER,
      attributes: { term: first.phrase, matchMode: first.matchMode, matchedText: clip(first.matchedText) },
    };
  });
}

const clip = (s: string) => (s.length > 80 ? `${s.slice(0, 80)}…` : s);

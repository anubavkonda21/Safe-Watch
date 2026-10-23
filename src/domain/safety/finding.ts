import type { Modality } from '../evidence/evidence';
import type { ContextInputs } from '../context/contextAnalysis';
import { isValidInterval, type Ms } from '../context/time';
import { CATEGORY_IDS, TAXONOMY_VERSION, isCategoryId, type CategoryId, type SupportStatus } from './taxonomy';

/**
 * What a classifier reports, and how far it can be trusted.
 *
 * Four things are kept apart on purpose:
 *  1. the classifier's RAW output (`rawScore`): null for classifiers that produce none (the flagged-term detector is rule based);
 *  2. a CALIBRATED probability (`calibratedProbability`): null unless calibration has actually been measured. It is null for every classifier today;
 *  3. a POLICY threshold: a documented cut-off on evidence reliability (see FLAGGED_TERMS_POLICY), not a probability;
 *  4. a user-facing VERDICT: none exists. There is no overall score and no safe/unsafe label anywhere.
 * The only confidence carried through is each SOURCE's own (speech recognition confidence), labelled as such.
 */

/**
 * `detected`: the classifier's positive condition holds in evidence that is not qualified (nothing makes it doubtful).
 * `uncertain`: the positive condition holds but the supporting evidence is qualified; `warnings` says how.
 * (A category that is not implemented, or an input that is missing, is reported in the category report, never as a finding.)
 */
export type FindingStatus = 'detected' | 'uncertain';

export type FindingWarning =
  | 'low-source-confidence'   // only speech supports it and the recognizer's own confidence is below the policy threshold
  | 'subtitle-disagrees'      // only speech supports it, but subtitle text covering the same time does not contain it
  | 'speech-did-not-confirm'  // only a subtitle supports it, and speech recognized at the same time does not contain it
  | 'coarse-timing';          // the interval is a whole speech segment or subtitle cue, not the word

export interface EvidenceRef {
  evidenceId: string;
  modality: Modality;
  kind: string;
  startMs: Ms;
  endMs: Ms;
  sourceId: string;
  /** The context event that holds this evidence, or null when the context layer did not place it. */
  contextEventId: string | null;
  /** The source's OWN confidence (speech recognition), never a safety confidence. Null when the source reports none. */
  sourceConfidence: number | null;
}

export interface FlaggedTermAttributes {
  /** What the user listed. */
  term: string;
  matchMode: string;
  /** The words that matched, as normalised for matching. Untrusted text. */
  matchedText: string;
}

export interface ClassifierInfo {
  id: string;
  version: string;
  kind: 'rule-based' | 'model';
}

export interface SafetyFinding {
  /** `sf-<category>-<n>`: deterministic (position in chronological order). */
  id: string;
  category: CategoryId;
  taxonomyVersion: string;
  startMs: Ms;
  endMs: Ms;
  status: FindingStatus;
  /** The classifier's raw output. Null when it produces none. */
  rawScore: number | null;
  /** Measured, calibrated probability. Null unless calibration was measured: it never is today. */
  calibratedProbability: number | null;
  evidence: EvidenceRef[];
  explanation: string;
  warnings: FindingWarning[];
  classifier: ClassifierInfo;
  /** Category-specific facts. */
  attributes: FlaggedTermAttributes | null;
}

/**
 * Outcome of looking for one category.
 *  - evaluated:     the classifier ran over its full scope. Zero findings then means "none found WITHIN THAT SCOPE", nothing more.
 *  - partial:       it ran, but some of its input was missing (named in `modalities.missing`).
 *  - abstained:     it could not run (no terms to look for, or all its input is missing): no negative claim is made.
 *  - not-supported: no classifier exists for this category.
 */
export type CategoryEvaluation = 'evaluated' | 'partial' | 'abstained' | 'not-supported';

export type AbstentionReason = 'no-terms-configured' | 'text-unavailable' | 'speech-unavailable' | 'subtitles-unavailable' | 'no-classifier' | 'classifier-failed';

export interface CategoryReport {
  category: CategoryId;
  label: string;
  support: SupportStatus;
  evaluation: CategoryEvaluation;
  reason: AbstentionReason | null;
  modalities: { evaluated: Modality[]; missing: Modality[] };
  findingCount: number;
}

export type SafetyStatus = 'pending' | 'ready' | 'partial' | 'not-evaluated';

export type SafetyWarningCode = 'findings-truncated' | 'invalid-finding';

export interface SafetyAnalysis {
  mediaId: string;
  taxonomyVersion: string;
  /**
   * pending: the evidence steps are still running. ready: every implemented category was evaluated over its full scope.
   * partial: some implemented category ran with missing input or abstained while another ran. not-evaluated: nothing could be evaluated.
   */
  status: SafetyStatus;
  categories: CategoryReport[];
  /** Chronological. */
  findings: SafetyFinding[];
  inputs: ContextInputs;
  classifiers: ClassifierInfo[];
  /** Documented policy thresholds that were applied. */
  policy: { uncertainBelowSourceConfidence: number };
  /** Number of enabled terms that were evaluated. */
  termCount: number;
  warnings: Array<{ code: SafetyWarningCode; count: number }>;
  /** Media duration for drawing a timeline; null when unknown. */
  durationMs: Ms | null;
}

export { TAXONOMY_VERSION };

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/** Structural checks every consumer can rely on. Returns problems (empty when valid). Malformed findings are rejected, never repaired. */
export function validateFinding(f: SafetyFinding): string[] {
  const problems: string[] = [];
  if (typeof f.id !== 'string' || f.id === '') problems.push('missing id');
  if (!isCategoryId(f.category)) problems.push('unknown category');
  if (f.taxonomyVersion !== TAXONOMY_VERSION) problems.push('taxonomy version mismatch');
  if (!isValidInterval({ startMs: f.startMs, endMs: f.endMs })) problems.push('invalid time range');
  if (f.status !== 'detected' && f.status !== 'uncertain') problems.push('invalid status');
  if (f.rawScore !== null && !finite(f.rawScore)) problems.push('invalid rawScore');
  if (f.calibratedProbability !== null && !(finite(f.calibratedProbability) && f.calibratedProbability >= 0 && f.calibratedProbability <= 1)) problems.push('invalid calibratedProbability');
  if (f.calibratedProbability !== null && f.rawScore === null) problems.push('calibrated probability without a raw score');
  if (!Array.isArray(f.evidence) || f.evidence.length === 0) problems.push('no evidence');
  else {
    for (const e of f.evidence) {
      if (!isValidInterval({ startMs: e.startMs, endMs: e.endMs })) problems.push(`evidence ${e.evidenceId}: invalid time range`);
      else if (e.startMs < f.startMs || e.endMs > f.endMs) problems.push(`evidence ${e.evidenceId}: outside the finding`);
      if (e.sourceConfidence !== null && !(finite(e.sourceConfidence) && e.sourceConfidence >= 0 && e.sourceConfidence <= 1)) problems.push(`evidence ${e.evidenceId}: invalid source confidence`);
    }
  }
  if (typeof f.explanation !== 'string' || f.explanation === '') problems.push('missing explanation');
  if (f.status === 'uncertain' && f.warnings.length === 0) problems.push('uncertain without a reason');
  return problems;
}

export function validateSafetyAnalysis(a: SafetyAnalysis): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  a.findings.forEach((f, i) => {
    if (ids.has(f.id)) problems.push(`duplicate finding id ${f.id}`);
    ids.add(f.id);
    for (const p of validateFinding(f)) problems.push(`${f.id}: ${p}`);
    if (i > 0 && a.findings[i - 1]!.startMs > f.startMs) problems.push(`finding order: ${f.id}`);
  });
  if (a.categories.length !== CATEGORY_IDS.length) problems.push('category report does not cover the taxonomy');
  for (const c of a.categories) {
    const n = a.findings.filter((f) => f.category === c.category).length;
    if (n !== c.findingCount) problems.push(`${c.category}: findingCount mismatch`);
    if (n > 0 && (c.evaluation === 'abstained' || c.evaluation === 'not-supported')) problems.push(`${c.category}: findings from a category that did not run`);
    if (c.support === 'unsupported' && c.evaluation !== 'not-supported') problems.push(`${c.category}: unsupported category reported as evaluated`);
  }
  return problems;
}

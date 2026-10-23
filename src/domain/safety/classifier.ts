import type { ContextAnalysis } from '../context/contextAnalysis';
import type { CustomFilter } from '../text/customFilter';
import type { TextEvent } from '../text/textEvent';
import type { AbstentionReason, CategoryEvaluation, ClassifierInfo, SafetyFinding, SafetyWarningCode } from './finding';
import type { CategoryId } from './taxonomy';
import type { Modality } from '../evidence/evidence';

/**
 * Port: a safety classifier turns EXISTING evidence (never raw media) into
 * findings for the categories it supports. Providers (a rule engine today, a
 * local model one day) sit behind it; the rest of the system never depends on
 * which one runs. A classifier must be deterministic for rule-based kinds,
 * must not mutate its input, and reports what it could not do (abstention)
 * instead of returning an empty list that looks like a negative result.
 */
export interface ClassifierInput {
  mediaId: string;
  /** Enabled flagged terms to look for. */
  terms: readonly CustomFilter[];
  /** The speech and subtitle events of the text analysis (CP4), unchanged. */
  textEvents: readonly TextEvent[];
  /** The correlated context (CP6): which inputs were available and which event holds each piece of evidence. */
  context: ContextAnalysis;
}

export interface CategoryResult {
  category: CategoryId;
  evaluation: CategoryEvaluation;
  reason: AbstentionReason | null;
  modalities: { evaluated: Modality[]; missing: Modality[] };
  findings: SafetyFinding[];
  warnings: Array<{ code: SafetyWarningCode; count: number }>;
}

export interface SafetyClassifier {
  readonly info: ClassifierInfo;
  /** Categories this classifier can evaluate. */
  readonly categories: readonly CategoryId[];
  /** May be asynchronous: a model-backed provider would be. */
  classify(input: ClassifierInput): CategoryResult[] | Promise<CategoryResult[]>;
}

import type { ContextAnalysis } from '../context/contextAnalysis';
import type { CustomFilter } from '../text/customFilter';
import type { TextAnalysis } from '../text/textAnalysis';
import type { Modality } from '../evidence/evidence';
import type { CategoryResult, SafetyClassifier } from './classifier';
import { FLAGGED_TERMS_POLICY, FlaggedTermClassifier } from './flaggedTerms';
import { TAXONOMY, TAXONOMY_VERSION } from './taxonomy';
import { validateFinding, type CategoryReport, type SafetyAnalysis, type SafetyFinding, type SafetyStatus } from './finding';

export const DEFAULT_CLASSIFIERS: readonly SafetyClassifier[] = [new FlaggedTermClassifier()];

export interface SafetyRequest {
  mediaId: string;
  context: ContextAnalysis;
  text: TextAnalysis | null;
  /** Terms to look for; disabled ones are ignored. */
  terms: readonly CustomFilter[];
  classifiers?: readonly SafetyClassifier[];
}

const emptyResult = (c: (typeof TAXONOMY)[number]): CategoryResult => ({
  category: c.id, evaluation: 'not-supported', reason: 'no-classifier', modalities: { evaluated: [] as Modality[], missing: [] as Modality[] }, findings: [], warnings: [],
});

/**
 * Runs the available classifiers over EXISTING evidence and assembles the report for the WHOLE taxonomy: every category is
 * listed with its real support status, so a category that cannot be evaluated is visible as such and is never mistaken
 * for a clean result. Does not mutate the evidence and calls no external service.
 *
 * Invalid findings (bad ranges, missing evidence) are rejected and counted, never repaired.
 */
export async function analyzeSafety(req: SafetyRequest): Promise<SafetyAnalysis> {
  const classifiers = req.classifiers ?? DEFAULT_CLASSIFIERS;
  const terms = req.terms.filter((t) => t.enabled);
  const base = {
    mediaId: req.mediaId, taxonomyVersion: TAXONOMY_VERSION, inputs: req.context.inputs, policy: { ...FLAGGED_TERMS_POLICY }, termCount: terms.length,
    durationMs: req.context.durationMs, classifiers: classifiers.map((c) => c.info),
  };
  const reportsOf = (results: Map<string, CategoryResult>): CategoryReport[] => TAXONOMY.map((c) => {
    const r = results.get(c.id) ?? emptyResult(c);
    return { category: c.id, label: c.label, support: c.support, evaluation: r.evaluation, reason: r.reason, modalities: r.modalities, findingCount: r.findings.length };
  });

  if (req.context.status === 'pending' || !req.text) {
    return { ...base, status: 'pending', categories: reportsOf(new Map()), findings: [], warnings: [] };
  }

  const results = new Map<string, CategoryResult>();
  let invalid = 0;
  const warnings = new Map<string, number>();
  const textEvents = req.text.status === 'ready' ? req.text.timeline : [];
  for (const classifier of classifiers) {
    let produced: CategoryResult[];
    try {
      produced = await classifier.classify({ mediaId: req.mediaId, terms, textEvents, context: req.context });
    } catch {
      // A failing classifier is a failure to evaluate, never an empty (clean-looking) result. Its error detail is not exposed.
      produced = classifier.categories.map((category): CategoryResult => ({ category, evaluation: 'abstained', reason: 'classifier-failed', modalities: { evaluated: [], missing: [] }, findings: [], warnings: [] }));
    }
    for (const r of produced) {
      const valid = r.findings.filter((f) => validateFinding(f).length === 0);
      invalid += r.findings.length - valid.length;
      for (const w of r.warnings) warnings.set(w.code, (warnings.get(w.code) ?? 0) + w.count);
      results.set(r.category, { ...r, findings: valid });
    }
  }
  const findings: SafetyFinding[] = [...results.values()].flatMap((r) => r.findings).sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (invalid > 0) warnings.set('invalid-finding', invalid);

  const categories = reportsOf(results);
  const implemented = categories.filter((c) => c.support === 'implemented');
  const ran = implemented.filter((c) => c.evaluation === 'evaluated' || c.evaluation === 'partial');
  const status: SafetyStatus = ran.length === 0 ? 'not-evaluated' : implemented.every((c) => c.evaluation === 'evaluated') ? 'ready' : 'partial';
  return { ...base, status, categories, findings, warnings: [...warnings].map(([code, count]) => ({ code: code as 'invalid-finding', count })) };
}

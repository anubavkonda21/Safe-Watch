import { TAXONOMY_VERSION, type SafetyAnalysis, type SafetyFinding } from '@/domain/safety/finding';
import { safetyFor } from './safetyAnalysis';

/** A finding whose evidence matches its own interval (as the real classifier produces), unless a test overrides it on purpose. */
export const finding = (over: Partial<SafetyFinding> = {}): SafetyFinding => {
  const startMs = over.startMs ?? 10_000;
  const endMs = over.endMs ?? 10_500;
  return {
    id: 'sf-flagged-terms-0000', category: 'flagged-terms', taxonomyVersion: TAXONOMY_VERSION, startMs, endMs, status: 'detected', rawScore: null, calibratedProbability: null,
    evidence: [{ evidenceId: 'e', modality: 'speech', kind: 'speech', startMs, endMs, sourceId: 'aud-0', contextEventId: 'ctx-0000', sourceConfidence: 0.9 }],
    explanation: 'x', warnings: [], classifier: { id: 'flagged-terms-matcher', version: '1', kind: 'rule-based' }, attributes: { term: 'Darn', matchMode: 'word-boundary', matchedText: 'darn' }, ...over,
  };
};

/** The shared real analysis shell with the given findings and status substituted. */
export const analysisWith = async (findings: SafetyFinding[], status: SafetyAnalysis['status'] = 'ready'): Promise<SafetyAnalysis> => ({ ...(await safetyFor('m', [])), status, findings });

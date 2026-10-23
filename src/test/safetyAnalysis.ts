import { createCustomFilter, type MatchMode } from '@/domain/text/customFilter';
import { analyzeSafety } from '@/domain/safety/analyze';
import type { SafetyAnalysis } from '@/domain/safety/finding';
import { readyContext } from './contextAnalysis';
import { readyTextAnalysis } from './textAnalysis';
import type { ContextSource } from '@/domain/context/contextAnalysis';

/** A real analysis of the shared text fixtures, produced by the real classifier, for the given terms. */
export async function safetyFor(mediaId: string, terms: Array<[string, MatchMode]>, over: Partial<ContextSource> = {}): Promise<SafetyAnalysis> {
  const text = readyTextAnalysis(mediaId);
  const context = readyContext(mediaId, { text, ...over });
  const filters = terms.map(([phrase, mode], i) => {
    const r = createCustomFilter(phrase, mode, [], { id: `t${i}`, now: 'x' });
    if (!r.ok) throw new Error(r.reason);
    return r.filter;
  });
  return analyzeSafety({ mediaId, context, text, terms: filters });
}

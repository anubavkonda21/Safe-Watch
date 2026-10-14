import type { EvidenceItem, Modality } from '@/domain/evidence/evidence';

/** Deterministic synthetic evidence for context tests. Times are media seconds. */
export const ev = (modality: Modality, id: string, startSeconds: number, endSeconds = startSeconds, over: Partial<EvidenceItem> = {}): EvidenceItem => ({
  id, modality, kind: modality === 'visual' ? 'object' : modality, startSeconds, endSeconds, label: `${id} label`, confidence: modality === 'subtitle' ? null : 0.8,
  sourceId: modality === 'visual' ? 'frm-00000' : modality === 'speech' ? 'aud-0' : 'sub-0', ...over,
});
export const speech = (id: string, s: number, e: number, over: Partial<EvidenceItem> = {}) => ev('speech', id, s, e, over);
export const subtitle = (id: string, s: number, e: number, over: Partial<EvidenceItem> = {}) => ev('subtitle', id, s, e, over);
export const visual = (id: string, t: number, over: Partial<EvidenceItem> = {}) => ev('visual', id, t, t, over);

/** Seeded Fisher-Yates shuffle (mulberry32), so "out of order" tests are reproducible. */
export function shuffled<T>(list: readonly T[], seed = 7): T[] {
  const out = [...list];
  let a = seed;
  const rand = () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [out[i], out[j]] = [out[j]!, out[i]!]; }
  return out;
}

export const FIXTURES = {
  /** A: one utterance, its subtitle and what is on screen. */
  fullMultimodal: [speech('spe-0', 10.0, 11.2), subtitle('sub-0', 10.1, 11.1), visual('vis-0', 10.3, { label: 'person', sourceId: 'frm-00001' }), visual('vis-1', 10.8, { label: 'box', sourceId: 'frm-00002' })],
  /** B: two moments far apart. */
  separated: [speech('spe-0', 10.0, 10.2), visual('vis-0', 10.4), visual('vis-1', 30.0)],
  /** C / D / E */
  speechOnly: [speech('spe-0', 5, 7)],
  visualOnly: [visual('vis-0', 5), visual('vis-1', 5.5)],
  subtitleAndVisual: [subtitle('sub-0', 20, 22), visual('vis-0', 21)],
  /** F: one subtitle cue 30 s long with visuals inside it. */
  longSubtitle: [subtitle('sub-0', 10, 40), visual('vis-0', 12), visual('vis-1', 25), visual('vis-2', 38)],
} satisfies Record<string, EvidenceItem[]>;

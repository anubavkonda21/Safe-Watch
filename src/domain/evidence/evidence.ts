import type { TextEvent } from '../text/textEvent';
import type { VisualObservation } from '../vision/observation';

/**
 * A modality-neutral view of evidence on the ONE media timeline, so later
 * stages can correlate TEXT + SPEECH + VISUAL evidence at the same moments.
 *
 * Decision (Checkpoint 5): the speech/subtitle timeline (`TextEvent`) and the
 * visual timeline (`VisualObservation`) remain independent and unchanged; this
 * module only PROJECTS both into a common shape. Nothing in the existing
 * speech, subtitle or filter code was refactored, and nothing consumes this
 * projection yet. It carries no judgement: it says what was seen or said and when.
 */
export type Modality = 'speech' | 'subtitle' | 'visual';

export interface EvidenceItem {
  /** The id of the underlying TextEvent or VisualObservation. */
  id: string;
  modality: Modality;
  /** What kind of evidence: `speech`, `subtitle`, or the visual observation type. */
  kind: string;
  startSeconds: number;
  /** Equal to `startSeconds` for instants (a visual observation belongs to one frame). */
  endSeconds: number;
  /** Spoken/written text, or the visual label. Untrusted plain text. */
  label: string;
  confidence: number | null;
  /** The extraction/analysis track or frame the item came from. */
  sourceId: string;
}

export const evidenceFromTextEvent = (e: TextEvent): EvidenceItem => ({
  id: e.id, modality: e.source, kind: e.source, startSeconds: e.startSeconds, endSeconds: e.endSeconds, label: e.text, confidence: e.confidence, sourceId: e.trackId,
});

export const evidenceFromObservation = (o: VisualObservation): EvidenceItem => ({
  id: o.id, modality: 'visual', kind: o.type, startSeconds: o.timestampSeconds, endSeconds: o.timestampSeconds,
  label: o.attributes?.text ?? o.label, confidence: o.confidence, sourceId: o.frameId,
});

const MODALITY_ORDER: Record<Modality, number> = { speech: 0, subtitle: 1, visual: 2 };
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** One chronological list across modalities: time, then end, then modality, then id. Deterministic. */
export function buildEvidenceTimeline(text: readonly TextEvent[], visual: readonly VisualObservation[]): EvidenceItem[] {
  return [...text.map(evidenceFromTextEvent), ...visual.map(evidenceFromObservation)].sort(
    (a, b) => a.startSeconds - b.startSeconds || a.endSeconds - b.endSeconds || MODALITY_ORDER[a.modality] - MODALITY_ORDER[b.modality] || cmp(a.id, b.id),
  );
}

/** Evidence of ANY modality whose time span overlaps [start, end] (inclusive). */
export const evidenceBetween = (items: readonly EvidenceItem[], startSeconds: number, endSeconds: number): EvidenceItem[] =>
  items.filter((i) => i.startSeconds <= endSeconds && i.endSeconds >= startSeconds);

import type { Modality } from '../evidence/evidence';
import { type Ms } from './time';

/**
 * Contextual evidence: which pieces of evidence (speech, subtitles, visual
 * observations) belong together on the media timeline. A ContextEvent says
 * WHAT was present and WHEN. It deliberately says nothing about whether the
 * content is acceptable: there is no judgement, label, score or policy field
 * anywhere in this model. A later stage may consume it.
 */

/**
 * Correlation settings. All times are milliseconds of media time.
 *
 * Why these defaults:
 *  - windowBeforeMs 500 / windowAfterMs 1000: two pieces of evidence are related when the later one starts no more than
 *    `before + after` = 1.5 s after the earlier one ends. A spoken sentence, its subtitle cue and an on-screen reaction fall
 *    inside that; separate sentences (pauses of seconds) do not.
 *  - maxContextMs 20000: a context never grows beyond about one scene-sized span, however long a chain of near neighbours is.
 *    Evidence that is itself longer than this (a long subtitle) is "extended": it keeps its own event and is only referenced
 *    from the events it overlaps, so it cannot glue unrelated moments together.
 *  - maxVisualCoverageMs 5000: a sampled frame is a snapshot that stands for the moments around it. Against speech and subtitles
 *    it reaches half the sampling step to each side (capped here), so sparse frames (default step 10 s) can still be related to
 *    nearby text. Frames are never chained to each other through this reach, which prevents a whole video forming one event.
 */
export interface ContextConfig {
  windowBeforeMs: Ms;
  windowAfterMs: Ms;
  maxContextMs: Ms;
  maxVisualCoverageMs: Ms;
}

export const DEFAULT_CONTEXT_CONFIG: ContextConfig = { windowBeforeMs: 500, windowAfterMs: 1000, maxContextMs: 20_000, maxVisualCoverageMs: 5000 };

export function validateContextConfig(c: ContextConfig): string[] {
  const problems: string[] = [];
  for (const k of ['windowBeforeMs', 'windowAfterMs', 'maxContextMs', 'maxVisualCoverageMs'] as const) {
    if (!Number.isSafeInteger(c[k]) || c[k] < 0) problems.push(`${k} must be a non-negative integer`);
  }
  if (c.maxContextMs < 1) problems.push('maxContextMs must be at least 1');
  return problems;
}

/** How a member became part of its event. `ambient` evidence is listed but not a member (see ContextEvent.ambient). */
export type JoinReason = 'anchor' | 'overlap' | 'proximity' | 'visual-coverage' | 'ambient';

/** One piece of evidence with its provenance intact: modality, kind, exact time, original confidence, and the track or frame it came from. */
export interface ContextMember {
  evidenceId: string;
  modality: Modality;
  /** `speech`, `subtitle`, or the visual observation type (`classification`, `object`, `text`). */
  kind: string;
  startMs: Ms;
  endMs: Ms;
  /** Spoken/written text or the visual label. Untrusted plain text. */
  label: string;
  /** The SOURCE's own confidence, never rescaled or combined; null when the source gave none. */
  confidence: number | null;
  /** The audio/subtitle track or the frame the evidence came from. */
  sourceId: string;
  joinedBy: JoinReason;
}

/** Per-modality confidence summary. Different modalities' confidences mean different things, so they are never averaged together. */
export interface SourceConfidence {
  modality: Modality;
  count: number;
  withConfidence: number;
  min: number | null;
  max: number | null;
}

export interface ContextHighlight {
  modality: Modality;
  kind: string;
  label: string;
  confidence: number | null;
}

export interface ContextFacts {
  speechPresent: boolean;
  subtitlePresent: boolean;
  visualEvidenceAvailable: boolean;
  /** Any written or spoken text, or text recognised in a frame. */
  textAvailable: boolean;
  /** Number of members per kind. */
  kinds: Record<string, number>;
  /** Strongest distinct visual observations (by the provider's own confidence), at most five. */
  highlights: ContextHighlight[];
}

/** Why the event stopped growing. */
export type ClosedBy = 'gap' | 'max-duration' | 'end-of-evidence' | 'long-evidence';

export interface ContextEvent {
  /** `ctx-0000`: the position in chronological order, so the same input always yields the same ids. */
  id: string;
  startMs: Ms;
  endMs: Ms;
  /** Modalities that contributed members, in a fixed order (speech, subtitle, visual). */
  sources: Modality[];
  /** `multi-source` when at least two modalities contributed members. Structure only: not a strength or safety claim. */
  corroboration: 'multi-source' | 'single-source';
  members: ContextMember[];
  /** Extended (very long) evidence that overlaps this event in time but was not merged into it. */
  ambient: ContextMember[];
  /** True for the event that holds one piece of extended evidence on its own. */
  extended: boolean;
  closedBy: ClosedBy;
  facts: ContextFacts;
  confidence: SourceConfidence[];
}

export const MODALITY_ORDER: readonly Modality[] = ['speech', 'subtitle', 'visual'];

import { normalizeTranscriptText } from '../speech/normalize';

/**
 * Visual evidence: what an image model REPORTS about a frame. These are
 * descriptive observations with timestamps on the ORIGINAL media timeline.
 * They are not safety judgements: nothing here scores, classifies as safe or
 * unsafe, blocks or censors. Labels are the provider's own vocabulary and a
 * label is a model output, not ground truth (a pure black frame can be
 * labelled "night sky").
 */
export const OBSERVATION_TYPES = ['classification', 'object', 'text'] as const;
/**
 *  - classification: an image-level label ("outdoor", "living_room").
 *  - object: a localised thing with a bounding region ("person").
 *  - text: text recognised in the image (OCR); the string is in `attributes.text`.
 */
export type ObservationType = (typeof OBSERVATION_TYPES)[number];

/** Normalised rectangle: fractions of the image, origin at the TOP-LEFT, x/y/width/height in [0, 1]. */
export interface BoundingRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VisualObservation {
  /** Unique within a media item: `vis-<frameId>-<n>`. */
  id: string;
  frameId: string;
  frameIndex: number;
  /** Seconds on the original media timeline (the frame's own timestamp; providers never supply time). */
  timestampSeconds: number;
  type: ObservationType;
  /** Provider vocabulary, e.g. `living_room`. Untrusted plain text. */
  label: string;
  /** Provider-reported probability in [0, 1], or null when the provider gave none. Never invented. */
  confidence: number | null;
  region: BoundingRegion | null;
  /** Extra provider data. Currently only `text` for OCR. Untrusted plain text. */
  attributes: { text?: string } | null;
  provider: string;
  model: string;
}

/** What a provider adapter returns for one observation: untrusted until normalised. */
export interface RawObservation {
  type?: unknown;
  label?: unknown;
  confidence?: unknown;
  region?: unknown;
  text?: unknown;
}

export interface ObservationContext {
  frameId: string;
  frameIndex: number;
  timestampSeconds: number;
  provider: string;
  model: string;
}

export type ObservationIssue = 'invalid-type' | 'empty-label' | 'invalid-region' | 'invalid-confidence';

const MAX_LABEL = 80;
const MAX_TEXT = 200;
const EPS = 1e-6;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function isValidRegion(r: unknown): r is BoundingRegion {
  if (typeof r !== 'object' || r === null) return false;
  const { x, y, width, height } = r as Record<string, unknown>;
  return finite(x) && finite(y) && finite(width) && finite(height)
    && x >= 0 && y >= 0 && width > 0 && height > 0 && x + width <= 1 + EPS && y + height <= 1 + EPS;
}

/**
 * Turns one provider observation into a SafeWatch observation, or rejects it.
 * Unknown types and empty labels are dropped; an invalid region is removed
 * (the observation stays, without a region) and an out-of-range confidence
 * becomes null: values are never "fixed up". Returns the issues it handled so
 * callers can count them.
 */
export function normalizeObservation(
  raw: RawObservation,
  ctx: ObservationContext,
  n: number,
): { observation: VisualObservation | null; issues: ObservationIssue[] } {
  const issues: ObservationIssue[] = [];
  if (!(OBSERVATION_TYPES as readonly unknown[]).includes(raw.type)) return { observation: null, issues: ['invalid-type'] };
  const label = normalizeTranscriptText(raw.label).slice(0, MAX_LABEL);
  if (label === '') return { observation: null, issues: ['empty-label'] };

  let confidence: number | null = null;
  if (raw.confidence !== undefined && raw.confidence !== null) {
    if (finite(raw.confidence) && raw.confidence >= 0 && raw.confidence <= 1) confidence = raw.confidence;
    else issues.push('invalid-confidence');
  }

  let region: BoundingRegion | null = null;
  if (raw.region !== undefined && raw.region !== null) {
    if (isValidRegion(raw.region)) {
      const r = raw.region;
      region = { x: clamp01(r.x), y: clamp01(r.y), width: clamp01(r.width), height: clamp01(r.height) };
    } else issues.push('invalid-region');
  }

  const text = normalizeTranscriptText(raw.text).slice(0, MAX_TEXT);
  return {
    observation: {
      id: `vis-${ctx.frameId}-${n}`,
      frameId: ctx.frameId,
      frameIndex: ctx.frameIndex,
      timestampSeconds: ctx.timestampSeconds,
      type: raw.type as ObservationType,
      label,
      confidence,
      region,
      attributes: text !== '' ? { text } : null,
      provider: ctx.provider,
      model: ctx.model,
    },
    issues,
  };
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

const TYPE_ORDER: Record<ObservationType, number> = { object: 0, text: 1, classification: 2 };
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Total, deterministic order for a media's visual evidence: media time, then
 * frame index (so frames that share a timestamp keep a stable order), then
 * type (objects, text, classifications), then confidence (highest first, unknown last),
 * then label, then id.
 */
export function compareObservations(a: VisualObservation, b: VisualObservation): number {
  return (
    a.timestampSeconds - b.timestampSeconds ||
    a.frameIndex - b.frameIndex ||
    TYPE_ORDER[a.type] - TYPE_ORDER[b.type] ||
    (b.confidence ?? -1) - (a.confidence ?? -1) ||
    cmp(a.label, b.label) ||
    cmp(a.id, b.id)
  );
}

export const sortObservations = (list: readonly VisualObservation[]): VisualObservation[] => [...list].sort(compareObservations);

/** "interior_room" → "interior room" for display. The stored label is never altered. */
export const humanizeLabel = (label: string): string => label.replace(/_/g, ' ');

import type { EvidenceItem, Modality } from '../evidence/evidence';
import {
  DEFAULT_CONTEXT_CONFIG, MODALITY_ORDER, type ClosedBy, type ContextConfig, type ContextEvent, type ContextFacts, type ContextHighlight, type ContextMember, type JoinReason, type SourceConfidence,
} from './contextEvent';
import { durationMs, intervalsOverlap, isValidInterval, toMs, type Ms } from './time';

export interface CorrelationInput {
  evidence: readonly EvidenceItem[];
  /** Distance between sampled frames, for the visual coverage reach. Null/0: frames have no reach. */
  visualStepMs?: Ms | null;
  config?: Partial<ContextConfig>;
}

export interface CorrelationResult {
  events: ContextEvent[];
  /** Evidence dropped because it was malformed (bad ids, times, modality). */
  invalid: number;
  /** Evidence dropped because the same id, or the same content, was already present. */
  duplicates: number;
  /** Evidence accepted into the correlation. */
  accepted: number;
}

interface Item extends ContextMember { coverageMs: Ms }

const MODALITY_RANK: Record<Modality, number> = { speech: 0, subtitle: 1, visual: 2 };
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const compareItems = (a: ContextMember, b: ContextMember) =>
  a.startMs - b.startMs || a.endMs - b.endMs || MODALITY_RANK[a.modality] - MODALITY_RANK[b.modality] || cmp(a.evidenceId, b.evidenceId);

const isModality = (v: unknown): v is Modality => v === 'speech' || v === 'subtitle' || v === 'visual';

/** Converts one raw evidence item, or null when it cannot be trusted. Never repairs values. */
function toItem(e: EvidenceItem, coverageMs: Ms): Item | null {
  if (typeof e !== 'object' || e === null) return null;
  if (typeof e.id !== 'string' || e.id === '' || !isModality(e.modality) || typeof e.kind !== 'string' || typeof e.sourceId !== 'string') return null;
  if (typeof e.startSeconds !== 'number' || typeof e.endSeconds !== 'number' || !Number.isFinite(e.startSeconds) || !Number.isFinite(e.endSeconds)) return null;
  const startMs = toMs(e.startSeconds);
  const endMs = toMs(e.endSeconds);
  if (!isValidInterval({ startMs, endMs })) return null;
  const confidence = typeof e.confidence === 'number' && e.confidence >= 0 && e.confidence <= 1 ? e.confidence : null;
  return {
    evidenceId: e.id, modality: e.modality, kind: e.kind, startMs, endMs, label: typeof e.label === 'string' ? e.label : '', confidence, sourceId: e.sourceId,
    joinedBy: 'anchor', coverageMs: e.modality === 'visual' ? coverageMs : 0,
  };
}

interface Window {
  items: Item[];
  start: Ms;
  end: Ms;
  /** Latest reach of non-visual members: end + windowAfter. */
  reachText: Ms;
  /** Latest plain reach of visual members: end + windowAfter. */
  reachVisual: Ms;
  /** Latest reach of visual members including their frame coverage (only text may use it). */
  reachVisualCovered: Ms;
  closedBy: ClosedBy;
}

/**
 * Deterministic temporal correlation, one forward pass over time-sorted
 * evidence: O(n log n) for the sort, O(n) for the pass.
 *
 *  1. Validate, convert to integer milliseconds, drop malformed items and duplicates (counted, never silent).
 *  2. Sort by start, end, modality, id: input order cannot matter.
 *  3. Extended evidence (longer than maxContextMs) leaves the pass and becomes its own event.
 *  4. Every other item joins the open window when it is related to it, otherwise a new window starts:
 *       overlap/proximity: the item starts no later than `windowBefore` before the window's latest reach (end + windowAfter);
 *       visual coverage:   a frame may also relate to text through its coverage; frames never chain to frames this way.
 *     A window also stops when joining would make it longer than maxContextMs.
 *     A frame attached ONLY through its coverage does not extend the window's reach, so two sentences cannot be bridged by a frame between them.
 *  5. Extended evidence is attached as `ambient` to each event it overlaps.
 * Windows never reopen: an item is related to the most recent window only.
 */
export function correlateEvidence(input: CorrelationInput): CorrelationResult {
  const config: ContextConfig = { ...DEFAULT_CONTEXT_CONFIG, ...input.config };
  const coverageMs = Math.min(config.maxVisualCoverageMs, Math.max(0, Math.floor((input.visualStepMs ?? 0) / 2)));
  const { windowBeforeMs: before, windowAfterMs: after, maxContextMs } = config;

  let invalid = 0;
  let duplicates = 0;
  const seenIds = new Set<string>();
  const seenContent = new Set<string>();
  const items: Item[] = [];
  const sortedInput = input.evidence.map((e) => toItem(e, coverageMs));
  for (const it of sortedInput) {
    if (!it) { invalid += 1; continue; }
    items.push(it);
  }
  items.sort(compareItems);
  const unique: Item[] = [];
  for (const it of items) {
    const content = `${it.modality}|${it.kind}|${it.startMs}|${it.endMs}|${it.sourceId}|${it.label}`;
    if (seenIds.has(it.evidenceId) || seenContent.has(content)) { duplicates += 1; continue; }
    seenIds.add(it.evidenceId);
    seenContent.add(content);
    unique.push(it);
  }

  const extended = unique.filter((i) => durationMs(i) > maxContextMs);
  const regular = unique.filter((i) => durationMs(i) <= maxContextMs);

  const windows: Window[] = [];
  let open: Window | null = null;
  const reaches = (w: Window, i: Item) => {
    // A frame attached only through its coverage is a satellite: it explains the moment but does not extend what other evidence can reach (no bridging between two sentences).
    if (i.modality === 'visual' && i.joinedBy === 'visual-coverage') return;
    const reach = i.endMs + after;
    if (i.modality === 'visual') { w.reachVisual = Math.max(w.reachVisual, reach); w.reachVisualCovered = Math.max(w.reachVisualCovered, reach + i.coverageMs); } else w.reachText = Math.max(w.reachText, reach);
  };
  const startWindow = (i: Item): Window => {
    const w: Window = { items: [{ ...i, joinedBy: 'anchor' }], start: i.startMs, end: i.endMs, reachText: -Infinity, reachVisual: -Infinity, reachVisualCovered: -Infinity, closedBy: 'end-of-evidence' };
    reaches(w, i);
    windows.push(w);
    return w;
  };
  for (const i of regular) {
    if (!open) { open = startWindow(i); continue; }
    const s = i.startMs - before;
    let reason: JoinReason | null = null;
    if (i.modality === 'visual') {
      if (s <= open.reachVisual || s - i.coverageMs <= open.reachText) reason = i.startMs <= open.end ? 'overlap' : s <= open.reachVisual || s <= open.reachText ? 'proximity' : 'visual-coverage';
    } else if (s <= Math.max(open.reachText, open.reachVisual)) reason = i.startMs <= open.end ? 'overlap' : 'proximity';
    else if (s <= open.reachVisualCovered) reason = 'visual-coverage';
    if (reason === null) { open.closedBy = 'gap'; open = startWindow(i); continue; }
    if (Math.max(open.end, i.endMs) - open.start > maxContextMs) { open.closedBy = 'max-duration'; open = startWindow(i); continue; }
    const joined = { ...i, joinedBy: reason };
    open.items.push(joined);
    open.end = Math.max(open.end, i.endMs);
    reaches(open, joined);
  }

  const built: Array<{ w: Window; extended: boolean }> = windows.map((w) => ({ w, extended: false }));
  for (const i of extended) {
    built.push({ w: { items: [{ ...i, joinedBy: 'anchor' }], start: i.startMs, end: i.endMs, reachText: -Infinity, reachVisual: -Infinity, reachVisualCovered: -Infinity, closedBy: 'long-evidence' }, extended: true });
  }
  built.sort((a, b) => a.w.start - b.w.start || a.w.end - b.w.end || compareItems(a.w.items[0]!, b.w.items[0]!));

  const events = built.map(({ w, extended: isExtended }, index): ContextEvent => {
    const members = w.items.map(stripInternal).sort(compareItems);
    const ambient = isExtended ? [] : extended.filter((x) => intervalsOverlap(x, { startMs: w.start, endMs: w.end })).map((x) => ({ ...stripInternal(x), joinedBy: 'ambient' as const })).sort(compareItems);
    const sources = MODALITY_ORDER.filter((m) => members.some((x) => x.modality === m));
    return {
      id: `ctx-${String(index).padStart(4, '0')}`, startMs: w.start, endMs: w.end, sources, corroboration: sources.length >= 2 ? 'multi-source' : 'single-source',
      members, ambient, extended: isExtended, closedBy: w.closedBy, facts: factsOf(members), confidence: confidenceOf(members),
    };
  });
  return { events, invalid, duplicates, accepted: unique.length };
}

function stripInternal(i: Item | ContextMember): ContextMember {
  const { evidenceId, modality, kind, startMs, endMs, label, confidence, sourceId, joinedBy } = i;
  return { evidenceId, modality, kind, startMs, endMs, label, confidence, sourceId, joinedBy };
}

function factsOf(members: readonly ContextMember[]): ContextFacts {
  const kinds: Record<string, number> = {};
  for (const m of members) kinds[m.kind] = (kinds[m.kind] ?? 0) + 1;
  const best = new Map<string, ContextHighlight>();
  for (const m of members) {
    if (m.modality !== 'visual') continue;
    const key = `${m.kind}|${m.label}`;
    const current = best.get(key);
    if (!current || (m.confidence ?? -1) > (current.confidence ?? -1)) best.set(key, { modality: m.modality, kind: m.kind, label: m.label, confidence: m.confidence });
  }
  const highlights = [...best.values()].sort((a, b) => (b.confidence ?? -1) - (a.confidence ?? -1) || cmp(a.kind, b.kind) || cmp(a.label, b.label)).slice(0, 5);
  const has = (m: Modality) => members.some((x) => x.modality === m);
  return {
    speechPresent: has('speech'), subtitlePresent: has('subtitle'), visualEvidenceAvailable: has('visual'),
    textAvailable: has('speech') || has('subtitle') || members.some((x) => x.kind === 'text'), kinds: Object.fromEntries(Object.entries(kinds).sort(([a], [b]) => cmp(a, b))), highlights,
  };
}

function confidenceOf(members: readonly ContextMember[]): SourceConfidence[] {
  return MODALITY_ORDER.flatMap((modality) => {
    const own = members.filter((m) => m.modality === modality);
    if (own.length === 0) return [];
    const values = own.flatMap((m) => (m.confidence === null ? [] : [m.confidence]));
    return [{ modality, count: own.length, withConfidence: values.length, min: values.length ? Math.min(...values) : null, max: values.length ? Math.max(...values) : null }];
  });
}

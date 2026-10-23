import { normalizeForMatching, tokenize } from '../text/normalizeForMatching';

/**
 * A report of a word or phrase the user thinks SafeWatch missed. It is a NOTE kept in this browser for the user's own review.
 * It is not a finding: it is never added to the detected findings, it does not change the analysis, and it trains nothing.
 */
export const REPORT_CATEGORIES = ['heard', 'subtitle', 'unsure'] as const;
/** Where the user noticed it. These are the only things the product can represent reliably today (speech and subtitles). */
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];

export const REPORT_CATEGORY_LABEL: Record<ReportCategory, string> = { heard: 'I heard it', subtitle: 'It was in the subtitles', unsure: 'Not sure where' };

export const MAX_REPORT_PHRASE = 200;
export const MAX_REPORT_NOTE = 200;
export const MAX_REPORTS = 200;

export interface MissedReport {
  id: string;
  /** A random id for the video that was open: it links reports from one viewing together and identifies nothing about the file. */
  session: string;
  /** Media time in integer milliseconds. */
  timestampMs: number;
  /** The video's length when it was reported (milliseconds), so the time can be understood later. */
  durationMs: number | null;
  /** The phrase as the user wrote it (cleaned). Untrusted text. */
  phrase: string;
  category: ReportCategory;
  note: string;
  /** ISO 8601. */
  createdAt: string;
}

export type ReportRejection = 'empty-phrase' | 'phrase-too-long' | 'no-words' | 'note-too-long' | 'invalid-timestamp' | 'outside-media' | 'invalid-category' | 'limit-reached';

export type ReportResult = { ok: true; report: MissedReport } | { ok: false; reason: ReportRejection };

/**
 * Parses what a person types as a time: `90`, `90.5`, `1:30`, `1:30.5`, `01:02:03`. Returns integer milliseconds or null.
 * Strict: anything else (negative, empty, text, too many parts, minutes or seconds out of range after a colon) is null.
 */
export function parseTimestamp(input: string): number | null {
  const text = input.trim();
  if (text === '' || text.length > 16) return null;
  const parts = text.split(':');
  if (parts.length > 3 || !parts.every((p) => /^\d+(\.\d+)?$/.test(p))) return null;
  if (parts.length > 1 && parts.slice(1).some((p) => parseFloat(p) >= 60)) return null;
  if (parts.slice(0, -1).some((p) => p.includes('.'))) return null;
  const seconds = parts.reduce((acc, p) => acc * 60 + parseFloat(p), 0);
  const ms = Math.round(seconds * 1000);
  return Number.isSafeInteger(ms) ? ms : null;
}

/** `m:ss.s` for display and for prefilling a field; parseTimestamp reads it back to the same millisecond (rounded to 0.1 s). */
export function formatTimestamp(ms: number): string {
  const tenths = Math.round(Math.max(0, ms) / 100);
  const m = Math.floor(tenths / 600);
  const s = Math.floor((tenths % 600) / 10);
  return `${m}:${String(s).padStart(2, '0')}.${tenths % 10}`;
}

export interface ReportInput {
  timestamp: string;
  phrase: string;
  category: string;
  note: string;
}

export interface ReportContext {
  session: string;
  durationMs: number | null;
  existingCount: number;
  id: string;
  now: string;
}

/** Validates and builds a report. Nothing is repaired silently: a bad time, an empty phrase or a time beyond the video is rejected. */
export function createReport(input: ReportInput, ctx: ReportContext): ReportResult {
  if (ctx.existingCount >= MAX_REPORTS) return { ok: false, reason: 'limit-reached' };
  const phrase = normalizeForMatching(input.phrase.normalize('NFC'));
  if (phrase === '') return { ok: false, reason: 'empty-phrase' };
  if (phrase.length > MAX_REPORT_PHRASE) return { ok: false, reason: 'phrase-too-long' };
  if (tokenize(phrase).length === 0) return { ok: false, reason: 'no-words' };
  const note = normalizeForMatching(input.note.normalize('NFC'));
  if (note.length > MAX_REPORT_NOTE) return { ok: false, reason: 'note-too-long' };
  if (!(REPORT_CATEGORIES as readonly string[]).includes(input.category)) return { ok: false, reason: 'invalid-category' };
  const timestampMs = parseTimestamp(input.timestamp);
  if (timestampMs === null) return { ok: false, reason: 'invalid-timestamp' };
  if (ctx.durationMs !== null && timestampMs > ctx.durationMs) return { ok: false, reason: 'outside-media' };
  return { ok: true, report: { id: ctx.id, session: ctx.session, timestampMs, durationMs: ctx.durationMs, phrase, category: input.category as ReportCategory, note, createdAt: ctx.now } };
}

/** Stored data is untrusted: anything malformed is dropped, never repaired. */
export function parseStoredReports(raw: unknown): MissedReport[] {
  if (!Array.isArray(raw)) return [];
  const out: MissedReport[] = [];
  for (const item of raw.slice(0, MAX_REPORTS)) {
    if (typeof item !== 'object' || item === null) continue;
    const r = item as Record<string, unknown>;
    if (typeof r.id !== 'string' || typeof r.session !== 'string' || typeof r.phrase !== 'string' || typeof r.createdAt !== 'string' || typeof r.note !== 'string') continue;
    if (!Number.isSafeInteger(r.timestampMs) || (r.timestampMs as number) < 0) continue;
    if (r.durationMs !== null && !(Number.isSafeInteger(r.durationMs) && (r.durationMs as number) > 0)) continue;
    if (!(REPORT_CATEGORIES as readonly string[]).includes(r.category as string)) continue;
    const phrase = normalizeForMatching(r.phrase);
    if (phrase === '' || phrase.length > MAX_REPORT_PHRASE || tokenize(phrase).length === 0 || r.note.length > MAX_REPORT_NOTE) continue;
    if (out.some((x) => x.id === r.id)) continue;
    out.push({
      id: r.id.slice(0, 64), session: r.session.slice(0, 64), timestampMs: r.timestampMs as number, durationMs: r.durationMs as number | null, phrase,
      category: r.category as ReportCategory, note: r.note, createdAt: r.createdAt.slice(0, 40),
    });
  }
  return out;
}

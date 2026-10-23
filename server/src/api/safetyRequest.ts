import { MATCH_MODES, MAX_FILTERS, createCustomFilter, type CustomFilter, type MatchMode } from '@/domain/text/customFilter';
import { MediaServiceError } from '../application/errors';

export const MAX_SAFETY_BODY_BYTES = 32 * 1024;

/**
 * Parses the body of a safety-findings request into flagged terms. Strict by design: anything that is not exactly
 * `{ "terms": [{ "phrase": string, "matchMode": <known mode> }] }` is rejected (no silent dropping, no unknown fields),
 * each phrase goes through the same normalisation and limits as the browser's custom filters, and ids are generated here.
 * The client can supply nothing but words to look for: no paths, no evidence, no settings.
 */
export function parseSafetyTerms(raw: string, contentType: string | undefined): CustomFilter[] {
  const invalid = () => new MediaServiceError('INVALID_REQUEST');
  if (Buffer.byteLength(raw) > MAX_SAFETY_BODY_BYTES) throw invalid();
  if ((contentType ?? '').split(';')[0]?.trim().toLowerCase() !== 'application/json') throw invalid();
  let body: unknown;
  try { body = JSON.parse(raw); } catch { throw invalid(); }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw invalid();
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== 'terms') throw invalid();
  const terms = (body as { terms: unknown }).terms;
  if (!Array.isArray(terms) || terms.length > MAX_FILTERS) throw invalid();
  const out: CustomFilter[] = [];
  for (const t of terms) {
    if (typeof t !== 'object' || t === null || Array.isArray(t)) throw invalid();
    const k = Object.keys(t).sort().join(',');
    const { phrase, matchMode } = t as { phrase?: unknown; matchMode?: unknown };
    if (k !== 'matchMode,phrase' || typeof phrase !== 'string' || typeof matchMode !== 'string' || !(MATCH_MODES as readonly string[]).includes(matchMode)) throw invalid();
    const made = createCustomFilter(phrase, matchMode as MatchMode, out, { id: `term-${out.length}`, now: '1970-01-01T00:00:00.000Z' });
    if (!made.ok) throw invalid();
    out.push(made.filter);
  }
  return out;
}

/** Reads at most `maxBytes` of the request body. Rejects (and stops reading) beyond it. */
export async function readLimitedBody(req: AsyncIterable<Uint8Array>, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new MediaServiceError('INVALID_REQUEST');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

import { toMs, isMs, type Ms } from '../context/time';
import { validateFinding, type FindingStatus, type FindingWarning, type SafetyAnalysis, type SafetyFinding } from '../safety/finding';
import { categoryById, type CategoryId } from '../safety/taxonomy';

/**
 * Playback policy: how a finding's time range becomes the interval a player acts on. Constants, documented here.
 *
 * Precision available from the source findings (CP4 and CP7):
 *  - `word`    speech with word timing. The START comes from forced alignment (about 0.1 s in the CP4 tests); the END is
 *              approximate (the next word's start, or at most one second after the word). Not sample accurate.
 *  - `cue`     a subtitle cue (alone or together with speech). The cue's times are EXACT as authored, but a cue covers the
 *              whole line, not the single word.
 *  - `segment` speech without word timing: the whole recognized segment (a recognizer boundary, a coarse interval).
 * The action interval is the finding interval plus a safety margin for `word` timing (to cover the uncertainty above), none
 * for `cue` and `segment` (their bounds are already whole lines).
 */
export const PLAYBACK_POLICY = {
  word: { beforeMs: 150, afterMs: 250 },
  cue: { beforeMs: 0, afterMs: 0 },
  segment: { beforeMs: 0, afterMs: 0 },
  /** A playhead advance larger than this between two updates is a jump (a seek), not natural playback. */
  naturalAdvanceMs: 1500,
  /** How often the coordinator will retry a skip that landed before the interval's end (some players seek to the previous keyframe). */
  maxSkipAttempts: 3,
} as const;

export type TimingQuality = 'word' | 'cue' | 'segment';

export type UnavailableReason = 'unsupported-category' | 'invalid-finding' | 'invalid-interval' | 'zero-length' | 'outside-media' | 'invalid-duration';

export interface ActionCandidate {
  /** `pa-<findingId>`. */
  id: string;
  mediaId: string;
  findingId: string;
  /**
   * Identity of the occurrence that survives a change of the term list (finding ids are numbered per request, so they shift).
   * User choices are stored under this key.
   */
  overrideKey: string;
  category: CategoryId;
  findingStatus: FindingStatus;
  /** The user's term (untrusted text). */
  term: string | null;
  /** The interval of the source finding, unchanged. */
  findingStartMs: Ms;
  findingEndMs: Ms;
  /** The interval a player would act on: finding interval plus margin, clamped to the media. Equals the finding when unavailable. */
  startMs: Ms;
  endMs: Ms;
  timing: { quality: TimingQuality; startApproximate: boolean; endApproximate: boolean; marginBeforeMs: Ms; marginAfterMs: Ms; note: string };
  availability: 'available' | 'unavailable';
  unavailableReason: UnavailableReason | null;
  warnings: FindingWarning[];
}

const NOTE: Record<TimingQuality, string> = {
  word: 'Speech word timing: the start is aligned (about 0.1 s), the end is approximate. A margin is added. Not sample accurate.',
  cue: 'Subtitle cue timing: exact as written, but it covers the whole line, not only the word.',
  segment: 'Speech segment timing: the whole recognized segment, because no word timing was available.',
};

export function timingQualityOf(f: SafetyFinding): TimingQuality {
  if (!f.warnings.includes('coarse-timing')) return 'word';
  return f.evidence.some((e) => e.modality === 'subtitle') ? 'cue' : 'segment';
}

/** Identity of one occurrence: category, exact range and the listed term, folded. Stable across term-list changes. */
export const overrideKeyOf = (f: SafetyFinding): string => `${f.category}|${f.startMs}|${f.endMs}|${(f.attributes?.term ?? '').normalize('NFKC').toLowerCase()}`;

export interface PlanInput {
  mediaId: string;
  analysis: SafetyAnalysis | null;
  /** Media duration in milliseconds, or null while it is not known. Anything else that is not a positive integer is invalid. */
  durationMs: Ms | null;
}

/**
 * Turns the server's safety findings into action candidates. Pure and deterministic. Never repairs a malformed finding and
 * never invents one: an unsupported category, a finding that fails the CP7 validator, an invalid or zero-length interval,
 * an interval outside the media, or an invalid duration makes a candidate UNAVAILABLE, with the reason, and it is never acted on.
 * Only the margin clamp is applied (a margin that would pass 0 or the media end is cut there), which is unambiguous.
 */
export function planCandidates(input: PlanInput): ActionCandidate[] {
  const { analysis, durationMs } = input;
  if (!analysis || analysis.status === 'pending') return [];
  const durationValid = durationMs === null || (isMs(durationMs) && durationMs > 0);
  return analysis.findings.map((f): ActionCandidate => {
    const quality = timingQualityOf(f);
    const margin = PLAYBACK_POLICY[quality];
    const base = {
      id: `pa-${f.id}`, mediaId: input.mediaId, findingId: f.id, overrideKey: overrideKeyOf(f), category: f.category, findingStatus: f.status, term: f.attributes?.term ?? null,
      findingStartMs: f.startMs, findingEndMs: f.endMs, warnings: [...f.warnings],
      timing: { quality, startApproximate: quality === 'word', endApproximate: quality === 'word' || quality === 'segment', marginBeforeMs: margin.beforeMs, marginAfterMs: margin.afterMs, note: NOTE[quality] },
    };
    const unavailable = (reason: UnavailableReason): ActionCandidate => ({ ...base, startMs: f.startMs, endMs: f.endMs, availability: 'unavailable', unavailableReason: reason });
    if (categoryById(f.category)?.support !== 'implemented') return unavailable('unsupported-category');
    if (validateFinding(f).length > 0) return unavailable('invalid-finding');
    if (!durationValid) return unavailable('invalid-duration');
    if (f.endMs === f.startMs) return unavailable('zero-length');
    if (durationMs !== null && f.startMs >= durationMs) return unavailable('outside-media');
    const startMs = Math.max(0, f.startMs - margin.beforeMs);
    const endMs = durationMs === null ? f.endMs + margin.afterMs : Math.min(durationMs, f.endMs + margin.afterMs);
    return { ...base, startMs, endMs, availability: 'available', unavailableReason: null };
  });
}

export { toMs };

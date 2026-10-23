import type { Ms } from '../context/time';
import type { ActionCandidate } from './planning';

/**
 * What the user chose for one finding.
 *  - `mute` / `skip`: act on it. `none`: nothing configured (the default). `ignore`: the user dismissed it explicitly; it can be undone.
 * `none` and `ignore` behave the same during playback; they are different so the interface can show what the user did.
 */
export type ActionChoice = 'none' | 'mute' | 'skip' | 'ignore';
export type ActionType = 'mute' | 'skip';

export interface ActionSettings {
  /** The master switch: when false nothing happens automatically and normal audio and playback are restored at once. */
  autoEnabled: boolean;
  /** Choices by `ActionCandidate.overrideKey`. A finding without an entry uses `defaultChoice`. */
  choices: Readonly<Record<string, ActionChoice>>;
  /** For findings the user has not decided about. `none` unless the user changed it. */
  defaultChoice: 'none' | 'mute' | 'skip';
}

export const INITIAL_SETTINGS: ActionSettings = { autoEnabled: true, choices: {}, defaultChoice: 'none' };

/** A finding the player will act on. */
export interface PlaybackAction {
  /** Same as the candidate id (`pa-<findingId>`). */
  id: string;
  mediaId: string;
  findingId: string;
  type: ActionType;
  startMs: Ms;
  endMs: Ms;
  /** `enabled`: acts during playback. `disabled`: configured, but the master switch is off. */
  status: 'enabled' | 'disabled';
  category: ActionCandidate['category'];
  findingStatus: ActionCandidate['findingStatus'];
  term: string | null;
  timing: ActionCandidate['timing'];
  warnings: ActionCandidate['warnings'];
  /** Why this action exists, in plain words: which finding, what the user chose, and how the interval was determined. */
  reason: string;
}

export type FindingActionState = 'enabled' | 'off' | 'ignored' | 'none' | 'unavailable';

/** One row of the interface: a candidate, the user's choice and what that means. */
export interface FindingActionView {
  candidate: ActionCandidate;
  choice: ActionChoice;
  /** True when the choice is the default rather than something the user picked for this finding. */
  isDefault: boolean;
  state: FindingActionState;
  action: PlaybackAction | null;
}

export const choiceFor = (c: ActionCandidate, s: ActionSettings): { choice: ActionChoice; isDefault: boolean } => {
  const own = Object.hasOwn(s.choices, c.overrideKey) ? s.choices[c.overrideKey] : undefined;
  return own ? { choice: own, isDefault: false } : { choice: s.defaultChoice, isDefault: true };
};

const range = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;

function reasonOf(c: ActionCandidate, type: ActionType, isDefault: boolean): string {
  const what = type === 'mute' ? 'Mutes' : 'Skips';
  const why = `the flagged term “${c.term ?? 'unknown'}” (${c.findingStatus} finding ${c.findingId})`;
  const how = c.startMs === c.findingStartMs && c.endMs === c.findingEndMs
    ? `the finding’s own interval ${range(c.startMs)} to ${range(c.endMs)}`
    : `${range(c.startMs)} to ${range(c.endMs)}: the finding’s ${range(c.findingStartMs)} to ${range(c.findingEndMs)} plus a margin of ${c.timing.marginBeforeMs} ms before and ${c.timing.marginAfterMs} ms after`;
  return `${what} ${how} for ${why}. ${c.timing.note}${isDefault ? ' Chosen by the default action.' : ' Chosen by you.'}`;
}

/** Resolves candidates and settings into rows. Pure. Unavailable candidates never get an action, whatever the settings say. */
export function resolveViews(candidates: readonly ActionCandidate[], settings: ActionSettings): FindingActionView[] {
  return candidates.map((candidate): FindingActionView => {
    const { choice, isDefault } = choiceFor(candidate, settings);
    if (candidate.availability === 'unavailable') return { candidate, choice, isDefault, state: 'unavailable', action: null };
    if (choice === 'none') return { candidate, choice, isDefault, state: 'none', action: null };
    if (choice === 'ignore') return { candidate, choice, isDefault, state: 'ignored', action: null };
    const action: PlaybackAction = {
      id: candidate.id, mediaId: candidate.mediaId, findingId: candidate.findingId, type: choice, startMs: candidate.startMs, endMs: candidate.endMs,
      status: settings.autoEnabled ? 'enabled' : 'disabled', category: candidate.category, findingStatus: candidate.findingStatus, term: candidate.term,
      timing: candidate.timing, warnings: candidate.warnings, reason: reasonOf(candidate, choice, isDefault),
    };
    return { candidate, choice, isDefault, state: settings.autoEnabled ? 'enabled' : 'off', action };
  });
}

export const actionsOf = (views: readonly FindingActionView[]): PlaybackAction[] => views.flatMap((v) => (v.action ? [v.action] : []));

/** Several overlapping or adjacent actions of one type as a single span, keeping every source. */
export interface ActionSpan {
  /** `<startMs>-<endMs>`. */
  key: string;
  type: ActionType;
  startMs: Ms;
  endMs: Ms;
  actionIds: string[];
  findingIds: string[];
}

/**
 * Merges the ENABLED actions of one type into spans: overlapping and directly adjacent actions become one span (a playhead
 * at a boundary between two merged actions is never "outside" for an instant), and every source finding is kept.
 * Half-open: a span covers [startMs, endMs), the playhead at endMs is outside. Sorted once here, never per playback event.
 */
export function buildSpans(actions: readonly PlaybackAction[], type: ActionType): ActionSpan[] {
  const own = actions.filter((a) => a.type === type && a.status === 'enabled' && a.endMs > a.startMs).sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const spans: ActionSpan[] = [];
  for (const a of own) {
    const last = spans[spans.length - 1];
    if (last && a.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, a.endMs);
      last.actionIds.push(a.id);
      last.findingIds.push(a.findingId);
      last.key = `${last.startMs}-${last.endMs}`;
    } else spans.push({ key: `${a.startMs}-${a.endMs}`, type, startMs: a.startMs, endMs: a.endMs, actionIds: [a.id], findingIds: [a.findingId] });
  }
  return spans;
}

export const spanAt = (spans: readonly ActionSpan[], ms: Ms): ActionSpan | null => {
  // Spans are sorted and disjoint: binary search.
  let lo = 0; let hi = spans.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = spans[mid]!;
    if (ms < s.startMs) hi = mid - 1; else if (ms >= s.endMs) lo = mid + 1; else return s;
  }
  return null;
};

/** Milliseconds from `ms` to the next edge of any span (a start ahead of it, or the end of the span it is inside), or null when none lies ahead. */
export function nextEdgeMs(spans: readonly ActionSpan[], ms: Ms): number | null {
  let lo = 0; let hi = spans.length - 1; let first = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (spans[mid]!.endMs > ms) { first = mid; hi = mid - 1; } else lo = mid + 1; }
  if (first === -1) return null;
  const s = spans[first]!;
  return (ms < s.startMs ? s.startMs : s.endMs) - ms;
}

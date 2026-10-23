/**
 * User preferences SafeWatch can genuinely honour today. Stored in this browser only. Every value is validated on read:
 * anything corrupt, outdated or out of range falls back to its default, field by field.
 *
 * What is NOT here, on purpose: the master switch for automatic actions (it starts on for every video and is not remembered, so
 * a forgotten "off" never silently disables everything), per-finding choices (they belong to one video), and anything for
 * categories that are not supported.
 */
export const LEAD_OPTIONS_SECONDS = [10, 20, 30] as const;
export const DURATION_OPTIONS_SECONDS = [3, 5, 8] as const;
export const DEFAULT_ACTIONS = ['none', 'mute', 'skip'] as const;
export type DefaultAction = (typeof DEFAULT_ACTIONS)[number];

export interface Preferences {
  /** Show a heads-up before a supported finding. */
  warningsEnabled: boolean;
  /** How far ahead of the finding the heads-up appears. The default, 20 s, is the product behaviour; the others are opt-in. */
  leadSeconds: (typeof LEAD_OPTIONS_SECONDS)[number];
  /** How long it stays visible when the user does nothing. */
  durationSeconds: (typeof DURATION_OPTIONS_SECONDS)[number];
  /** For findings the user has not decided about. `none`: nothing is muted or skipped until the user chooses. */
  defaultAction: DefaultAction;
}

export const DEFAULT_PREFERENCES: Preferences = { warningsEnabled: true, leadSeconds: 20, durationSeconds: 3, defaultAction: 'none' };

const oneOf = <T extends string | number>(allowed: readonly T[], v: unknown, fallback: T): T => (allowed as readonly unknown[]).includes(v) ? (v as T) : fallback;

/** Untrusted stored data in, valid preferences out. Never throws. */
export function parsePreferences(raw: unknown): Preferences {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return DEFAULT_PREFERENCES;
  const o = raw as Record<string, unknown>;
  // Own properties only: an inherited value (a hostile prototype) is never read.
  const r = Object.fromEntries(['warningsEnabled', 'leadSeconds', 'durationSeconds', 'defaultAction'].map((k) => [k, Object.hasOwn(o, k) ? o[k] : undefined]));
  return {
    warningsEnabled: typeof r.warningsEnabled === 'boolean' ? r.warningsEnabled : DEFAULT_PREFERENCES.warningsEnabled,
    leadSeconds: oneOf(LEAD_OPTIONS_SECONDS, r.leadSeconds, DEFAULT_PREFERENCES.leadSeconds),
    durationSeconds: oneOf(DURATION_OPTIONS_SECONDS, r.durationSeconds, DEFAULT_PREFERENCES.durationSeconds),
    defaultAction: oneOf(DEFAULT_ACTIONS, r.defaultAction, DEFAULT_PREFERENCES.defaultAction),
  };
}

import type { AudioAsset } from '../extraction/extraction';

/** Common ISO 639-2 (three-letter) tags found in containers → ISO 639-1 (two-letter) used elsewhere. */
const ISO_639_2_TO_1: Record<string, string> = {
  eng: 'en', hin: 'hi', spa: 'es', fra: 'fr', fre: 'fr', deu: 'de', ger: 'de', ita: 'it', por: 'pt', rus: 'ru', jpn: 'ja', kor: 'ko',
  zho: 'zh', chi: 'zh', ara: 'ar', ben: 'bn', tam: 'ta', tel: 'te', mar: 'mr', urd: 'ur', pan: 'pa', guj: 'gu', kan: 'kn', mal: 'ml',
  nld: 'nl', dut: 'nl', pol: 'pl', tur: 'tr', vie: 'vi', tha: 'th', ind: 'id', ukr: 'uk', ces: 'cs', cze: 'cs', ell: 'el', gre: 'el', heb: 'he', swe: 'sv',
};

/** Reduces a language tag to a two-letter primary code where known ("eng" → "en", "pt-BR" → "pt"). Unknown tags return null. */
export function primaryLanguage(tag: string | null): string | null {
  if (!tag) return null;
  const primary = tag.toLowerCase().split('-')[0] ?? '';
  if (primary.length === 2) return primary;
  return ISO_639_2_TO_1[primary] ?? null;
}

export interface TrackSelectionOptions {
  /** Preferred spoken language (two-letter code) or `auto`/null for no preference. */
  preferredLanguage: string | null;
  maxTracks: number;
}

export interface TrackSelection {
  /** Audio track ids to transcribe, in priority order. */
  selected: string[];
  /** Tracks that were not transcribed and why. Nothing is dropped silently. */
  skipped: Array<{ id: string; reason: 'duplicate' | 'not-selected' }>;
}

/**
 * Deterministic audio-track selection for speech-to-text. Candidates are the
 * tracks that actually have a stored file (a bit-identical duplicate points at
 * an earlier track and is skipped). Priority, highest first:
 *   1. language: matches the preferred language, then unknown language, then other languages
 *      (only when a preference exists);
 *   2. the container's `default` track;
 *   3. not a commentary or hearing-impaired (audio description) track;
 *   4. original container order (lowest ordinal), as the final stable tie-break.
 * Up to `maxTracks` are selected; the rest are reported as `not-selected`.
 */
export function selectAudioTracks(audio: readonly AudioAsset[], options: TrackSelectionOptions): TrackSelection {
  const preferred = options.preferredLanguage && options.preferredLanguage !== 'auto' ? options.preferredLanguage.toLowerCase() : null;
  const candidates = audio.filter((a) => a.duplicateOf === null && a.artifact !== null);
  const rank = (a: AudioAsset): [number, number, number, number] => {
    const lang = primaryLanguage(a.language);
    const languageRank = preferred === null ? 0 : lang === preferred ? 0 : lang === null ? 1 : 2;
    return [languageRank, a.disposition.default ? 0 : 1, a.disposition.commentary || a.disposition.hearingImpaired ? 1 : 0, a.ordinal];
  };
  const ordered = [...candidates].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i]! - rb[i]!;
    return 0;
  });
  const selected = ordered.slice(0, options.maxTracks).map((a) => a.id);
  return {
    selected,
    skipped: [
      ...audio.filter((a) => a.duplicateOf !== null).map((a) => ({ id: a.id, reason: 'duplicate' as const })),
      ...ordered.slice(options.maxTracks).map((a) => ({ id: a.id, reason: 'not-selected' as const })),
    ],
  };
}

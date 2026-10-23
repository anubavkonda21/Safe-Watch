import type { Modality } from '../evidence/evidence';

/**
 * Safety taxonomy, version 1. It lists what SafeWatch could one day look for and,
 * for each category, what is REALLY implemented today. Implementation status
 * reflects demonstrated capability, not intent: a category without a working,
 * evaluated classifier is `unsupported` and says why.
 *
 * Positive findings are always grounded in evidence and carry limits; nothing
 * here is a verdict about a video.
 */
export const TAXONOMY_VERSION = 'safewatch-taxonomy-1';

export const CATEGORY_IDS = ['flagged-terms', 'sexual-content', 'violence', 'graphic-injury', 'drug-content'] as const;
export type CategoryId = (typeof CATEGORY_IDS)[number];

/** `implemented`: a working, evaluated classifier. `experimental`: runs but is not evaluated enough to rely on. `unsupported`: no classifier. */
export type SupportStatus = 'implemented' | 'experimental' | 'unsupported';

export interface CategoryDefinition {
  id: CategoryId;
  label: string;
  support: SupportStatus;
  /** Modalities a classifier for this category reads. Empty when unsupported. */
  modalities: readonly Modality[];
  /** What counts as a positive finding. */
  positive: string;
  /** What does NOT count. */
  notPositive: string;
  /** Known limitations and likely false positives or negatives. */
  limitations: string;
  /** Why an unsupported category is unsupported (null when implemented). */
  blocker: string | null;
}

export const TAXONOMY: readonly CategoryDefinition[] = [
  {
    id: 'flagged-terms',
    label: 'Flagged terms',
    support: 'implemented',
    modalities: ['speech', 'subtitle'],
    positive: 'A word or phrase that the user listed occurs in the transcribed speech or in subtitle text, matched by the listed mode (whole word, phrase, contains, exact case) after Unicode normalisation.',
    notPositive: 'A word that merely contains a listed word when a whole-word mode was chosen ("art" in "party"); text that was never transcribed; on-screen text (not scanned yet); the meaning or tone of the sentence.',
    limitations: 'Detects occurrence, not meaning: a listed word in an educational or quoted sentence is still found. SafeWatch ships no built-in profanity list, so "profanity" is covered only for words the user lists. Speech recognition can mishear or miss a word (a miss is not evidence of absence); subtitle text can differ from speech. Hindi was only checked with the larger speech model.',
    blocker: null,
  },
  {
    id: 'sexual-content',
    label: 'Sexual content',
    support: 'unsupported',
    modalities: [],
    positive: 'Visual or audiovisual material that is sexual in nature.',
    notPositive: 'The presence of a person, skin-coloured pixels or a body-related word.',
    limitations: 'Not classified. Visual labels from the image model (people, objects, scene names) are not evidence of this category and are not used as one.',
    blocker: 'No local classifier is available. Apple on-device sensitive-content analysis was tested: it refuses to run for an unsigned command-line helper ("not entitled for client or not enabled"). No suitable model is installed, and adding one (hundreds of MB of weights plus a runtime) or a hosted service is outside this checkpoint and outside the local-only rule.',
  },
  {
    id: 'violence',
    label: 'Violence',
    support: 'unsupported',
    modalities: [],
    positive: 'Depicted or described acts of physical harm against people or animals.',
    notPositive: 'A weapon-shaped object, a sports scene, a loud noise or a violent word taken alone.',
    limitations: 'Not classified. Detecting an object (a knife, a bat) does not show violence, and no temporal action model is available.',
    blocker: 'No local action or scene classifier is available, and no labelled evaluation data could be obtained and committed responsibly. A multi-gigabyte vision-language model would produce free text without calibrated outputs and could not be evaluated here.',
  },
  {
    id: 'graphic-injury',
    label: 'Graphic injury or gore',
    support: 'unsupported',
    modalities: [],
    positive: 'Depicted serious injury, blood or bodily harm shown graphically.',
    notPositive: 'Red colours, medical or cooking scenes, make-up effects.',
    limitations: 'Not classified. Colour (red), medical or cooking scenes and visual labels are not used as evidence of this category.',
    blocker: 'No local classifier is available (see Violence).',
  },
  {
    id: 'drug-content',
    label: 'Drug-related content',
    support: 'unsupported',
    modalities: [],
    positive: 'Depicted or promoted use of illegal drugs.',
    notPositive: 'A drug-related word in an educational, medical or news discussion; pills or bottles on their own.',
    limitations: 'Not classified. Users can list drug-related words under "Flagged terms" and are then told where those words occur in speech and subtitles, which says nothing about whether drugs are depicted or used.',
    blocker: 'No local visual or multimodal classifier is available, and a word list alone cannot separate use from discussion.',
  },
];

export const categoryById = (id: CategoryId): CategoryDefinition => TAXONOMY.find((c) => c.id === id)!;
export const isCategoryId = (v: unknown): v is CategoryId => typeof v === 'string' && (CATEGORY_IDS as readonly string[]).includes(v);

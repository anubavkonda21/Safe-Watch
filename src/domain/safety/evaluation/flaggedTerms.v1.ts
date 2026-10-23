import type { EvalExample, Seg, Word } from './harness';

/**
 * DATASET flagged-terms-eval v1
 *
 * Provenance: written by the SafeWatch authors for this repository. Every sentence is invented text; there is no media, no
 * recording and no third-party data. Licence: same as the repository; it may be used and extended freely.
 * Terms are deliberately mild or neutral placeholders ("darn", "heck", "cat", "pill"): the classifier matches whatever words the
 * user lists, so the behaviour under test is word matching, normalisation, timing and abstention, not any particular vocabulary.
 *
 * `known-limitation` examples are labelled with what a HUMAN would say (intent), where the rule-based matcher is known to be wrong.
 * They stay in the metrics, so the reported recall and precision include these misses and false alarms.
 *
 * What it is: ENGINEERING fixtures that pin the documented behaviour of the classifier and guard against regressions.
 * What it is NOT: a representative benchmark. 43 hand-made examples say nothing about accuracy on real speech or real subtitles,
 * and the speech recognizer's own mistakes are not part of it (transcripts here are given, not recognised).
 *
 * Labels follow the DEFINITION of the category ("a listed term occurs in the text"), not the meaning of the sentence.
 */
export const DATASET_ID = 'flagged-terms-eval';
export const DATASET_VERSION = 1;

const w = (text: string, start: number, end: number, confidence = 0.9): Word => ({ text, start, end, confidence });
const seg = (start: number, end: number, text: string, confidence: number | null = 0.9, words?: Word[]): Seg => ({ start, end, text, confidence, words });
const T = (phrase: string, mode: 'word-boundary' | 'phrase' | 'case-insensitive' | 'exact' = 'word-boundary') => ({ phrase, mode });
const ev = (startMs: number, endMs: number, status: 'detected' | 'uncertain' = 'detected', extra: { warnings?: never[] } = {}) => ({ startMs, endMs, status, ...extra });

export const FLAGGED_TERMS_EXAMPLES: readonly EvalExample[] = [
  // ── positives ──
  { id: 'P01-word-in-speech', kind: 'positive', description: 'A listed word in speech with word timing: the finding spans exactly that word.', terms: [T('darn')],
    speech: [seg(0, 3, 'That was a darn mistake', 0.9, [w('That', 0, 0.4), w('was', 0.4, 0.7), w('a', 0.7, 0.9), w('darn', 0.9, 1.4), w('mistake', 1.4, 2)])],
    expect: { evaluation: 'evaluated', findings: [{ startMs: 900, endMs: 1400, status: 'detected', warnings: [], evidenceModalities: ['speech'] }] } },
  { id: 'P02-word-in-subtitle', kind: 'positive', description: 'A listed word in a subtitle cue: the finding spans the whole cue and says its timing is coarse.', terms: [T('darn')],
    subtitles: [{ start: 5, end: 8, text: 'Oh darn, we missed it.' }],
    expect: { evaluation: 'evaluated', findings: [{ startMs: 5000, endMs: 8000, status: 'detected', warnings: ['coarse-timing'], evidenceModalities: ['subtitle'] }] } },
  { id: 'P03-speech-and-subtitle-agree', kind: 'positive', description: 'The same word in speech and in the subtitle at the same time: ONE finding with both sources as evidence.', terms: [T('darn')],
    speech: [seg(10, 13, 'Well darn it', 0.8, [w('Well', 10, 10.5), w('darn', 10.5, 11), w('it', 11, 11.4)])], subtitles: [{ start: 10, end: 13, text: 'Well, darn it.' }],
    expect: { evaluation: 'evaluated', findings: [{ startMs: 10000, endMs: 13000, status: 'detected', warnings: ['coarse-timing'], evidenceModalities: ['speech', 'subtitle'] }] } },
  { id: 'P04-two-occurrences', kind: 'positive', description: 'Two separate occurrences of one term in one sentence are two findings.', terms: [T('heck')],
    speech: [seg(0, 6, 'What the heck, I said heck', 0.9, [w('What', 0, 0.3), w('the', 0.3, 0.5), w('heck', 0.5, 1), w('I', 3, 3.2), w('said', 3.2, 3.6), w('heck', 3.6, 4.2)])],
    expect: { evaluation: 'evaluated', findings: [ev(500, 1000), ev(3600, 4200)] } },
  { id: 'P05-phrase-spacing', kind: 'positive', description: 'Phrase mode ignores spacing and punctuation between words: "ice-cream" matches "ice cream".', terms: [T('ice cream', 'phrase')],
    subtitles: [{ start: 2, end: 4, text: 'We had ice-cream after dinner.' }],
    expect: { evaluation: 'evaluated', findings: [{ startMs: 2000, endMs: 4000, status: 'detected', warnings: ['coarse-timing'] }] } },
  { id: 'P06-contains-inside-word', kind: 'positive', description: 'Contains mode matches inside a longer word, as chosen by the user ("cat" in "category").', terms: [T('cat', 'case-insensitive')],
    subtitles: [{ start: 1, end: 2, text: 'This is a different category.' }], note: 'By design: the user chose substring matching.',
    expect: { evaluation: 'evaluated', findings: [{ startMs: 1000, endMs: 2000, status: 'detected', warnings: ['coarse-timing'] }] } },
  { id: 'P07-exact-case', kind: 'positive', description: 'Exact-case mode matches the same capitalisation.', terms: [T('NASA', 'exact')], subtitles: [{ start: 0, end: 2, text: 'NASA launched it.' }],
    expect: { evaluation: 'evaluated', findings: [{ startMs: 0, endMs: 2000, status: 'detected', warnings: ['coarse-timing'] }] } },
  { id: 'P08-two-terms', kind: 'positive', description: 'Two different listed terms in one cue are two findings (one per term).', terms: [T('darn'), T('heck')], subtitles: [{ start: 3, end: 5, text: 'Darn it, what the heck.' }],
    expect: { evaluation: 'evaluated', findings: [{ startMs: 3000, endMs: 5000, status: 'detected', warnings: ['coarse-timing'] }, { startMs: 3000, endMs: 5000, status: 'detected', warnings: ['coarse-timing'] }] } },
  { id: 'P09-quoted-or-educational-use', kind: 'positive', description: 'A listed word used in an educational sentence is still found: the classifier detects occurrence, not meaning.', terms: [T('pill')],
    speech: [seg(0, 4, 'The pharmacist explained the pill schedule', 0.92, [w('The', 0, 0.2), w('pharmacist', 0.2, 0.9), w('explained', 0.9, 1.4), w('the', 1.4, 1.6), w('pill', 1.6, 2), w('schedule', 2, 2.6)])],
    note: 'Documented limitation: a flagged-term finding is not a statement about drug use.', expect: { evaluation: 'evaluated', findings: [ev(1600, 2000)] } },

  // ── negatives and benign lookalikes ──
  { id: 'N01-substring-lookalike', kind: 'lookalike', description: 'Whole-word mode does not match inside another word: "art" in "party".', terms: [T('art')], subtitles: [{ start: 0, end: 2, text: 'We went to a party.' }], expect: { evaluation: 'evaluated', findings: [] } },
  { id: 'N02-category-lookalike', kind: 'lookalike', description: 'Whole-word "cat" does not match "category".', terms: [T('cat')], subtitles: [{ start: 0, end: 2, text: 'Another category entirely.' }], expect: { evaluation: 'evaluated', findings: [] } },
  { id: 'N03-suffix-lookalike', kind: 'lookalike', description: '"darn" does not match "darnit" or "darning".', terms: [T('darn')], speech: [seg(0, 3, 'She was darning socks', 0.9, [w('She', 0, 0.3), w('was', 0.3, 0.6), w('darning', 0.6, 1.2), w('socks', 1.2, 1.8)])], expect: { evaluation: 'evaluated', findings: [] } },
  { id: 'N04-clean-text', kind: 'negative', description: 'Ordinary text with no listed term: a negative result within the evaluated scope.', terms: [T('darn')], speech: [seg(0, 3, 'The weather is lovely today')], subtitles: [{ start: 0, end: 3, text: 'The weather is lovely today.' }], expect: { evaluation: 'evaluated', findings: [] } },
  { id: 'N05-no-text-at-all', kind: 'negative', description: 'Both text inputs worked and found nothing (silence, no subtitles): evaluated, nothing found.', terms: [T('darn')], expect: { evaluation: 'evaluated', findings: [] } },
  { id: 'N06-exact-case-mismatch', kind: 'lookalike', description: 'Exact-case mode does not match different capitalisation.', terms: [T('NASA', 'exact')], subtitles: [{ start: 0, end: 2, text: 'nasa launched it.' }], expect: { evaluation: 'evaluated', findings: [] } },
  { id: 'N07-phrase-split-by-other-words', kind: 'lookalike', description: 'A phrase does not match when other words sit between its words.', terms: [T('ice cream', 'phrase')], subtitles: [{ start: 0, end: 2, text: 'Ice is cold and cream is smooth.' }], expect: { evaluation: 'evaluated', findings: [] } },

  // ── text normalisation ──
  { id: 'NO01-curly-apostrophe', kind: 'normalization', description: 'A typographic apostrophe equals a straight one.', terms: [T("don't")], subtitles: [{ start: 0, end: 2, text: 'Please don’t go.' }], expect: { evaluation: 'evaluated', findings: [{ startMs: 0, endMs: 2000, status: 'detected', warnings: ['coarse-timing'] }] } },
  { id: 'NO02-zero-width-inside-word', kind: 'normalization', description: 'A zero-width character hidden inside a word is removed before matching.', terms: [T('darn')], subtitles: [{ start: 0, end: 2, text: 'Oh da​rn it.' }], note: 'By design: invisible characters must not hide a listed word.', expect: { evaluation: 'evaluated', findings: [{ startMs: 0, endMs: 2000, status: 'detected', warnings: ['coarse-timing'] }] } },
  { id: 'NO03-fullwidth-letters', kind: 'normalization', description: 'Fullwidth letters are folded to ASCII (NFKC).', terms: [T('darn')], subtitles: [{ start: 0, end: 2, text: 'Oh ｄａｒｎ it.' }], expect: { evaluation: 'evaluated', findings: [{ startMs: 0, endMs: 2000, status: 'detected', warnings: ['coarse-timing'] }] } },
  { id: 'NO04-uppercase', kind: 'normalization', description: 'Whole-word matching ignores case.', terms: [T('darn')], subtitles: [{ start: 0, end: 2, text: 'DARN IT ALL' }], expect: { evaluation: 'evaluated', findings: [{ startMs: 0, endMs: 2000, status: 'detected', warnings: ['coarse-timing'] }] } },
  { id: 'NO05-devanagari', kind: 'normalization', description: 'A Devanagari word is matched as a whole word (scripts other than Latin are preserved).', terms: [T('बकवास')], subtitles: [{ start: 0, end: 2, text: 'यह सब बकवास है' }], expect: { evaluation: 'evaluated', findings: [{ startMs: 0, endMs: 2000, status: 'detected', warnings: ['coarse-timing'] }] } },
  { id: 'NO06-adjacent-punctuation', kind: 'normalization', description: 'Punctuation around the word does not prevent a match.', terms: [T('darn')], subtitles: [{ start: 0, end: 2, text: '"Darn!" she said.' }], expect: { evaluation: 'evaluated', findings: [{ startMs: 0, endMs: 2000, status: 'detected', warnings: ['coarse-timing'] }] } },
  { id: 'NO07-diacritics-are-kept', kind: 'normalization', description: 'Diacritics are not stripped: "résumé" is not "resume".', terms: [T('resume')], subtitles: [{ start: 0, end: 2, text: 'Send your résumé.' }], expect: { evaluation: 'evaluated', findings: [] } },

  // ── timestamp boundaries ──
  { id: 'B01-at-media-start', kind: 'boundary', description: 'A word at t=0 gives a finding starting at 0 ms.', terms: [T('darn')], speech: [seg(0, 2, 'darn it', 0.9, [w('darn', 0, 0.5), w('it', 0.5, 0.8)])], expect: { evaluation: 'evaluated', findings: [ev(0, 500)] } },
  { id: 'B02-touching-intervals-merge', kind: 'boundary', description: 'A speech word ending exactly when a subtitle cue (with the same term) starts: the intervals touch, so they are ONE finding.', terms: [T('darn')],
    speech: [seg(1, 2, 'darn', 0.9, [w('darn', 1, 1.4)])], subtitles: [{ start: 1.4, end: 3, text: 'darn' }], expect: { evaluation: 'evaluated', findings: [{ startMs: 1000, endMs: 3000, status: 'detected', evidenceModalities: ['speech', 'subtitle'] }] } },
  { id: 'B03-one-millisecond-apart', kind: 'boundary', description: 'Two occurrences 1 ms apart do not overlap: two findings.', terms: [T('darn')],
    speech: [seg(1, 2, 'darn darn', 0.9, [w('darn', 1, 1.4), w('darn', 1.401, 1.8)])], expect: { evaluation: 'evaluated', findings: [ev(1000, 1400), ev(1401, 1800)] } },
  { id: 'B04-confidence-exactly-at-threshold', kind: 'boundary', description: 'Speech confidence exactly 0.5 is not below the policy threshold: detected.', terms: [T('darn')],
    speech: [seg(0, 2, 'darn', 0.5, [w('darn', 0, 0.5, 0.5)])], expect: { evaluation: 'evaluated', findings: [ev(0, 500, 'detected')] } },

  // ── ambiguous and contradictory evidence ──
  { id: 'A01-low-recognizer-confidence', kind: 'ambiguous', description: 'Only speech supports it and the recognizer was unsure: uncertain, with the reason.', terms: [T('darn')],
    speech: [seg(0, 2, 'darn', 0.3, [w('darn', 0, 0.5, 0.3)])], expect: { evaluation: 'evaluated', findings: [{ startMs: 0, endMs: 500, status: 'uncertain', warnings: ['low-source-confidence'] }] } },
  { id: 'A02-speech-contradicted-by-subtitle', kind: 'contradictory', description: 'Speech contains the term, but the subtitle shown at the same time does not: uncertain.', terms: [T('darn')],
    speech: [seg(0, 3, 'oh darn', 0.9, [w('oh', 0, 0.4), w('darn', 0.4, 1)])], subtitles: [{ start: 0, end: 3, text: 'Oh, gosh.' }],
    expect: { evaluation: 'evaluated', findings: [{ startMs: 400, endMs: 1000, status: 'uncertain', warnings: ['subtitle-disagrees'] }] } },
  { id: 'A03-subtitle-not-confirmed-by-speech', kind: 'contradictory', description: 'The subtitle has the term but the recognized speech at that time does not: detected (the subtitle is written text), with a warning.', terms: [T('darn')],
    speech: [seg(0, 3, 'oh gosh', 0.9)], subtitles: [{ start: 0, end: 3, text: 'Oh darn.' }], expect: { evaluation: 'evaluated', findings: [{ startMs: 0, endMs: 3000, status: 'detected', warnings: ['coarse-timing', 'speech-did-not-confirm'] }] } },
  { id: 'A04-low-confidence-but-subtitle-agrees', kind: 'ambiguous', description: 'Low recognizer confidence, but the subtitle contains the term as well: agreement makes it detected.', terms: [T('darn')],
    speech: [seg(0, 2, 'darn', 0.2, [w('darn', 0, 0.5, 0.2)])], subtitles: [{ start: 0, end: 2, text: 'Darn.' }], expect: { evaluation: 'evaluated', findings: [{ startMs: 0, endMs: 2000, status: 'detected', evidenceModalities: ['speech', 'subtitle'] }] } },

  // ── missing or failed input, abstention ──
  { id: 'M01-speech-not-enabled', kind: 'missing-input', description: 'Speech recognition is off: subtitles are still scanned, the result is partial and says speech is missing.', terms: [T('darn')],
    subtitles: [{ start: 0, end: 2, text: 'Oh darn.' }], inputs: { speech: 'not-enabled' }, expect: { evaluation: 'partial', reason: 'speech-unavailable', findings: [{ startMs: 0, endMs: 2000, status: 'detected', warnings: ['coarse-timing'] }] } },
  { id: 'M02-subtitles-failed-nothing-found', kind: 'missing-input', description: 'Subtitles failed and speech has no listed term: partial, so "none found" is limited to speech.', terms: [T('darn')],
    speech: [seg(0, 2, 'all good')], inputs: { subtitles: 'failed' }, expect: { evaluation: 'partial', reason: 'subtitles-unavailable', findings: [] } },
  { id: 'M03-all-text-unavailable', kind: 'missing-input', description: 'Speech and subtitles both failed: the classifier abstains and makes no negative claim.', terms: [T('darn')],
    inputs: { speech: 'failed', subtitles: 'failed' }, expect: { evaluation: 'abstained', reason: 'text-unavailable', findings: [] } },
  { id: 'M04-no-terms', kind: 'missing-input', description: 'No terms listed: nothing to look for, so it abstains.', terms: [], subtitles: [{ start: 0, end: 2, text: 'anything at all' }], expect: { evaluation: 'abstained', reason: 'no-terms-configured', findings: [] } },
  { id: 'M05-only-disabled-terms', kind: 'missing-input', description: 'Every listed term is disabled: same as no terms.', terms: [{ phrase: 'darn', mode: 'word-boundary', enabled: false }], subtitles: [{ start: 0, end: 2, text: 'Oh darn.' }], expect: { evaluation: 'abstained', reason: 'no-terms-configured', findings: [] } },
  { id: 'M06-speech-failed-subtitle-hit', kind: 'missing-input', description: 'Speech failed, the subtitle has the term: a real finding from the available evidence, flagged partial.', terms: [T('darn')],
    subtitles: [{ start: 4, end: 6, text: 'Darn.' }], inputs: { speech: 'failed' }, expect: { evaluation: 'partial', reason: 'speech-unavailable', findings: [{ startMs: 4000, endMs: 6000, status: 'detected', warnings: ['coarse-timing'] }] } },

  // ── known limitations: labelled by human intent; the matcher cannot do these, and says so in the metrics ──
  { id: 'L01-spaced-out-letters', kind: 'known-limitation', knownLimitation: true, description: 'A word written with spaces between its letters ("d a r n") reads as the word to a person; the matcher sees four single letters.', terms: [T('darn')],
    subtitles: [{ start: 0, end: 2, text: 'Oh d a r n it.' }], expect: { evaluation: 'evaluated', findings: [{ startMs: 0, endMs: 2000, status: 'detected' }] } },
  { id: 'L02-character-substitution', kind: 'known-limitation', knownLimitation: true, description: 'Digits standing in for letters ("d4rn"): no leetspeak folding is done.', terms: [T('darn')],
    subtitles: [{ start: 0, end: 2, text: 'Oh d4rn it.' }], expect: { evaluation: 'evaluated', findings: [{ startMs: 0, endMs: 2000, status: 'detected' }] } },
  { id: 'L03-inflected-form', kind: 'known-limitation', knownLimitation: true, description: 'An inflected form ("darned") is a different word to the matcher: no stemming. A user must list the forms they want.', terms: [T('darn')],
    subtitles: [{ start: 0, end: 2, text: 'That darned dog again.' }], expect: { evaluation: 'evaluated', findings: [{ startMs: 0, endMs: 2000, status: 'detected' }] } },
  { id: 'L04-word-split-across-cues', kind: 'known-limitation', knownLimitation: true, description: 'A word broken across two subtitle cues ("da-" / "rn"): each cue is matched on its own.', terms: [T('darn')],
    subtitles: [{ start: 0, end: 1, text: 'Oh da-' }, { start: 1, end: 2, text: 'rn it.' }], expect: { evaluation: 'evaluated', findings: [{ startMs: 0, endMs: 2000, status: 'detected' }] } },
  { id: 'L05-same-spelling-different-meaning', kind: 'known-limitation', knownLimitation: true, description: 'A listed word used in an unrelated sense (a "pill bug" is an insect): spelling is matched, meaning is not understood.', terms: [T('pill')],
    speech: [seg(0, 3, 'The pill bug rolled into a ball', 0.9, [w('The', 0, 0.2), w('pill', 0.2, 0.6), w('bug', 0.6, 1), w('rolled', 1, 1.4)])], expect: { evaluation: 'evaluated', findings: [] } },
  { id: 'L06-misheard-by-recognizer', kind: 'known-limitation', knownLimitation: true, description: 'The speaker said the term but the recognizer wrote a different word: the transcript is the evidence, so the term is missed (a miss is not evidence of absence).', terms: [T('darn')],
    speech: [seg(0, 2, 'oh dawn it', 0.9, [w('oh', 0, 0.3), w('dawn', 0.3, 0.8), w('it', 0.8, 1)])], expect: { evaluation: 'evaluated', findings: [{ startMs: 300, endMs: 800, status: 'detected' }] } },
];

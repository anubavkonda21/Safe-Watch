# CHECKPOINT 7 REPORT: Safety Classification Foundation

**One category is genuinely implemented: flagged terms in speech and subtitles (rule based). Sexual content, violence, graphic injury and drug-related content are NOT supported. There is NO overall safety score, NO verdict, and nothing is muted, censored, blurred, skipped or warned about.**

## 1. What was built

- `src/domain/safety`: taxonomy `safewatch-taxonomy-1`, the `SafetyFinding`/`CategoryReport`/`SafetyAnalysis` contract with validators, the `SafetyClassifier` port, `FlaggedTermClassifier`, `analyzeSafety` (orchestration, abstention, failure isolation), and the evaluation harness with the versioned dataset.
- Server: `MediaService.getSafetyFindings`, `POST|GET /api/media/:id/safety-findings`, strict request parser, `INVALID_REQUEST` (400).
- Frontend: "Safety classification (foundation)" section: real support status of every category, per-category result text, findings timeline, selectable findings with evidence and explanation.
- Tooling: `npm run eval:safety`, `npm run check:safety`.

## 2. Decisions

- **Reuse, not duplication.** The classifier reuses the CP4 matcher (`findTextMatches`) and the CP6 context; `EvidenceItem`, `ContextEvent` and the per-modality confidence summaries are untouched and not reinterpreted. No second evidence model.
- **Narrow, honest scope.** Only the category that can be genuinely implemented and evaluated is implemented.
- **Four things kept apart:** raw score (null), calibrated probability (null: never measured), policy threshold (0.5 on recognizer confidence, documented), verdict (none).
- **Abstention is first class:** no terms, no text input, a failed classifier, a missing modality: each is reported as such, never as an empty clean result.

## 3. Blocker for the other four categories (measured)

A Swift helper using Apple `SensitiveContentAnalysis` compiled but the analysis failed with "User Safety either not entitled for client or not enabled" (needs a signed app with a restricted entitlement and a system setting). No suitable local model is installed; a model would mean hundreds of MB to GB of weights plus a runtime or a free-text vision-language model without calibrated outputs; a hosted service is excluded; no labelled evaluation data can be committed responsibly. CP5 labels, person boxes and OCR were not used as stand-ins. The categories are listed with their definitions and blockers and are `not-supported` in every response.

## 4. Classifier and licensing

`flagged-terms-matcher` v1, rule based, written for this repository (same licence as the repository). It uses no model, weights or third-party data, so there is nothing to license beyond the repository. The dataset is original text (mild placeholder terms), no media.

## 5. Evaluation (`npm run eval:safety`, dataset `flagged-terms-eval` v1)

43 synthetic engineering examples: 9 positives, 5 benign lookalikes, 2 negatives, 7 normalisation, 4 boundary, 2 ambiguous, 2 contradictory, 6 missing-input, 6 known limitations.

| | |
| --- | --- |
| Behaved as labelled | 37 |
| Known limitations (kept in the metrics) | 6 |
| Unexpected failures | 0 |
| True positives / false positives / false negatives / true negatives | 28 / 1 / 5 / 9 |
| Precision / recall | 0.966 / 0.848 |
| Abstained examples | 3 of 43 (7%) |
| Uncertain findings | 2 of 29 (7%) |
| Mean interval overlap / max boundary error | 1.0 / 0 ms (where word timing exists) |

Per-example outcomes are printed by the command and pinned by tests. The six known limitations are labelled by human intent and are real misses or false alarms: spaced-out letters, character substitution, an inflected form, a word split across cues, the same spelling with a different meaning, and a word the recognizer misheard. **These are engineering fixtures, not a benchmark: they say nothing about accuracy on real speech or subtitles.** The 37 clean results are expected for hand-labelled cases against a deterministic matcher; the dataset was extended with the known limitations specifically so the metrics are not a perfect score.

## 6. Tests

942 passing, 0 skipped (848 before this checkpoint, +94): taxonomy, contract validation, classifier behaviour and orchestration (determinism, shuffled evidence, no mutation, truncation warning, failing and invalid and async classifiers, forged reports), the evaluation harness (pinned metrics), the API (real upload through the real pipeline, partial and pending states, 18 invalid-body cases, id and method abuse, no path or content in responses or logs), the uploader, the panel and the dropzone flow. The real Apple Vision inference tests still run. No test was removed or weakened. One existing test was made race-free: `server/test/e2e.test.ts` "fails truncated media cleanly" failed once in an early full run because the media record turns `failed` before its file is deleted (the delete is awaited immediately after), so the test now waits for the removal with `eventually` instead of racing it; the assertion is unchanged. It had passed alone, in six runs on the base commit and in three further full runs; the race is in the test, not in this checkpoint's code. Lint, typecheck, client and server builds pass.

## 7. Performance (`npm run check:safety`, synthetic)

| Text evidence | 3 terms | 100 terms |
| --- | --- | --- |
| 20 events (1 min) | 0.1 ms | 1.6 ms |
| 600 events (30 min) | 1.9 ms | 77 ms |
| 3 600 events (3 h) | 13 ms | 78 ms |

Heap 10 to 130 MB. 100 common-word terms hit the 10 000-match cap (warning reported), and the response can reach 3.4 MB: bounded but not rate limited.

## 8. Frontend QA

Real app (vision helper and whisper.cpp), a 36 s video, flagged terms added through the real Custom filters UI: abstention with no terms, then findings (an uncertain one where subtitles disagree with speech, a detected one where nothing contradicts it). No horizontal overflow at 320, 375, 768, 1024, 1280 or 1440 px; console clean. Screenshots: `docs/screenshots/checkpoint-7-*.jpg` (categories at 1440, a finding with evidence at 1440, findings at 320). Not captured: separate screenshots at 375, 768, 1024 and 1280 (checked for overflow only).

## 9. Security and privacy

The endpoint reads no files and runs no subprocess or model; the body is strict (exact shape, 100 terms, 32 KB, JSON only), ids are validated, responses carry no paths or internal errors, evidence and terms are rendered as text and never logged. **Privacy change:** the user's enabled flagged terms are now sent to the SafeWatch server for this request (before, filters never left the browser); they are not stored or logged, and nothing goes to a third party. **Still NOT solved (production gates): authentication (media ids are bearer tokens), rate limiting, disk quota, FFmpeg and helper sandboxing.**

## 10. Known limitations

- Occurrence, not meaning: an educational or quoted use, or the same spelling in another sense, is still found.
- No stemming, leetspeak folding, spaced letters or split-word handling; a recognizer mishearing is a miss, and a miss is not evidence of absence.
- On-screen (OCR) text is not scanned; no built-in profanity list; Hindi quality depends on the larger speech model.
- Four of five categories are unsupported; the uncertainty thresholds are policy choices, not calibrated.
- The evaluation set is small, synthetic and labelled by the same authors.

## 11. Explicitly NOT implemented

Sexual-content, violence, graphic-injury and drug-content classification; any model, weights or hosted service; a combined safety score; a safe/unsafe verdict; warnings and the pre-warning behaviour; muting, blurring, scene skipping, censorship; user policies or presets; persistence; authentication; rate limiting. No Checkpoint 8 work was started.

## 12. Git

One commit `feat: add safety classification foundation`, normal push to `origin/main`, verified with `git rev-parse HEAD`, `git rev-parse origin/main`, `git ls-remote origin refs/heads/main`, `git status -sb`.

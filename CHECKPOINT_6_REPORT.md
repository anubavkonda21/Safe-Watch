# CHECKPOINT 6 REPORT: Cross-Modal Context and Temporal Reasoning Foundation

**THIS CHECKPOINT DOES NOT CLASSIFY SAFETY. NO SAFETY SCORE. NO SAFETY VERDICT. NO CENSORSHIP. NO MUTING. NO BLURRING. NO SCENE SKIPPING.**

It groups the evidence that already exists (speech, subtitles, visual observations) by media time and explains why. It says nothing about whether any content is acceptable, and it contains no LLM, no model and no external service.

## 1. What was built

- `src/domain/context`: integer-millisecond media time, `ContextConfig` and `ContextEvent`, `correlateEvidence` (the algorithm), `buildContextAnalysis` (status, inputs, warnings, graceful degradation), `validateContextAnalysis`.
- Server: `MediaService.getContext`, `GET /api/media/:id/context`, `SAFEWATCH_CONTEXT_*` config. Computed on request from the record (pure, nothing stored, no file access).
- Frontend: "Contextual evidence" section: proportional context timeline (overlapping events on separate rows), chronological context cards, selectable evidence drill-down that shows every piece of evidence by source and why it joined; `Context:` badge; loads after text and visual analysis have both finished.
- Tooling: `npm run check:context` (performance baseline).

## 2. Architecture and decisions

The CP5 `EvidenceItem` is the single evidence shape (not duplicated). Provenance is kept per member. Confidence is per modality (count, reported, min, max): no combined number. Correlation is a single forward pass over time-sorted evidence; see `SAFEWATCH_MEDIA_ARCHITECTURE.md` §28 for the full algorithm, defaults and reasons. In short: related when the later item starts within 1.5 s (0.5 + 1.0) of the earlier one ending; a context never exceeds 20 s; evidence longer than that (a 30 s subtitle) keeps its own event and is listed as "also during this time" in the events it overlaps; sampled frames reach nearby text through coverage (half the sampling step, at most 5 s) but never chain to each other and never bridge two sentences.

**Decision: no LLM.** The first version had to establish temporal correctness, provenance, reproducibility and testability. Nothing in this checkpoint needed a probabilistic model, so none was introduced.

## 3. Behaviour on the required fixtures

A (speech, subtitle, two visual observations in 1 s): one multi-source context. B (evidence at 10 s and 30 s): two contexts. C speech only, D visual only, E subtitle + visual: one single- or two-source context each. F (30 s subtitle with visuals at 12, 25, 38 s): the subtitle is extended evidence with its own event, referenced as ambient from three separate visual events; with `maxContextMs` raised to 60 s the same input becomes one event. G (shuffled input, five seeds plus reversed): identical output. H (duplicates by id and by content): dropped, counted, deterministic.

## 4. Performance (`npm run check:context`, this machine)

| Size | Evidence items | Events | Median time | Per item |
| --- | --- | --- | --- | --- |
| small (1 min) | 180 | 4 | 0.24 ms | 1.4 µs |
| medium (30 min) | 5 400 | 100 | 5.5 ms | 1.0 µs |
| large (6 h) | 64 800 | 1 200 | 84 ms | 1.3 µs |
| very large (24 h) | 259 200 | 4 800 | 362 ms | 1.4 µs |

Sort-then-single-pass: O(n log n), no pairwise comparison; the ambient attachment is O(events x extended items), and extended items are rare. The full payload for a 6 h synthetic video is about 12.8 MB, so `?evidence=false` exists for polling; real inputs are much smaller (at most 300 frames and 1 h of speech by default). Synthetic data, one machine.

## 5. Tests

848 passing (734 before this checkpoint): time, config and algorithm (overlap, adjacency, gap boundary at exactly 1.5 s, point observations, long text, frame coverage and no bridging, max-duration cut, duplicates, malformed input of eleven kinds, shuffles, provenance, per-modality confidence, no safety vocabulary in the model), analysis (every degradation: visual failed or not enabled, speech not enabled or not selected, text failed, all failed, empty, pending, malformed upstream), API (a real upload through the real pipeline, determinism, configuration, `evidence=false`, partial results, pending, id and path abuse, method restrictions, no path leaks), layout, reducer, uploader polling, panel (loading, empty, partial, ready, selection, drill-down, hostile text, vocabulary) and the dropzone flow. Lint, typecheck and both builds pass.

## 6. Frontend QA

Real app with the vision helper and whisper.cpp, a 36 s slideshow with speech and subtitles. Checked at 320, 375, 768, 1024, 1280 and 1440 px: no horizontal overflow at any width, timeline and cards readable, drill-down usable, console clean. Timeline segments have an enlarged touch target; the context cards are the primary control on phones. Screenshots: `docs/screenshots/checkpoint-6-*.jpg` (desktop timeline, selected context with evidence, mobile 320).

## 7. Security and privacy

Everything is local; nothing is uploaded and no key exists. The endpoint reads no files and accepts no path or evidence from the client; ids are validated like every media route; only GET is served; responses carry no paths; evidence text is rendered as text and never logged. **Still NOT solved (production gates): authentication (media ids are bearer tokens), rate limiting, disk quota, FFmpeg and helper sandboxing.**

## 8. Known limitations

- Grouping is purely temporal: two unrelated things that happen at the same time are grouped; one event spread over a long pause is split.
- Continuous text (back-to-back subtitle cues) or very dense frame sampling chains into one long context, cut at 20 s; the sampling step matters.
- A frame is a snapshot: what happens between sampled frames is unknown, and coverage is an assumption (half the step), not a measurement.
- Speech word times have approximate ends; contexts use segment times.
- Not persisted; recomputed on request. Defaults are reasoned, not tuned on real data.

## 9. Explicitly NOT implemented

Safety classification, safety score, verdicts, violence, sexual, drug or graphic-content detection, warnings, censorship, muting, blurring, scene skipping, any LLM or hosted model, learned scene segmentation, changes to Custom Filters.

## 10. Git

One commit `feat: add cross-modal context reasoning`, normal push to `origin/main`, verified with `git rev-parse HEAD`, `git rev-parse origin/main`, `git ls-remote origin refs/heads/main`, `git status -sb` (reported in the final message; a commit cannot contain its own hash).

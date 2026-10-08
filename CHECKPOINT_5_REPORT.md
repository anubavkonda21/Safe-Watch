# CHECKPOINT 5 REPORT: Visual Intelligence Foundation

**NO SAFETY CLASSIFICATION. NO SAFETY SCORE. NO CENSORSHIP. NO MUTING. NO SCENE SKIPPING. NO FINAL SAFETY VERDICT.**

This checkpoint adds visual **evidence**: what a local image model reports about each sampled frame, with media timestamps. It does not judge whether anything is safe, does not detect violence, sexual content or drugs, and changes nothing in the media. The existing Custom Filters are unchanged.

## 1. What was built

- Domain (`src/domain/vision`, `src/domain/evidence`): `VisualObservation`, `normalizeObservation`, deterministic ordering, `VisualAnalysis` lifecycle and validator, unified evidence projection.
- Port and adapter: `VisualAnalysisProvider` and `AppleVisionProvider` (Swift helper `native/apple-vision`, built to git-ignored `bin/`).
- Service: `VisualAnalysisService` (own bounded queue, batches, timeouts, cancellation, per-frame isolation, limits).
- API: `GET /api/media/:id/visual`, `GET /api/media/:id/frames/:frameId`, `vision` in `/api/health`.
- Frontend: "Visual evidence" section (progress with real frame counts, frame grid, preview dialog with optional boxes), `Visual:` badge, runs side by side with text analysis.
- Tooling: `scripts/build-vision-helper.sh`, `scripts/download-vision-assets.sh` (pinned SHA-256), `npm run check:vision`, vitest `globalSetup`.

## 2. Provider decision

Apple Vision through a 169 KB Swift helper. Alternatives measured or evaluated (ONNX Runtime 145 to 301 MB before weights, llama.cpp VLM with free text only, CLIP about 350 MB, YOLO AGPL, hosted APIs rejected for privacy) are in `SAFEWATCH_MEDIA_ARCHITECTURE.md` §27.1. **Trade-off:** macOS only and a closed Apple model; the port keeps it replaceable and a Linux/ONNX adapter is future work. No face detection or recognition is used.

## 3. Real inference

The real tests (`server/test/visionReal.test.ts`) run Apple Vision on seven COCO val2017 photographs (CC BY 2.0, downloaded over HTTP, verified by pinned SHA-256, git-ignored), a rendered text frame, a black frame and a corrupt JPEG, and a full pipeline test: a 12 s slideshow of four photos is uploaded, extracted by FFmpeg, analysed by the real helper and read back through the API; each photo's labels appear at the right timestamps (living room, street sign with OCR "STOP", skiing with a located person, bookshelf). `globalSetup` builds the helper and fetches the assets so these always execute on macOS; a missing helper fails the run. On non-macOS they are skipped explicitly. **Seven photos prove the pipeline works; they say nothing about accuracy.**

## 4. Performance baseline (this Apple Silicon Mac, warm, `npm run check:vision`)

| Video | Frames | Provider time | Per frame | End to end (incl. upload and FFmpeg) | Helper RSS peak | Node RSS peak | Observations | API payload |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 3 min slideshow, 640×480, step 3 s | 60 | 2.2 s | 37 ms | 4.6 s | 68 MB | 101 MB | 450 | 122 KB (12 KB slim) |
| 10 min slideshow, 640×480, step 2 s (cap) | 300 | 10.7 s | 36 ms | 21.2 s | 72 MB | 94 MB | 2250 | 604 KB (58 KB slim) |

Cold start: the first-ever run after boot took about 26 s (Apple compiles its models once); the default batch timeout (120 s) covers it. Caveats: six photos repeated, frames already downscaled to at most 768 px, no concurrent load, one machine. Not "real-time" and not a general benchmark.

## 5. Tests

734 passing (598 before this checkpoint): domain (observation, lifecycle, evidence), provider parsing of real helper output, fake-binary failure modes (exit codes, crashes, malformed or oversized output, hung process killed on timeout and on cancel, no leakage), service (ordering, batching, progress, failure isolation, frame-missing, over-limit, resource-limit, observation caps, timeout, cancel on delete, queue-full, expiry, hostile labels), API (frame serving, path-like ids, slim form, health), real inference, config, reducer, uploader polling, panel, dropzone flow. Lint, typecheck, client and server builds pass.

## 6. Frontend QA

Checked at 320, 375, 768, 1024, 1280 and 1440 px: no horizontal overflow at any width, 2 columns on phones and up to 4 on desktop, dialog and boxes work, console clean. Screenshots: `docs/screenshots/checkpoint-5-*.jpg` (desktop grid, preview with boxes, 320 mobile, 768 tablet). The test photo of the stop sign is upside down in the dataset; the text recognition still read it.

## 7. Security and privacy

Frames are untrusted media: JPEG/PNG only, size cap before decode, corrupt files fail alone, argv-only execution with `--` before server-generated paths, minimal environment, capped output, killed on timeout or cancel, labels and OCR rendered as text and never logged, frame route only for manifest ids with `nosniff`. Everything is local; no model weights, user media, frames or keys are committed. **Still NOT solved (production gates): FFmpeg and helper sandboxing, authentication (ids are bearer tokens, frames are readable by id), rate limiting, disk quota.**

## 8. Known limitations

macOS only; closed Apple model with its own vocabulary; labels can be wrong (black frame labelled night sky), people can be missed, OCR can crop edge characters; frames are sampled every N seconds, so anything between samples is not seen; frames are capped at 768 px; no temporal reasoning or scene understanding; no persistence (in-memory, 60 min retention); cold start about 26 s.

## 9. Explicitly NOT implemented

Safety classification, safety score, verdicts, violence/sexual/drug detection, censorship, muting, blurring, scene skipping, contextual AI, face detection or recognition, a Linux adapter, persistence, authentication, rate limiting, sandboxing, any change to Custom Filters.

## 10. Git

Single commit `feat: add visual intelligence foundation`, normal push to `origin/main`, verified with `git rev-parse HEAD`, `git rev-parse origin/main`, `git ls-remote origin refs/heads/main`, `git status`, `git log -1` (reported in the final message; a commit cannot contain its own hash).

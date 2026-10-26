# SafeWatch

> Understand your media. Control your experience.

SafeWatch is intended to become a premium AI-powered media-safety platform: it understands what is happening inside a video and gives users control over what they are willing to see and hear.

## Current status

**Checkpoint 10 — security hardening (single-user, macOS, loopback only).** The API now has per-browser sessions with media ownership checks, Host/Origin protections, rate limits, a disk quota, a macOS sandbox for FFmpeg, FFprobe, whisper.cpp and the Vision helper, process-group termination and a clean shutdown. **This is not a general production-ready release**: there is no sandbox on Linux or Windows, no TLS, no real user accounts, no encryption at rest, no CSP,  See `CHECKPOINT_10_REPORT.md` and `SAFEWATCH_MEDIA_ARCHITECTURE.md` §32.

**Checkpoint 9 — complete product experience.** The playback panel now warns you shortly before a supported finding (default 20 s ahead, shown for 3 s), with **Skip** and **Ignore** buttons that reuse the Checkpoint 8 actions; ignoring the warning does nothing. Your flagged-term list can be added to, edited and removed with a clear saved / active / not-yet-applied state, and playback preferences (warnings on or off, lead time, visible time, default action) are saved in this browser after validation. You can report a missed finding (stored only in this browser, never sent, never used to train anything) and the page explains plainly what was analyzed and why a finding may be unavailable. **Still only flagged terms in speech and subtitles are detected.** No sexual, violence, graphic or drug detection exists, there is no safety score, and a result without findings does not mean a video is safe. See `CHECKPOINT_9_REPORT.md`.

**Checkpoint 8 — playback safety actions.** The uploaded video can now be played in the page (the browser's own player on your own file, no server involved) and the findings of Checkpoint 7 can drive **mute** and **skip** while you watch. Nothing happens until you choose (the default is no action), only findings that exist today (flagged terms in speech and subtitles) can trigger an action, uncertain findings are never acted on unless you choose it, and a master switch and per-finding choices (mute, skip, ignore, none) take effect immediately. The media is not edited, timing is not sample accurate, and no visual or other category is detected. See `CHECKPOINT_8_REPORT.md`.

**Checkpoint 7 — safety classification foundation.** SafeWatch now has a safety taxonomy, a typed finding contract (with evidence references, explicit uncertainty and abstention) and a replaceable classifier port. **One category is genuinely implemented: flagged terms** (words and phrases you list, found in speech and subtitles by a rule-based matcher). **Sexual content, violence, graphic injury and drug-related content are NOT supported**: no feasible local classifier exists (see below), and object labels or people in a frame are never treated as evidence of them. There is **no overall safety score and no verdict**, and nothing is muted, censored, blurred, skipped or warned about. See `CHECKPOINT_7_REPORT.md`.

**Checkpoint 6 — cross-modal context and temporal reasoning foundation.** Speech, subtitle and visual evidence from the earlier steps is now correlated on the media timeline into **context events**: groups of evidence that belong together in time, each keeping every piece of evidence with its own provenance and confidence, and an explanation of why it was grouped. It is deterministic and local (no model, no LLM). **It does not classify safety: no safety score, no verdict, and nothing is muted, censored, blurred or skipped.** See `CHECKPOINT_6_REPORT.md`.

**Checkpoint 5 — visual intelligence foundation.** The frames extraction already produces are now described by a local image model (Apple Vision on macOS, behind a replaceable port): labels, located people/animals and recognised text, each with a media timestamp, shown as a frame grid with a preview. This is **visual evidence only**: there is **no safety classification, no score, no verdict, and nothing is muted, censored, blurred or skipped**. Details below and in `CHECKPOINT_5_REPORT.md`.

**Checkpoint 4 — speech & subtitle intelligence foundation.** On top of upload, storage, FFprobe/FFmpeg and deterministic extraction, SafeWatch now transcribes speech locally (whisper.cpp) and merges it with subtitle text into one timestamped, aligned timeline, and can find user-defined words and phrases in it. This is **text evidence only**: there is **no safety classification, no scoring, no verdict, and nothing is muted, censored or changed**. A video can be `Media: ready`, `Extraction: completed`, `Text: ready` and `Analysis: not started` at the same time.

| Capability | Status |
| --- | --- |
| Landing page (nav, hero, capabilities, how it works) | IMPLEMENTED |
| Design system tokens + foundational components | IMPLEMENTED |
| Media ingestion foundation: `MediaAsset` model, state machine, typed errors, `MediaProcessor` port | IMPLEMENTED |
| Upload component (select/drop, content-sniff validation, local metadata) | IMPLEMENTED — local only, nothing is uploaded |
| Node API: health, streamed upload, status, delete | IMPLEMENTED |
| Server validation (extension, MIME, signature, size, FFprobe structure) | IMPLEMENTED |
| Temporary disk storage with lifecycle and cleanup | IMPLEMENTED |
| FFprobe metadata + FFmpeg decode check | IMPLEMENTED |
| Real upload progress in the UI | IMPLEMENTED |
| Audio extraction (16 kHz mono WAV, every track) | IMPLEMENTED |
| Subtitle detection + text extraction to timestamped cues (image subtitles reported as unsupported) | IMPLEMENTED |
| Deterministic, capped frame sampling (JPEG) | IMPLEMENTED |
| Extraction manifest API, phase-based progress, extraction UI | IMPLEMENTED |
| Speech-to-text (local whisper.cpp, word timestamps, language detection) | IMPLEMENTED — optional, off unless configured |
| Transcript model, track selection, speech/subtitle timeline and alignment | IMPLEMENTED |
| Custom filters (add/enable/remove) and deterministic match detection in speech and subtitles | IMPLEMENTED — detection only |
| Visual analysis (local Apple Vision: labels, people/animals with boxes, OCR) per sampled frame | IMPLEMENTED — optional, macOS only, off unless configured |
| Visual timeline, frame API and "Visual evidence" UI with frame preview | IMPLEMENTED — evidence only |
| Context events: speech, subtitle and visual evidence correlated by media time, with provenance, explanation and per-source confidence | IMPLEMENTED — grouping only |
| Context API and timeline UI with evidence drill-down | IMPLEMENTED |
| Safety taxonomy, finding contract, classifier port | IMPLEMENTED |
| Flagged-term classifier (speech and subtitles; rule based) with evaluation fixtures | IMPLEMENTED — occurrence of listed words only, not meaning |
| Sexual content, violence, graphic injury, drug-related content classification | NOT SUPPORTED — no feasible local classifier (documented blocker) |
| Playback of the user's own file with mute and skip of flagged-term findings, overrides and explanations | IMPLEMENTED — browser mute and seek on the user's file, not sample accurate |
| Reliable Hindi transcription | PARTIAL — needs the `small` model; Hindi/English code-switching NOT supported |
| OCR of image subtitles | NOT IMPLEMENTED |
| Scene detection | NOT IMPLEMENTED |
| Persistent database, user accounts, background workers | PLANNED |
| Responsive layout, accessibility foundation | IMPLEMENTED |
| Tests, lint, typecheck, build | IMPLEMENTED |
| Safety classification of visual evidence (violence, sexual, drugs), safety score, verdicts | PLANNED (not implemented) |
| Muting, beeping, subtitle censoring, blurring, scene skipping | PLANNED (not implemented) |
| Profanity / custom phrase detection | PLANNED |
| Contextual analysis, risk score, timeline | PLANNED |
| Pre-playback warnings | PLANNED |
| Filtering (mute, beep, subtitle censoring, blur, skip) | PLANNED |
| Safety presets and custom user policies | PLANNED |
| Authentication, database, background jobs | PLANNED |

## Architecture

Layers depend inward only: `components/features → application → domain`, with `infrastructure` implementing ports declared by `application`.

```
Presentation   components/, features/, pages/, app/
      ↓
Application    application/      use cases + ports (e.g. ingestMedia, MetadataReader)
      ↓
Domain         domain/           pure rules and types (no framework, no browser APIs)
      ↑
Infrastructure infrastructure/   adapters: config, browser metadata reader
```

See `CHECKPOINT_0A_REPORT.md` for the full diagram and rationale, and `SAFEWATCH_ROADMAP.md` for where each future service plugs in.

## Media architecture

Decision (see `SAFEWATCH_MEDIA_ARCHITECTURE.md`): a Vite SPA plus a **Node/TypeScript API that runs FFmpeg/FFprobe**, in the same repository, sharing the pure domain code in `src/domain`.

```
Browser ──raw file stream (XHR, real progress)──► Node API ──► MediaService ──► MediaStorage (disk)
   ▲                                                  │                              │
   └──────────── poll GET /api/media/:id ◄────────────┘             FfmpegMediaProcessor → ffprobe / ffmpeg
```

- `src/domain` – shared: `MediaAsset`, validation, container sniffing, ingestion state machine, API contract, analysis boundary.
- `src/application`, `src/infrastructure` – browser side: ingestion service, `MediaUploader` port, `HttpMediaUploader`.
- `server/src/api` – HTTP only (routing, CORS, error rendering). No media logic.
- `server/src/application` – `MediaService`, ports (`MediaStorage`, `ServerMediaProcessor`, `Logger`), processing queue.
- `server/src/domain` – server-side media record and state transitions.
- `server/src/infrastructure` – local-disk storage, FFmpeg adapter, in-memory registry, JSON logger.

Media status (`uploaded → processing → ready | failed`) is separate from analysis status (`not_started → queued → processing → completed | failed`).

## Backend setup

Requires **FFmpeg and FFprobe** on `PATH` (or `SAFEWATCH_FFMPEG_PATH` / `SAFEWATCH_FFPROBE_PATH`).

```bash
brew install ffmpeg          # macOS (Homebrew)
# sudo apt install ffmpeg    # Debian/Ubuntu
ffmpeg -version && ffprobe -version
```

Run the two processes in two terminals:

```bash
npm run dev:server   # API on http://127.0.0.1:8787
npm run dev          # SPA on http://localhost:5173 (proxies /api to the API)
```

The server refuses to start (with instructions) if FFmpeg/FFprobe are missing. Without a server you can still use the UI with `VITE_MEDIA_BACKEND=browser`. Production build of the API: `npm run build:server && npm start`. All variables are documented in `.env.example`.

## Upload API

| Method & path | Purpose |
| --- | --- |
| `GET /api/health` | `{status, service, version, environment, tools}`; no paths or secrets |
| `POST /api/media` | Raw file body; header `X-SafeWatch-Filename` (URI-encoded) and `Content-Type`. Returns **202** `{media:{asset, analysis}}` with `Location`. The body is streamed to disk, never buffered |
| `GET /api/media/:id` | Current `{asset, analysis}`; poll until `asset.status` is `ready` or `failed` |
| `DELETE /api/media/:id` | Delete the stored file and record (idempotent, 204) |

Errors are `{error:{code, message, requestId}}` with codes `INVALID_FILE`, `UNSUPPORTED_MEDIA`, `FILE_TOO_LARGE`, `UPLOAD_FAILED`, `MEDIA_PROCESSING_FAILED`, `MEDIA_METADATA_FAILED`, `STORAGE_FAILED`, `PROCESSING_TIMEOUT`, `SERVER_BUSY`, `NOT_FOUND`, `INTERNAL_ERROR`.

## Media and storage lifecycle

Upload → `<uuid>.part` on disk → renamed to `<uuid>.media` when complete (`uploaded`) → queued/`processing` (FFprobe + decode check) → `ready` (file kept) or `failed` (file deleted immediately). Ready media is deleted when the user replaces it (`DELETE`), or automatically after `SAFEWATCH_RETENTION_MINUTES` (default 60). Orphaned files are swept by age; the whole storage directory is purged at startup and shutdown. See `SAFEWATCH_MEDIA_ARCHITECTURE.md` for the production FFmpeg strategy.

## Extraction pipeline (Checkpoint 3)

```
MediaAsset (ready)
   │  queued on a bounded in-process queue (default: 1 extraction at a time)
   ▼
MediaExtractionService ── policy: selection, dedupe, caps, limits, cleanup
   ├─► audio     16 kHz mono PCM WAV per audio track           → AudioAsset[]
   ├─► subtitles text tracks → timestamped cues; image tracks listed as unsupported → SubtitleTrack[]
   └─► frames    equal-interval, mid-interval JPEGs, capped     → FrameSet
   ▼
MediaExtraction manifest (validated, serialisable, no paths, no tool output)
```

Three independent statuses: **Media** (`uploaded → processing → ready`), **Extraction** (`not_started → queued → processing → completed | failed`, with phases `preparing → extracting-audio → extracting-subtitles → sampling-frames → finalizing`) and **Analysis** (`not_started`, nothing implements it yet). Extraction failure never turns ready media into failed media.

Defaults (all configurable, see `.env.example`): one frame per 10 s capped at 300 frames, fitted inside 768×768 as JPEG, 64 MB total frames, 512 MB total audio, 8 audio tracks, 50,000 cues per subtitle track, 10-minute job timeout. Everything extracted shares the original's 60-minute retention and is deleted with it.

API: `GET /api/media/:id/extraction` returns the manifest; `GET /api/media/:id` includes `extraction: {status, phase}`. Details, formats and the reasoning are in `SAFEWATCH_MEDIA_ARCHITECTURE.md` §18–§24. AI models are **not** implemented: future analysis will consume `AudioAsset`, `SubtitleCue` and `Frame` values only.

Measure it yourself: `npm run check:extraction -- /path/to/video.mkv`.

## Speech and subtitle intelligence (Checkpoint 4)

```
AudioAsset (WAV 16 kHz mono) ──► SpeechToTextProvider (port) ──► whisper.cpp ──► Transcript (segments, word times, language)
SubtitleTrack (text cues) ─────────────────────────────────────────────────────┐
                                                                               ▼
                                          TextEvent timeline (speech + subtitle) ──► alignment: both / speech-only / subtitle-only
                                                                               ▼
                       Custom filters (browser) ──► TextMatch { source, start, end, matchedText, confidence }   (evidence only)
```

- **Provider:** whisper.cpp, native and local (no Python), multilingual `ggml-base` model (141 MB). Replaceable behind `SpeechToTextProvider`. **Audio never leaves the machine.**
- **Setup:** `brew install whisper-cpp`, `scripts/download-speech-model.sh` (verifies the checksum; weights are git-ignored), then set `SAFEWATCH_SPEECH_PROVIDER=whispercpp` and `SAFEWATCH_SPEECH_MODEL_PATH=models/ggml-base.bin` (see `.env.example`). Without them the server still runs and collects subtitle text only. For Hindi use `scripts/download-speech-model.sh small`.
- **API:** `GET /api/media/:id/transcript` (`?words=false` omits word timestamps). `/api/health` reports only `speech: {provider, available}`.
- **Timestamps:** media time in milliseconds. Word **start** times are reliable (DTW alignment, ≈0.1 s in tests); a word's **end** is an upper bound.
- **Language:** detected per track; never translated. Measured limits: Hindi on `base` is written in Urdu script; code-switched Hindi/English is not transcribed faithfully by either model; the brand name "SafeWatch" is heard as "safe watch" (the `phrase` match mode handles it).
- **Custom filters:** a "Custom filters" section lets the visitor add words/phrases (Whole word, Phrase, Contains, Exact case), enable/disable and remove them. They are stored in the browser; the Transcript panel matches them there, and the enabled terms are sent to your SafeWatch server for the safety-findings request only (not stored, not logged); matches are listed with source, time and confidence. SafeWatch does not mute or alter anything.
- Measure it yourself: `npm run check:speech -- video.mp4`. Details, decisions, privacy and limits: `SAFEWATCH_MEDIA_ARCHITECTURE.md` §26.

## Visual intelligence (Checkpoint 5)

```
Frame (JPEG, from extraction) ──► VisualAnalysisProvider (port) ──► safewatch-vision (Apple Vision) ──► raw observations (untrusted)
                                         ▼ normalizeObservation (validate, clamp, drop unusable)
              VisualObservation { frameId, timestampSeconds, type: classification | object | text, label, confidence, region }
                                         ▼ sorted deterministically ──► VisualAnalysis ──► GET /api/media/:id/visual ──► "Visual evidence" UI
```

- **Provider:** Apple Vision framework through a small Swift helper (`native/apple-vision`, built to `bin/safewatch-vision`, git-ignored). On-device; **frames never leave the machine**; no model weights in the repository. macOS only: the port keeps it replaceable (a Linux/ONNX adapter is future work).
- **What it reports:** image labels with confidence, people and animals with normalised boxes, and recognised text with boxes. No face detection or recognition. Labels use Apple's own vocabulary and can be wrong (a black frame is labelled "night sky").
- **Setup:** `scripts/build-vision-helper.sh`, then `SAFEWATCH_VISION_PROVIDER=apple-vision` (see `.env.example`). Without it the server still runs and the UI says visual analysis is not enabled.
- **API:** `GET /api/media/:id/visual` (`?observations=false` for a small progress form), `GET /api/media/:id/frames/:frameId` (the sampled JPEG, only ids from the manifest). `/api/health` reports `vision: {provider, available}` only.
- **Limits:** at most 300 frames (the extraction cap), 8 per helper process, 120 s per batch, 8 MB per frame, 64 observations per frame; a bad frame fails alone; the queue is bounded (default 1 job).
- **Tests:** the real-inference tests run on macOS on every `npm test`: `server/test/globalSetup.ts` builds the helper and fetches seven checksummed COCO photos (CC BY 2.0, cached under git-ignored `server/test/fixtures/vision-cache`). A missing helper **fails** the run; it is never converted to a mock. On other platforms those tests are skipped.
- Measure it yourself: `npm run check:vision -- video.mp4`. Details, decisions, privacy and limits: `SAFEWATCH_MEDIA_ARCHITECTURE.md` §27.

## Cross-modal context (Checkpoint 6)

```
speech segments ─┐
subtitle cues  ──┼─► EvidenceItem (one shape, media time) ─► correlateEvidence ─► ContextEvent[] ─► GET /api/media/:id/context ─► "Contextual evidence" UI
visual observations ┘        validate · integer ms · dedupe · sort       one forward pass          members + why they joined
```

- **What it is:** a deterministic temporal layer. Two pieces of evidence are related when the later one starts within `windowBefore + windowAfter` (default 0.5 s + 1 s) of the earlier one ending; a context never exceeds `maxContext` (default 20 s); a sampled frame may also relate to nearby text through its coverage (half the sampling step, capped at 5 s). Evidence longer than a context (a 30 s subtitle) keeps its own event and is only listed as "also during this time" in the events it overlaps.
- **What it keeps:** every member with modality, kind, exact time, label, the source's own confidence and the track/frame it came from; why it joined (`anchor`, `overlap`, `proximity`, `visual-coverage`); per-modality confidence ranges, never one combined number.
- **What it is not:** it says nothing about whether content is acceptable. There is no safety field in the model, API or UI.
- **API:** `GET /api/media/:id/context` (`?evidence=false` omits members). It is computed on request from the earlier stages (pure, no file access). `status` is `pending`, `ready`, `partial` (a modality failed or is not enabled, and the response says which) or `unavailable`.
- **Config:** `SAFEWATCH_CONTEXT_*` (see `.env.example`). Measure it: `npm run check:context`. Details: `SAFEWATCH_MEDIA_ARCHITECTURE.md` §28.

## Safety classification (Checkpoint 7)

```
Custom filters (your words) ─┐
TextAnalysis (CP4) ──────────┼─► FlaggedTermClassifier ─► SafetyFinding[] + CategoryReport[] ─► POST /api/media/:id/safety-findings ─► "Safety classification" UI
ContextAnalysis (CP6) ───────┘     (SafetyClassifier port)        status · evidence · explanation · abstention
```

- **Taxonomy (`safewatch-taxonomy-1`):** `flagged-terms` (implemented, speech and subtitles), `sexual-content`, `violence`, `graphic-injury`, `drug-content` (all **unsupported**, each with what would count, what would not, its limits and the blocker). The report always lists all five, so an unsupported category can never be mistaken for a clean result.
- **Finding:** category, taxonomy version, integer-millisecond range, `detected` or `uncertain`, evidence references (modality, time, source, context event, the source's own recognizer confidence), an explanation built from facts, warnings, classifier id. `rawScore` and `calibratedProbability` are `null`: a rule engine has no score and nothing was calibrated. No combined score and no verdict exist.
- **Uncertain** means speech alone supports it and either the recognizer was unsure (lowest word confidence below 0.5, a documented policy threshold) or the subtitles shown at that time do not contain the term.
- **Abstention:** no listed terms, or both text inputs unavailable, gives `abstained` (no negative claim). A missing input gives `partial` and names it. A classifier that throws is `abstained` with a fixed reason.
- **API:** `POST /api/media/:id/safety-findings` with `{ "terms": [{ "phrase", "matchMode" }] }` (strict body, at most 100 terms and 32 KB); `GET` is the same with no terms. Computed from the earlier stages' results: nothing is re-extracted, no file is read.
- **Evaluate it:** `npm run eval:safety` (43 labelled synthetic examples, including 6 known limitations), `npm run check:safety` (runtime). The fixtures are engineering fixtures, not a benchmark. Details: `SAFEWATCH_MEDIA_ARCHITECTURE.md` §29.

## Playback safety actions (Checkpoint 8)

```
SafetyAnalysis (CP7 findings) ─► planCandidates ─► ActionCandidate[]  ─┐  (interval, timing quality, availability)
your choices (in memory) ───────► resolveViews  ─► PlaybackAction[]   ─┼─► buildSpans ─► PlaybackCoordinator ─► <video> mute / seek
the video's duration ───────────►                                      ─┘     (pure domain)     (PlaybackSurface)
```

- **Media source:** the browser plays the `File` you chose through an object URL. The server never serves the original media, so no endpoint, path or upload was added. Whether a file plays depends on your browser's codec and container support; if it cannot play, the panel says so.
- **Actions:** `mute` (the player's `muted` flag only while the playhead is inside the interval; your volume is never touched and your own mute state is restored), `skip` (seek to the interval's end, once, never beyond the duration), `ignore` (undoable), `none` (default).
- **Intervals:** integer milliseconds, half-open. Word-timed speech gets a margin (150 ms before, 250 ms after) because its start is aligned (about 0.1 s) and its end is approximate; a subtitle cue is exact but covers the whole line; speech without word timing is the whole segment. Zero-length, out-of-range or invalid findings are listed as unavailable with the reason and are never acted on. Overlapping and adjacent actions merge into one span, keeping every source finding.
- **No traps:** a skip moves strictly forward, waits for its own seek, retries at most 3 times, and a seek the user makes into a skip interval is respected until they leave it; replay skips again.
- **Failure isolation:** an error in the action code restores your sound, stops automatic actions and leaves the player alone.
- **Privacy:** choices live in memory for the open video only: nothing is saved or sent. **Not implemented:** actions for any other category, beep, blur, subtitle censoring, edited output, warnings.
- Measure it: `npm run check:playback`. Details: `SAFEWATCH_MEDIA_ARCHITECTURE.md` §30.

## Product experience (Checkpoint 9)

- **Warnings:** a pure `WarningScheduler` (`src/domain/warnings`) shows one warning per group of overlapping findings, `leadSeconds` (10, 20 or 30; default 20) before the first one, for `durationSeconds` (3, 5 or 8; default 3). Skip and Ignore call the same CP8 override path once; expiry or dismissal does nothing to the media. Pause, seek, replay, media replacement and end are handled; the countdown holds while the warning is hovered or focused. One playback hook feeds both the CP8 coordinator and the scheduler, so there is still a single playback engine.
- **Custom phrases:** add, edit, remove, enable. The list is saved in this browser; when you analyze a video the enabled phrases are sent to your own SafeWatch server for matching (not stored or logged there). Changing the list shows "not applied" until you re-run the analysis. Matching is exact on normalised text; nothing is learned.
- **Preferences:** `src/domain/preferences` + a validated `localStorage` store with an in-memory fallback. There is no "censor everything" mode.
- **Feedback:** a missed-finding report (timestamp prefilled from the playhead, phrase, what it was, optional note) stored only in this browser; it never becomes a finding and does not train or guarantee anything. Review and delete in the panel.
- **Honesty:** supported media, evidence availability and "no findings is not a safety verdict" are stated on the page.
- Details: `SAFEWATCH_MEDIA_ARCHITECTURE.md` §31.

## Security and deployment (Checkpoint 10)

Supported setup: one person, one macOS machine, API on `127.0.0.1`, SPA and API in the same browser (the Vite proxy in development, one origin in production).

- **Sessions:** your first upload starts an anonymous session (HttpOnly cookie, no accounts). Media belongs to that session; another browser, or knowing a media id, gives no access. Clearing cookies loses access to your media (it is deleted on schedule anyway). Idle sessions expire after 24 h.
- **Limits:** 10 uploads/min, 5 media and 4 GB per session, 10 GB total, 512 MB of the disk always left free; all configurable in `.env.example`.
- **Sandbox:** on macOS the tools run with no network, no new processes and writes only to their own work directory. Startup logs `sandbox: seatbelt`. In production a sandbox is required, so the server will not start on Linux or Windows.
- **Exposure:** the server refuses a non-loopback host unless `SAFEWATCH_ALLOW_NETWORK_BIND=true` and `SAFEWATCH_ALLOWED_HOSTS` are both set; do not do this: there are no accounts.
- **Production start:** `NODE_ENV=production SAFEWATCH_STORAGE_DIR=/dedicated/empty/dir npm run build:server && npm start`. Everything in that directory is deleted at start and stop. Media is stored **unencrypted** for at most `SAFEWATCH_RETENTION_MINUTES`; deleting it earlier is `DELETE /api/media/:id` or stopping the server.
- **Not done:** see the release-gate table in `SAFEWATCH_MEDIA_ARCHITECTURE.md` §32.12.
- **Fonts:** Inter v4.1 is self-hosted (`public/fonts/InterVariable.woff2`, SIL Open Font License 1.1 in `public/fonts/Inter-LICENSE.txt`), so a page load contacts no third-party server (verified in the browser: the only origin is the app itself). Until Checkpoint 10's follow-up it loaded Google Fonts.
- **Checks:** `npm audit` (0 vulnerabilities after the vite 8.3.5 lockfile update) and the `server/test/security*.test.ts` suites.

## Technology stack

- **Vite + React 19 + TypeScript (strict)** — SPA with fast tooling.
- **whisper.cpp** (local speech-to-text, external process; installed with Homebrew, not an npm/Python dependency).
- **Node 24 (no web framework)** — the API uses `node:http`; **FFmpeg/FFprobe** as external processes; **tsx** to run TypeScript in development.
- **React Router** — routing.
- **Plain CSS with design tokens** — no UI framework; tokens in `src/styles/tokens.css`.
- **Vitest + Testing Library** — component and unit tests.
- **ESLint (typescript-eslint, react-hooks, jsx-a11y)**.

## Development setup

Requires Node.js 20+ (developed on 24) and npm.

```bash
npm install
cp .env.example .env   # optional; defaults are valid
npm run dev
```

| Command | Purpose |
| --- | --- |
| `npm run dev` | Frontend dev server at http://localhost:5173 |
| `npm run dev:server` | API dev server at http://127.0.0.1:8787 (restarts on change) |
| `npm run build:server` / `npm start` | Bundle and run the API (`dist-server/`) |
| `npm run check:large -- <file>` | Manual large-file streaming/memory check |
| `npm run check:extraction -- <file...>` | Manual extraction timing, size, memory and cleanup check |
| `npm run check:speech -- <file...>` | Manual real speech-to-text timing, memory and accuracy check |
| `scripts/download-speech-model.sh [base\|small]` | Download and verify a whisper.cpp model into `models/` |
| `npm run build` | Typecheck and production build to `dist/` |
| `npm run preview` | Serve the production build |
| `npm test` | Run tests once (`test:watch` for watch mode) |
| `npm run lint` | ESLint |
| `npm run typecheck` | TypeScript only |


## Design system

`SAFEWATCH_DESIGN_SYSTEM.md` is the single source of truth for UI. Use the tokens in `src/styles/tokens.css`; never hard-code colors, spacing or radii in pages.

## Roadmap

See `SAFEWATCH_ROADMAP.md` (Checkpoints 0A → 18).

## Development workflow

- One checkpoint at a time; each is reviewed before the next begins.
- Before committing: `npm test && npm run lint && npm run typecheck && npm run build`.
- Never commit secrets. `.env` is git-ignored; document new variables in `.env.example` and validate them in `src/infrastructure/config/env.ts`. Variables prefixed `VITE_` are public — they ship to the browser.
- Reusable UI goes in `src/components/ui`; do not restyle it per page.

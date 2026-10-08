# SafeWatch

> Understand your media. Control your experience.

SafeWatch is intended to become a premium AI-powered media-safety platform: it understands what is happening inside a video and gives users control over what they are willing to see and hear.

## Current status

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
| Reliable Hindi transcription | PARTIAL — needs the `small` model; Hindi/English code-switching NOT supported |
| OCR of image subtitles | NOT IMPLEMENTED |
| Scene detection | NOT IMPLEMENTED |
| Persistent database, authentication, background workers | PLANNED |
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
- **Custom filters:** a "Custom filters" section lets the visitor add words/phrases (Whole word, Phrase, Contains, Exact case), enable/disable and remove them. They stay in the browser; matches are listed with source, time and confidence. SafeWatch does not mute or alter anything.
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

See `SAFEWATCH_ROADMAP.md` (Checkpoints 0A → 11).

## Development workflow

- One checkpoint at a time; each is reviewed before the next begins.
- Before committing: `npm test && npm run lint && npm run typecheck && npm run build`.
- Never commit secrets. `.env` is git-ignored; document new variables in `.env.example` and validate them in `src/infrastructure/config/env.ts`. Variables prefixed `VITE_` are public — they ship to the browser.
- Reusable UI goes in `src/components/ui`; do not restyle it per page.

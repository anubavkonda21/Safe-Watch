# SafeWatch Media Architecture

Status: decided in Checkpoint 1; the server foundation was implemented in Checkpoint 2 (see §14–§17). Audio/subtitle/frame extraction is still planned.

## 1. Problem

SafeWatch must eventually understand what is inside a video, so it needs to:

| Stream | Needs |
| --- | --- |
| Video | duration, resolution, frame rate, codec; controlled frame sampling with timestamps for vision models |
| Audio | detect audio streams; extract audio for speech-to-text |
| Subtitles | detect embedded tracks; extract; parse; keep timestamps |
| Frames/segments | extract at controlled rates, keyed by timestamp, as future model input |

Constraints that shape the choice: videos are large (hundreds of MB to several GB); containers and codecs are diverse (MKV, AVI, HEVC, AC-3 are common and poorly supported by browsers); AI provider keys must never reach the browser; the content is private and often sensitive; the product is early-stage.

## 2. Current architecture

(From Checkpoint 0A.) Vite + React SPA only. No backend. `MetadataReader` port with a browser adapter that reads duration and dimensions through a detached `<video>` element. FFmpeg and FFprobe are **not installed** on the development machine (macOS arm64, 16 GB RAM, Node 24); Docker is not installed. Nothing leaves the user's device.

## 3. Options considered

- **A. Browser-only** (ffmpeg.wasm / WebCodecs / `<video>`).
- **B. Vite frontend + Node/TypeScript API** that shells out to a system FFmpeg/FFprobe (same repo, shared domain types).
- **C. Vite frontend + dedicated media-processing service** (separate deployable, queue/worker, probably containerised).
- **D. Managed/cloud media processing** (e.g. a transcoding/analysis API or cloud functions plus object storage).
- **E. Native/desktop wrapper** (Electron/Tauri with bundled FFmpeg).

## 4. Comparison

| Criterion | A Browser | B Node API | C Dedicated service | D Managed cloud | E Desktop |
| --- | --- | --- | --- | --- | --- |
| Dev complexity | Low initially, high later (wasm workarounds) | Low–moderate | High | Moderate (integration) | High |
| Performance | Single-threaded wasm is slow; no hardware decode | Native FFmpeg, fast | Native, independently scalable | Fast, vendor-limited | Native |
| Browser compatibility | Poor for MKV/AVI/HEVC; wasm needs COOP/COEP headers for threads | Irrelevant (server decodes) | Irrelevant | Irrelevant | Irrelevant |
| FFmpeg requirements | ~30 MB wasm bundle, limited codecs/filters | System binary, full feature set | System binary in image | Vendor-provided | Bundled binary |
| Security | Files stay local (good); but AI keys cannot live here | Untrusted-file parsing on our server: needs hardening | Best isolation (sandboxed worker) | Delegated; vendor trust | Local only |
| Scalability | Scales with users' devices; unreliable on weak ones | Vertical first; limited by one process | Horizontal | Horizontal | n/a |
| Deployment complexity | Static hosting | One service + FFmpeg on host | Multiple services, orchestration | Low ops, high integration | Installers/updates per OS |
| Cost | Zero infrastructure | Low | Medium–high | Usage-based, can grow fast | Distribution cost |
| Local development | Trivial | Simple once FFmpeg installed | Needs containers/queue | Needs cloud credentials | Heavy |
| Production feasibility | Weak for target feature set | Good | Good (later) | Good, but privacy/cost trade-offs | Narrow reach |
| Future AI integration | Keys exposed; heavy models in-browser impractical | Natural: server holds keys, calls providers | Natural | Natural but coupled | Possible |
| Background processing | None (tab must stay open) | In-process queue now, worker later | Native fit | Native fit | Local |
| Large files | Memory-bound (wasm ~2 GB limit, copies in MEMFS) | Stream to disk, process from disk | Same, plus dedicated storage | Direct-to-bucket uploads | Disk-based |
| Concurrent users | N/A (client compute) | Limited by one box | Good | Good | N/A |

## 5. Decision

**Option B, adopted in phases.** SafeWatch will be a Vite SPA plus a Node/TypeScript API in the same repository. The API runs FFprobe/FFmpeg as external processes (argument arrays, never shell strings), stores uploads on local disk behind a storage port, and runs jobs through an in-process queue behind a job port. Shared pure domain code (`src/domain`) is reused by both sides.

Phasing:

1. **Checkpoint 1 (this one):** define the media domain, ingestion service, `MediaProcessor` port and state machine; ship the browser adapter only. No server, no FFmpeg.
2. **Checkpoint 2:** introduce the server, `FfprobeMediaProcessor`, streamed upload, and audio/subtitle extraction, because speech-to-text and subtitle intelligence are the first features that cannot be done in a browser.

## 6. Why

- The feature set (audio extraction, embedded subtitles, frame sampling, broad codecs) requires real FFmpeg. Browser-only (A) cannot deliver it reliably, and AI provider keys must sit server-side regardless.
- B is the smallest architecture that satisfies that: one extra process, one language, shared types, easy local development. C and D add operational and cost surface that nothing demands today.
- B does not close the door on C: because processing sits behind `MediaProcessor` and (later) `MediaStorage`/`JobQueue` ports, extracting a worker service is a change of adapter, not a rewrite.
- D would send users' private media to a third party by default and makes costs scale with every upload. It can be reconsidered for specific heavy stages (e.g. a hosted vision API is in any case an AI concern, not an ingestion one).
- The server is not built in this checkpoint because FFmpeg is not installed, it could not be verified here, and the contract can be established and tested without it. Building untested server code now would be speculative.

## 7. Data flow

Implemented now (client only):

```
 File (user)
   │  drop / choose
   ▼
 [validating]  domain: extension + MIME allowlist, size limit, filename sanitised
   │           application: read first 64 bytes (file.slice), sniff container, must match extension
   ├── fail ──► [failed]  typed MediaIngestionError (code)
   ▼
 [accepted]    MediaAsset created (id, sanitised name, detected type, size, metadata: pending)
   ▼
 [processing]  MediaProcessor.extractMetadata(file)   ← port
   │             adapter: BrowserMediaProcessor (detached <video>, object URL, revoked after use)
   │             metadata unreadable ⇒ availability "unavailable" (file is still VALID)
   ├── throws ─► [failed]
   ▼
 [ready]       MediaAsset { status: ready, metadata } — stable reference for future analysis
```

Target (Checkpoint 2+):

```
 Browser ──(chunked/streamed upload)──► API ──► MediaStorage (disk)
                                          │
                                          ▼
                                   JobQueue (in-process)
                                          ▼
                    FfprobeMediaProcessor ──► MediaAsset (full metadata)
                                          ├─► audio extraction ─► (Checkpoint 2 STT)
                                          ├─► subtitle extraction ─► (Checkpoint 2)
                                          └─► frame sampling ─► (Checkpoint 4 vision)
```

## 8. Security

Principles for uploaded media (client checks are a convenience; the server must re-validate everything):

- Treat every file as hostile. Extension and MIME are advisory; the container signature (magic bytes) must agree. Even that proves only the header, not that the file is benign (polyglots exist); FFprobe/FFmpeg are themselves parsers of untrusted input.
- Server stage: random server-generated IDs for storage paths (user filenames are display-only); upload size limits enforced while streaming; FFmpeg invoked via `spawn` with an argument array, a fixed allowlist of options, `-nostdin`, no user-controlled options or protocols (`-protocol_whitelist file`), CPU/time/memory limits, a restricted working directory, and an unprivileged user. Never interpolate filenames into shell strings.
- Subtitle and transcript text is untrusted: escape on render and treat as data in any prompt (prompt-injection) in future AI stages.
- Do not log filenames verbatim or file contents; errors shown to users are typed and generic about internals.

## 9. Storage

- **Now:** nothing is stored. The `File` stays in browser-managed storage; the object URL used for metadata is revoked immediately after.
- **Checkpoint 2:** local disk under a configured directory, behind a `MediaStorage` port. Originals are temporary: deleted after analysis or on a TTL; derived artefacts (audio, frames, subtitles) are deleted with the asset. Default is *not* to retain media permanently; any permanent storage will be an explicit product decision.
- **Later:** an object-store adapter (S3-compatible) behind the same port, with direct/resumable uploads.

## 10. Processing

- **Now:** in the browser, limited to duration and dimensions via the platform's `<video>` decoder. Codec, frame rate, audio/subtitle presence are **unknown** (`null`) in browser metadata; they are not guessed.
- **Later:** on the server via FFprobe (metadata, streams) and FFmpeg (extraction), always reading from disk, never loading whole files into memory. Large files: browser uploads by streaming/chunking (`File.slice` / `fetch` with a stream body or a resumable protocol), server writes to disk incrementally, processing reads from disk. Memory stays proportional to chunk size, not file size.

## 11. Future AI integration

AI stages consume a `MediaAsset` plus derived artefacts (audio file, subtitle cues with timestamps, sampled frames with timestamps) produced by the pipeline. They run server-side behind their own ports (speech, text, vision), so provider keys never reach the client and providers can be swapped. Cost is dominated by frame count and audio duration, so extraction stages expose sampling controls. Detection, risk and policy stages (Checkpoints 3–9) consume stage outputs, not raw media.

## 12. Deployment

- **Now:** static hosting (any CDN/static host) is sufficient for the SPA.
- **Checkpoint 2+:** one Node service on a VM or container platform with FFmpeg installed and a disk volume, serving the API and (optionally) the built SPA. Containerisation is an optional packaging choice then, not an architectural requirement.
- **Scale-out path:** split the job runner into a separate worker process using the same ports (becomes Option C), add an external queue and object storage when concurrency or file size demands it. Not before.

## 13. Alternatives rejected

- **A. Browser-only:** cannot extract embedded subtitles/audio reliably, poor codec coverage, memory-bound for large files, no safe place for AI keys. Retained only for local pre-validation and light metadata.
- **C. Dedicated service now:** operational cost with no current load to justify it; reachable later through ports.
- **D. Managed cloud now:** privacy and recurring cost for an unproven product; adds vendor coupling before requirements are known.
- **E. Desktop wrapper:** limits reach and multiplies distribution work; the product is web-first.

---

## 14. Checkpoint 2 implementation (what was actually built)

**Repository layout (decision).** One repository, two entry points, one shared pure domain:

```
src/domain/            shared by browser and server (media model, validation, sniffing, API contract, analysis boundary)
src/{application,infrastructure,features,...}   browser
server/src/{api,application,domain,infrastructure}   Node API
```

The server imports `@/domain/*` directly; domain files have no Node or browser dependencies, so nothing is duplicated and no package split is needed yet. If a second consumer appears, `src/domain` can be extracted to a workspace package without changing imports' meaning.

**Layering.** `api` (HTTP only) → `application` (`MediaService`, ports) → `domain` ← `infrastructure` (adapters). Neither the HTTP layer nor the application layer contains FFmpeg commands, filesystem paths or media parsing.

**Upload protocol (decision).** The file is the raw request body (`POST /api/media`, filename in `X-SafeWatch-Filename`), not multipart. It removes a parsing dependency and a class of multipart bugs, streams naturally (`HTTP stream → signature check → .part file → rename`), and lets the browser's `XMLHttpRequest` report real upload progress. The server answers `202` once the bytes are stored; processing runs asynchronously through a bounded in-process queue and the client polls `GET /api/media/:id`.

**Statuses (decision).** Media: `uploaded → processing → ready | failed` (plus client-only `accepted`). Analysis: `not_started | queued | processing | completed | failed`, carried separately in every response. No analysis exists yet, so it is always `not_started`.

## 15. Media and storage lifecycle

| Event | What happens |
| --- | --- |
| Upload starts | Cheap checks (extension, MIME, declared size, concurrency) run before any byte is read. Bytes stream to `<uuid>.part` (mode 0600) in a 0700 directory; the first 64 bytes are sniffed *while streaming* and a mismatch aborts the upload. |
| Upload completes | `.part` is renamed to `<uuid>.media` (atomic: a crash cannot leave a half-written file that looks finished). Record `uploaded`. |
| Processing | Queue slot → `processing` → FFprobe metadata, then FFmpeg decode smoke test (first 2 s), under a timeout. |
| Success | `ready`; the original stays on disk (future stages need it) until deleted or expired. |
| Failure | Record `failed` with a typed code; **the file is deleted immediately**. |
| Timeout | The child process is killed (`SIGKILL`), record `failed: timeout`, file deleted. |
| Upload error / client disconnect / over limit / deadline | `.part` removed, nothing registered. |
| User replaces or leaves | Client calls `DELETE /api/media/:id` (best effort). |
| Retention | Records expire after `SAFEWATCH_RETENTION_MINUTES` (default 60); a periodic sweep deletes expired media. |
| Delete fails | Logged; retried by the next sweep, which also removes any owned file older than the retention window regardless of registry state. |
| Server crash / restart | Records are in memory and are lost; the storage directory is **purged at startup**, and again at graceful shutdown. |

Safety rails: ids are validated UUIDs before any path is built; the directory must be empty or carry a SafeWatch marker file; purge/sweep only touch names matching `<uuid>.(media|part)`.

## 16. FFmpeg Runtime Strategy

### Local development
Install FFmpeg with the platform package manager (macOS: `brew install ffmpeg`, which installed FFmpeg/FFprobe 9.0.2 on this machine). The server resolves `ffmpeg`/`ffprobe` from `PATH` or `SAFEWATCH_FFMPEG_PATH`/`SAFEWATCH_FFPROBE_PATH`, and refuses to start with instructions if they are missing. No Docker is needed.

### Production
Options evaluated:

| Option | Pros | Cons |
| --- | --- | --- |
| **System package** (apt/dnf on the host or VM) | Simplest; security patches via OS updates; no extra moving parts | Version varies by distro; host is shared with the API |
| **Docker image** (FFmpeg in the API image) | Reproducible, pinned version, easy sandboxing (non-root, read-only FS, CPU/memory limits, no network) | Adds a container platform and image maintenance |
| **Bundled static binary** (`ffmpeg-static`/vendored) | Zero system dependency | Supply-chain and licensing burden (GPL/LGPL, codecs), slow security updates, larger artefacts |
| **Managed media service** | No FFmpeg ops | Media leaves our infrastructure (privacy), per-minute cost, vendor coupling |

**Choice for the current stage: system package on the API host.** It needs no new platform and gets security updates with the OS. Pin the major version in deployment docs and keep the `SAFEWATCH_*_PATH` override. **Not yet solved** (honest gaps): per-process CPU/memory/time limits beyond the application-level timeout and output cap, running FFmpeg as a separate unprivileged user, filesystem/network sandboxing (seccomp, containers), and an FFmpeg security-patch policy. These are Checkpoint 10 work.

### Future scaling
Move to a **Docker image with a locked-down runtime** (non-root, read-only root FS, memory/CPU limits, no network) when either (a) untrusted-media risk needs stronger isolation than process-level limits, or (b) the job runner becomes a separate worker service. At that point swap `LocalDiskMediaStorage` for an object-store adapter and `ProcessingQueue` for an external queue; both are behind ports already. Managed services remain an option only for specific heavy stages, decided with a privacy review.

## 17. Hardening applied to every FFmpeg invocation

- Executed with `spawn(binary, argsArray, {shell:false})`; the media path is a single argv element after `-i`, never concatenated into a string.
- The input path is always server-generated (`<uuid>.media`); user filenames never reach a command or the filesystem.
- `-protocol_whitelist file` and a **forced demuxer** (`-f mov|matroska|avi`) chosen from the already-verified container: FFmpeg will not auto-detect HLS/concat/other demuxers that could read other files or URLs from inside an upload.
- stdin closed (`-nostdin`, `stdio: 'ignore'`), minimal environment (`PATH` only), stdout capped (4 MB), stderr drained and discarded (never logged or returned), `SIGKILL` on timeout.
- Output is parsed defensively; raw FFprobe JSON never crosses the API.

---

## 18. Extraction architecture (Checkpoint 3)

```
 MediaService (media ready)                             ┌─ shared pure domain (src/domain/extraction) ─────────────┐
        │ schedule(mediaId)                              │ MediaExtraction · AudioAsset · SubtitleTrack/Cue · Frame │
        ▼                                                │ lifecycle · cue normalisation · frame planner · validator│
 ProcessingQueue (extraction, default 1 job)             └──────────────────────────────────────────────────────────┘
        ▼
 MediaExtractionService  ── policy (selection, dedupe, limits, cleanup) ──►  MediaExtractor (port)
        │                                                                         ▲ implements
        ▼                                                                  FfmpegMediaExtractor ──► ffprobe / ffmpeg
 MediaStorage.withExtractionDir(id)   <uuid>.extraction/{audio,frames}/
```

- **Ports.** `MediaExtractor` offers four single operations (`inspect`, `extractAudio`, `extractSubtitleCues`, `sampleFrame`). The *application* decides what to extract and enforces policy; the *adapter* only knows how. Results are normalised values: no FFprobe JSON, command lines, stderr or paths cross the boundary.
- **Storage.** The application never sees a path. `MediaStorage.withExtractionDir` hands a workspace to the adapter inside a callback; assets are addressed by logical artifact names (`audio/aud-0.wav`, `frames/frm-00001.jpg`), validated against a strict pattern. `delete(id)` removes the original **and** the whole extraction directory.
- **Lifecycle.** Extraction is its own state machine (`not_started → queued → processing → completed | failed`) with phase-based progress (`preparing`, `extracting-audio`, `extracting-subtitles`, `sampling-frames`, `finalizing`). It is independent of media status and analysis status. If extraction fails, media stays `ready`.
- **Failure model.** Fatal issues (limits, timeout, unreadable media, invalid manifest) fail the extraction and delete every partial output. Non-fatal issues (one unreadable subtitle track, a frame with no picture, tracks beyond the track cap) complete the extraction with `errors[]` warnings: nothing is dropped silently.

## 19. Audio extraction

**Format decision: 16 kHz, mono, 16-bit PCM in WAV (`pcm_s16le`).**

| Option | For | Against |
| --- | --- | --- |
| **WAV PCM 16 kHz mono (chosen)** | Exactly what speech-to-text engines (Whisper and most others) consume; every tool reads it; no codec dependency; byte-deterministic with `-fflags +bitexact`; trivial to slice by time (bytes = 32,000 per second) | Large: about 115 MB per hour per track (can exceed the source file size) |
| FLAC | Lossless, about half the size | Needs a decoder step before use; more complex to slice |
| Opus/AAC | Tiny | Lossy; extra decode; non-deterministic across encoder versions; may reduce recognition accuracy |
| Original codec copy | Zero cost | Not uniform; consumers would need FFmpeg again |

Policy: **every** audio stream is extracted, in container order, up to `SAFEWATCH_AUDIO_MAX_TRACKS` (8); streams beyond the cap are reported as warnings, never dropped silently. Stream index, language, title, dispositions (default/forced/original/hearing-impaired/commentary) and source codec/sample rate/channels/bit rate are preserved. Multi-channel audio is down-mixed to mono. A stream whose decoded audio is **bit-identical** to an earlier one (SHA-256) is recorded with `duplicateOf` and its file is not stored twice. Zero audio tracks is valid (`audio: []`). Total audio output is bounded by one budget (`SAFEWATCH_AUDIO_MAX_MB`, default 512 MB) shared by all tracks: the expected size is checked before decoding, and the adapter enforces the remaining budget on the actual output (`-fs`). Audio-only files are **not supported**: ingestion rejects media without a video stream (`MEDIA_METADATA_FAILED`).

## 20. Subtitles

- **Detection** (FFprobe): index, language (ISO tag, `und` → null), title, codec, dispositions. Classification by codec: **text** (subrip, ass/ssa, webvtt, mov_text, and similar), **image** (hdmv_pgs_subtitle, dvd_subtitle, dvb_subtitle, xsub) or **unknown** (anything else, never assumed to be text).
- **Text extraction**: FFmpeg converts the stream to SubRip on stdout (capped at `SAFEWATCH_SUBTITLE_MAX_MB`); the pure `parseSrt` reads timing at millisecond precision; `normalizeCues` cleans the text.
- **Normalisation (documented transformations)**: formatting tags removed (`<i> <b> <u> <font…> <c> <v> <span>…` and ASS `{\an8}`/`{\i1}` overrides); literal ASS `\N` becomes a line break; the basic entities (`&amp; &lt; &gt; &quot; &nbsp;`) decoded; control, zero-width and bidirectional-override characters removed; each line trimmed and runs of spaces collapsed; blank lines dropped; text capped at 4,000 characters; empty cues, cues with invalid timing and exact duplicates (same start, end and text) dropped; cues ordered by start time. Words, punctuation, casing and timing are otherwise preserved. Non-formatting angle-bracket text such as `<laughs>` is kept. Output is **plain text** and is rendered as text by the UI.
- **Image subtitles**: listed with `kind: "image"`, `textExtraction: "unsupported"` and no cues. No OCR is performed. Unknown codecs are listed as `unsupported` the same way.
- A single track that cannot be read becomes `textExtraction: "failed"` plus a warning; it does not fail the whole extraction. Cue limit per track: 50,000.
- ASS styling, positioning and karaoke effects are not preserved (FFmpeg's SubRip conversion discards most of them).

## 21. Frame sampling

**Algorithm (pure, `planFrameTimestamps`).** `count = min(maxFrames, ceil(duration / interval))`, then the video is divided into `count` **equal** intervals and one frame is sampled at the **middle** of each: `t_i = (i + 0.5) × duration / count`, rounded to milliseconds. Mid-interval sampling avoids the usually black first frame and end-of-file seeks; equal division guarantees every timestamp lies inside the media (a previous formulation sampled past the end of short videos and was caught by a unit test). If `duration / interval` exceeds `maxFrames` the step grows so samples still span the whole video (a 3-hour video at 1 frame/s still yields at most `maxFrames`). The requested and effective intervals are both recorded. Unknown duration: only the first moment is sampled, with a `duration-unknown` warning.

**Method decision: one fast input-seek per frame** (`ffmpeg -ss T -i … -frames:v 1`), run sequentially.

| Method | Correctness / determinism | Cost |
| --- | --- | --- |
| **Per-timestamp seek (chosen)** | Exact requested times; independent frames; easy to cap and to clean up | N process launches; each decodes from the previous keyframe |
| Sequential decode with an `fps` filter | Timestamps follow decoder pts rounding | Decodes the **whole** video (minutes for long 4K/HEVC) |
| Keyframe-only (`-skip_frame nokey`) | Irregular spacing; not reproducible across encoders | Fast, but not controllable |
| Hybrid (seek + short decode window) | Same as chosen | More code for no measured need |

Measured (see the Checkpoint 3 report): 300 frames from a 1-hour 720p video in about 15 s. Cost grows with frame count and keyframe distance; the job timeout bounds the worst case. Requested timestamps are recorded; the decoded frame is the first at or after the seek point (within one frame period).

**Format decision: JPEG** (`-q:v 4`, `yuvj420p`).

| Format | Size | Compatibility | CPU |
| --- | --- | --- | --- |
| **JPEG (chosen)** | Small (about 6.9 MB for 300 synthetic frames; real content 20–60 KB per 768-px frame) | Accepted by every vision API and library | Lowest |
| WebP | Smaller | Not universal in model/tooling pipelines; slower encode | Higher |
| PNG | 5–20× larger | Universal | Higher, lossless not needed for analysis |

**Resolution.** Frames fit inside `maxWidth × maxHeight` (default 768×768), aspect ratio preserved, **never upscaled** (`scale='min(W,iw)':'min(H,ih)':force_original_aspect_ratio=decrease`). A 3840×2160 source yields 768×432 frames. Dimensions in the manifest are measured from the JPEG header, not assumed. Scene detection is **not** implemented; the sampler is isolated so a future `SceneDetector` can supply timestamps to the same plan.

## 22. Limits, concurrency and retention

| Limit | Default | Behaviour on breach |
| --- | --- | --- |
| Job timeout | 10 min | FFmpeg processes killed, extraction `failed: timeout`, partial output deleted |
| Concurrent extractions | 1 (queue of 20) | Beyond the queue: `failed: server-busy`; media stays ready |
| Frames per media | 300 | Planner caps the count (interval grows); never exceeded |
| Frame bytes per media | 64 MB total | `failed: limit-exceeded`, cleanup |
| Audio bytes per media | 512 MB total, 8 tracks | Estimated before decoding; enforced on output (`-fs`); `failed: limit-exceeded`, cleanup; extra tracks warned |
| Subtitle cues / bytes | 50,000 / 8 MB per track | Track marked `failed` + warning |
| Single FFmpeg step | 60 s | Aborted as `timeout` |

Within a job FFmpeg processes run **one at a time**; the default of one concurrent job therefore means at most one FFmpeg process (verified: peak concurrent = 1). Disk worst case per media item is about original + 512 MB audio + 64 MB frames; with the 60-minute retention and 4 concurrent uploads this is still unbounded without a volume quota (Checkpoint 11).

**Retention.** Original, extracted audio, subtitle data (inside the manifest, in memory) and frames share one clock: the original's 60 minutes (`SAFEWATCH_RETENTION_MINUTES`). `DELETE`, expiry, failure, timeout and startup/shutdown purge remove the original and `<id>.extraction/` together; an age-based sweep removes orphaned extraction directories. Running extractions are aborted before their media is deleted.

## 23. API

`GET /api/media/:id/extraction` → `{ extraction }` (`mediaId, status, phase, audio[], subtitles[], frames{config, effectiveIntervalSeconds, totalSizeBytes, frames[]}, createdAt, startedAt, completedAt, errors[], metrics{durationMs, stageMs, toolProcesses, outputBytes}`). 404 `NOT_FOUND` for unknown or malformed ids. `GET /api/media/:id` carries `extraction: {status, phase}` next to `asset` and `analysis`. No paths, no tool output, no raw FFprobe JSON. Artifact bytes are not served over HTTP yet; future server-side analysis reads them through `MediaStorage.readArtifact`.

## 24. Future AI boundary

```
 EXTRACTION (deterministic, Checkpoint 3)  ──►  NORMALISED ASSETS  ──►  FUTURE AI ANALYSIS (NOT implemented)
                                                 AudioAsset  (WAV 16 kHz mono, per track, language/title/dispositions)
                                                 SubtitleCue (start, end, plain text, per track and language)
                                                 Frame       (timestamp, size, JPEG artifact)
```

Future analysis code receives these values and reads artifact bytes through the storage port. It never needs FFmpeg commands, FFprobe JSON, subprocess objects or file paths. **No AI model is implemented in Checkpoint 3.**

## 25. Security status (superseded by §32 in Checkpoint 10; kept for history)

> Checkpoint 10 added a macOS-only OS sandbox, sessions, quotas and rate limits: see §32. The paragraph below describes the state at Checkpoint 3.

All Checkpoint 2 controls apply to every extraction command (argv arrays, `shell: false`, minimal environment, closed stdin, `-protocol_whitelist file`, forced demuxer, timeouts, output caps, server-generated output names inside the job's directory with a path-escape guard, partial output removed on failure). Subtitle text and stream metadata are untrusted: sanitised, never logged, never interpreted as HTML. **FFmpeg isolation is still NOT COMPLETED** and remains a production security gate: there is still no OS sandbox, separate user, or memory/CPU cgroup. Measured example: decoding a 4K source made an FFmpeg child reach about 307 MB RSS with nothing limiting it.

---

## 26. Speech & subtitle intelligence (Checkpoint 4)

First AI inference in SafeWatch. It produces **text evidence only**: what was said or written, and when. It never decides whether media is safe, and it never mutes, hides or edits anything.

```
 MediaExtraction (completed)                               shared pure domain (src/domain/{speech,text})
   │ AudioAsset (WAV 16 kHz mono) · SubtitleTrack/Cue       Transcript · normalizeTranscription · selectAudioTracks
   ▼                                                        TextEvent · alignText · CustomFilter · findTextMatches
 TextAnalysisService  (bounded queue, default 1 job)        TextAnalysis lifecycle
   │ policy: track selection, limits, timeouts, cleanup
   ├─► SpeechToTextProvider (port) ◄── WhisperCppProvider ──► whisper-cli process ──► ggml model file
   │         raw, provider-neutral transcription (untrusted)
   ├─► normalizeTranscription + validateTranscript   → Transcript[]
   └─► eventsFromTranscript + eventsFromSubtitleTrack → buildTimeline → alignText → TextAnalysis.timeline
```

### 26.1 Provider evaluation

| Option | Accuracy / timestamps | Hindi & Indian-English | Apple Silicon / CPU | Install | Privacy | Cost | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **whisper.cpp** (Whisper family, native C++, ggml) | Whisper quality; segment times plus token times, optional DTW word alignment | Multilingual models; Hindi needs `small` (measured) | Metal and CPU out of the box, no Python or GPU needed | `brew install whisper-cpp` + one model file | Fully local | None | **Chosen** |
| faster-whisper (CTranslate2) | Same models, often faster on x86/CUDA; built-in word timestamps | Same | CPU only on Apple Silicon (no Metal) | Python venv, `ctranslate2` wheels, model download on first use | Local | None | Good on servers with GPUs; adds a Python runtime we do not need yet |
| OpenAI Whisper (PyTorch) | Reference quality | Same | Slower on CPU; heavy dependencies (torch) | Python + PyTorch | Local | None | Heaviest to run |
| Hosted STT API | Strong, often best accuracy | Strong | n/a | API key | **Audio leaves the machine** | Per-minute, grows with usage | Rejected for now: privacy and cost; the port makes it a later swap |
| Vosk / other local engines | Lower accuracy, weak punctuation | Limited | CPU | Model per language | Local | None | Not accurate enough for evidence |

**Decision:** whisper.cpp with the multilingual `ggml-base` model (141 MB, SHA-1 `465707469ff3a37a2b9b8d8f89f2f99de7299dac`, verified by `scripts/download-speech-model.sh`). It is the smallest model that is multilingual, runs about 16× faster than real time on this laptop, and needs no Python. **Python is not used at all**, so there is no Node/Python dependency tangle: the boundary is a single native executable behind `SpeechToTextProvider`. Only one provider exists; the port is what keeps it replaceable.

**Measured model comparison on this machine** (synthetic speech, see report): `base` transcribes English and Indian-accented English well but writes Hindi in **Urdu script** with word errors; `small` (465 MB, SHA-1 `55356645c2b361a969dfd0ef2c5a50d530afd8d5`, about 3× slower) writes Hindi in **Devanagari** nearly correctly. Neither handles Hindi-English code-switching. Use `small` for Hindi (`scripts/download-speech-model.sh small`); no code change is needed.

### 26.2 Runtime and setup

`whisper-cli` is spawned as a child process through the same hardened runner as FFmpeg: `spawn` with an argument array, `shell:false`, minimal environment, closed stdin, killed on abort. The only inputs on its command line are the server-generated audio path, the configured model path, a validated language code (`^[a-z]{2,3}$` or automatic) and fixed flags; **no user text, transcript or filter phrase ever reaches a command**. Output goes to a private temp directory (JSON) that is always deleted; stdout/stderr are discarded; the output file is size-capped. A corrupt audio file makes whisper.cpp exit 0 **without writing output**, which the adapter treats as `unsupported-audio`. Each job loads the model afresh (about 0.3 s for `base`); a resident server process is a later optimisation.

Setup: `brew install whisper-cpp` (installs `whisper-cli`), `scripts/download-speech-model.sh`, then in `.env`: `SAFEWATCH_SPEECH_PROVIDER=whispercpp`, `SAFEWATCH_SPEECH_MODEL_PATH=models/ggml-base.bin`. `models/` is git-ignored. If the binary or model is missing the server still starts, reports `speech.available: false` in `/api/health`, and collects subtitle evidence only.

### 26.3 Audio track selection policy

Input is the `AudioAsset` produced by extraction; the speech layer never extracts audio. Candidates are tracks with a stored file (bit-identical duplicates are listed as `duplicate`). Ranking, highest priority first: (1) language: matches the configured language, then unknown, then other (only when a language is configured; container tags such as `eng` map to `en`); (2) the container's default track; (3) not a commentary / hearing-impaired track; (4) container order. `SAFEWATCH_SPEECH_MAX_TRACKS` (default 1) tracks are transcribed; **every other track is listed with a reason** (`not-selected`, `duplicate`, `speech-disabled`), never dropped silently. Each result carries the track id, stream index and container language.

### 26.4 Transcript model and timestamps

`Transcript { mediaId, audioTrackId, streamIndex, language, languageConfidence, durationSeconds, segments[], hasWordTimestamps, wordTiming, provider, issues[] }`; a segment is `{ index, startSeconds, endSeconds, text, originalText, confidence, words[]|null }`; a word is `{ startSeconds, endSeconds, text, confidence }`.

- **Unit and precision:** media time in seconds, rounded to whole milliseconds (the engine reports 10 ms steps). No frame numbers anywhere.
- **Normalisation (deterministic):** NFC, control/zero-width/bidi characters removed, whitespace collapsed; the provider's text is kept as `originalText` only when it differed. Segments with missing, non-finite, negative or inverted times are dropped and counted; empty segments and exact duplicates are dropped; overlapping segments are kept untouched and counted; word lists that are out of order or outside their segment are discarded for that segment (`words: null`, counted). Words, casing and punctuation are never "corrected".
- **Confidence:** the mean of the engine's token probabilities for the word or segment. It is a model probability, not a calibrated confidence, and is `null` when the provider supplied none. Subtitles have no confidence.
- **Language:** the detected language (two-letter code) is recorded per transcript. Speech is never translated. Whisper reports one language per track.
- **Word timing basis (`wordTiming`):** `alignment` uses whisper.cpp's DTW alignment (`-dtw <preset> -nfa`); `decoder` uses the engine's own token times. **Measured on a clip with known ground truth** (2.0 s of leading silence, then speech, a 1.5 s pause, more speech): without DTW the first word was placed at 0.00 s (**2.0 s early**); with DTW the first word started at 2.08 s and the second sentence at 5.40 s vs a true 5.32 s (errors ≈ +0.08 s). DTW is therefore the default. **Word START times are the reliable part. A word's END is an upper bound** (the next word's start; the last word of a segment is capped at +1.0 s), and neighbouring words can share a start time. Do not use word ends as exact mute boundaries without further work.

### 26.5 Text events, alignment and custom filters

- **TextEvent** (`source: speech | subtitle`, start, end, text, language, trackId, confidence, words, evidence) is the common shape; subtitle events come from the extraction cues of **text** tracks only (image and failed tracks contribute none).
- **Alignment** is deterministic and conservative: a speech event and subtitle cue(s) are linked only if they are within 1 s in time, in compatible languages (by primary language; `eng` = `en`), and their words overlap (Dice similarity ≥ 0.6). It compares a speech event with all nearby cues together (cues split sentences) and a cue with several speech segments. Result per event: `both`, `speech-only` or `subtitle-only`. *No link means "not corroborated", never "wrong"*. No semantic AI.
- **CustomFilter** `{ id, phrase, normalizedPhrase, matchMode, enabled, createdAt }`. **Normalisation for matching:** NFKC, control/zero-width/bidi removed, curly quotes/apostrophes straightened, whitespace collapsed, optional lower-casing; punctuation is dropped by word tokenisation (inner apostrophes kept); diacritics are **not** stripped (“résumé” ≠ “resume”) and non-Latin scripts are preserved. **Modes:** `exact` (case-sensitive substring), `case-insensitive` (substring, may match inside words), `word-boundary` (whole words, case-insensitive), `phrase` (whole words ignoring spacing/punctuation between them, so “SafeWatch” matches the speech model's “safe watch”).
- **TextMatch** `{ filterId, phrase, source, trackId, eventId, startSeconds, endSeconds, matchedText, confidence, granularity (word|segment|cue), matchMode }`: word-level times when word timestamps exist, otherwise the whole segment/cue (honestly labelled). Confidence is the lowest known confidence of the matched words, `null` if unknown or for subtitles. Matching is pure, bounded (10,000 matches) and treats phrases as plain text (no regular expressions are built from user input). Filters live in the user's browser (localStorage) and the Transcript panel matches them there. (Checkpoint 7 change: the enabled terms are also sent to the server for the safety-findings request, see §29.5.)
- **Not implemented:** muting, beeping, blurring, censoring, subtitle replacement, scene skipping, scoring, any "safe/unsafe" verdict. Matches are evidence the future filtering engine will consume.

### 26.6 Lifecycle, API, limits

`TextAnalysis { status: not_started | queued | processing | ready | failed, phase: preparing | speech-processing | building-timeline }` runs after extraction completes, on its own bounded queue (default 1 job, queue of 20). `ready` means "text evidence is available", not "analysis is complete"; the safety `analysis` state stays `not_started`. A failed track (provider error, timeout, limit, unsupported audio) fails **that track only**, with a structured code, and the rest of the evidence is kept; the whole analysis fails only for queue overflow, cancellation or an internal error. `GET /api/media/:id/transcript` returns the `TextAnalysis` (`?words=false` omits word timestamps); `GET /api/media/:id` carries `text: {status, phase}`; `/api/health` reports `speech: {provider, available}` only.

| Limit | Default | On breach |
| --- | --- | --- |
| Per-track transcription timeout | 10 min | engine killed, track `failed: timeout` |
| Audio duration per track | 3600 s | track `failed: resource-limit`, engine not started |
| Audio size per track | 256 MB | same |
| Concurrent transcriptions | 1 (queue of 20) | beyond the queue: text analysis `failed: server-busy` |
| Tracks per media | 1 | others listed as `not-selected` |
| Transcript size | 20,000 segments, 2,000 characters per segment, 64 MB engine output | truncated and counted / `resource-limit` |

Cancellation: deleting media or expiry aborts the in-flight transcription (the engine process is killed, its temp directory removed) before the media is removed. A restart discards all transcripts with the media (in-memory, same retention).

### 26.7 Privacy

- **Where audio is processed:** on the SafeWatch server machine, by a local whisper.cpp process. **Audio is not sent to any third party**; the engine has no network access requirement and none is used (the model is a local file). The only network use is the one-time model download from Hugging Face by the developer.
- **Where transcripts live:** in server memory (inside the media record) and in API responses; never logged (logs hold counts, durations, ids and codes only). Subtitle text likewise. **One exception on disk:** whisper.cpp writes its result JSON (containing the transcript) into a private temp directory (created with mode 0700, verified by a test) which is deleted as soon as the adapter has read it and on every failure/abort path; if the server crashes mid-run that directory can survive until the next start, when stale `sw-whisper-*` directories older than an hour are swept. Audio itself is read in place from the media's extraction directory and is not copied.
- **Retention:** the media's 60-minute clock; deleting or expiring media deletes its transcripts and timeline, and aborts transcription in progress. The engine's temporary JSON is deleted immediately after each run.
- **Browser:** custom filters are stored in the visitor's own browser; transcripts are fetched on demand and are not persisted by the page.
- **Not claimed:** the machine hosting SafeWatch can read whatever it processes; encryption at rest, access control and per-user isolation do not exist yet (no authentication).

---

## 27. Visual intelligence (Checkpoint 5)

Second AI inference in SafeWatch. It produces **visual evidence only**: what an image model reports about each sampled frame, and when. It never decides whether media is safe, and it never mutes, blurs, hides, skips or edits anything. There is no safety classification, no score and no verdict anywhere in the model, the API or the UI.

```
 MediaExtraction (completed)                                   shared pure domain (src/domain/{vision,evidence})
   │ Frame { id, timestampSeconds, artifact }                   VisualObservation · normalizeObservation · compareObservations
   ▼                                                            VisualAnalysis lifecycle · validateVisualAnalysis
 VisualAnalysisService  (bounded queue, default 1 job)          EvidenceItem · buildEvidenceTimeline (text + visual on one timeline)
   │ policy: limits, batches, timeouts, cancellation, isolation
   ├─► VisualAnalysisProvider (port) ◄── AppleVisionProvider ──► safewatch-vision process ──► Apple Vision framework
   │         raw per-frame observations (untrusted)
   └─► normalizeObservation → sort → VisualAnalysis { frames, observations, counts, issues, metrics }
```

### 27.1 Provider evaluation (measured on this Apple Silicon Mac)

| Option | Output | Footprint | Privacy | Verdict |
| --- | --- | --- | --- | --- |
| **Apple Vision** (system framework, Swift helper) | Labels with confidence, person/animal boxes, OCR with boxes | 169 KB helper, no model download, ~70 MB RSS while running | Fully local | **Chosen** |
| ONNX Runtime (npm) + a model | Whatever the model gives | 145 to 301 MB of runtime before any weights | Local | Heavier; the right Linux adapter later |
| llama.cpp vision-language model | Free text only; no confidences or boxes | Gigabytes of weights | Local | Not evidence-shaped |
| CLIP-style embeddings | Similarity scores to prompts | ~350 MB | Local | Needs prompt lists: that is classification by another name |
| YOLO family | Object boxes | Small | Local | AGPL licence |
| Hosted vision API | Strong | None locally | **Frames leave the machine** | Rejected: privacy and cost |

**Trade-offs, stated plainly:** macOS only, and the model is Apple's and closed (no weights to inspect or pin). The port is what keeps it replaceable. Observed quirks: a person was missed in a living-room photo; a pure black frame is labelled "outdoor / night sky" (0.51); OCR can crop edge characters; the label vocabulary is Apple's ("consumer_electronics", "wood_processed"). **Face detection and recognition are deliberately not used.**

### 27.2 Contracts

- `VisualObservation { id, frameId, frameIndex, timestampSeconds, type, label, confidence | null, region | null, attributes | null, provider, model }`. Types are only `classification`, `object`, `text`: there is no safety type. Time always comes from the frame (media time); providers never supply it. Confidence is the provider's own number or `null` (never invented, out-of-range becomes `null`). Regions are fractions of the image with a **top-left origin** (the helper converts from Vision's bottom-left); invalid regions are removed, the observation stays.
- Order is total and deterministic: time, frame index, type (objects, text, labels), confidence (high first), label, id.
- `VisualAnalysis` has its own lifecycle `not_started → queued → processing → ready | failed`, separate from media, extraction and text. `ready` means "visual observations are available". Every candidate frame is listed with `analyzed | failed | skipped` and a reason.
- **Error taxonomy** (which layer failed): `frame-missing` (storage/extraction), `invalid-frame` (not a decodable JPEG/PNG), `inference-failed`, `provider-unavailable`, `timeout`, `cancelled`, `invalid-response` (provider output unusable), `resource-limit`, plus `no-frames`, `observations-dropped`, `server-busy`.
- **Failure isolation:** one bad frame fails alone; a failed batch fails only its frames; if nothing could be analysed the stage fails with the dominant cause; media and extraction stay `ready/completed`.

### 27.3 Unified evidence (decision)

`src/domain/evidence` projects `TextEvent` (speech, subtitles) and `VisualObservation` into one `EvidenceItem` shape and one chronological list, so later stages can ask "what was said, written and shown around t". It is a pure projection: **nothing in the speech, subtitle or Custom Filter code changed, and nothing consumes it yet.** Custom Filters still match text only.

### 27.4 Security and privacy

Frames are untrusted media: the helper opens only JPEG/PNG (type checked by the image decoder), oversized frames are refused before decoding, a corrupt file fails alone. The helper is run with an argv array (no shell), frame paths are server-generated and passed after `--`, the environment is minimal, stdin is closed, stdout is capped, stderr is discarded and the process is killed on timeout or cancellation. Labels and OCR text are sanitised, rendered as text, never as HTML, and never logged. `/api/frames` serves only ids from the manifest, as `image/jpeg` with `nosniff` and `default-src 'none'`. Frames and observations live for the same retention window as the media; nothing is uploaded anywhere.

**Unchanged production gates (NOT solved):** FFmpeg and helper process sandboxing, authentication/authorisation (media ids are bearer tokens, and frame images are reachable by id), rate limiting, disk quota.

### 27.5 Performance baseline

See `CHECKPOINT_5_REPORT.md`. Measured warm on this machine: about 36 ms per 640×480 frame, 300 frames in about 10.7 s of provider time, helper about 70 MB RSS. The first-ever run took about 26 s (system model compilation). These are small-frame, repeated-photo numbers, not a general benchmark.

---

## 28. Cross-modal context and temporal reasoning (Checkpoint 6)

A deterministic layer between raw evidence and any future safety classifier. It answers "which evidence belongs together in time?", never "is this acceptable?". There is no model and no LLM in it: the first version had to establish temporal correctness, provenance, reproducibility and testability before anything probabilistic is added. No external service, no key, no download.

```
 TextAnalysis.timeline (speech, subtitle)  ─┐                     src/domain/evidence   EvidenceItem (CP5, unchanged)
 VisualAnalysis.observations               ─┴─► buildEvidenceTimeline ─► correlateEvidence ─► ContextEvent[]   src/domain/context
                                                                 ▲ frame step (extraction manifest)
 MediaService.getContext  ──►  GET /api/media/:id/context  (pure function of the record; nothing stored, no files read)
```

### 28.1 Evidence and time

The CP5 `EvidenceItem` is reused as is (modality, kind, start/end seconds, label, confidence, sourceId). Provenance is preserved end to end: every context member keeps modality, kind, exact time, label, the source's own confidence and the audio track, subtitle track or frame it came from. Media time is converted once, at the boundary, to **integer milliseconds** (`toMs`), so no later comparison depends on float rounding (`0.1 + 0.2` becomes `300`). Point observations have `endMs == startMs`. Malformed items (empty id, non-finite or negative time, end before start, unknown modality) are dropped and counted, never repaired. Duplicates (same id, or same modality, kind, time, source and label) are dropped and counted.

### 28.2 Algorithm (`correlateEvidence`)

Sort O(n log n), one pass O(n), no pairwise comparison.

1. Validate, convert, dedupe. Sort by start, end, modality, id: input order cannot matter.
2. **Extended evidence** (duration > `maxContextMs`) leaves the pass and becomes its own event.
3. Each remaining item joins the **open window** when related, otherwise a new window starts. The window keeps three reaches: text (end + after), visual (end + after) and visual with coverage.
   - an item is related when `start - before <= reach` (reason `overlap` if it starts inside the window, else `proximity`);
   - a **frame** also relates to text through its **coverage** (half the sampling step, at most `maxVisualCoverageMs`): reason `visual-coverage`. Frames never chain to frames through coverage, and a frame attached only through coverage does not extend the window's reach (so a frame between two sentences cannot bridge them);
   - a window stops growing when joining would make it longer than `maxContextMs` (`closedBy: max-duration`).
4. Extended evidence is attached as `ambient` to every event it overlaps (not as a member, so it cannot glue unrelated moments together).
5. Events are sorted and numbered `ctx-0000…`: the id is the chronological position, so the same input always gives the same ids.

A window is never reopened: an item is related to the most recent window only (a single forward pass keeps it linear and explainable).

### 28.3 Defaults and why

| Setting | Default | Reason |
| --- | --- | --- |
| `windowBeforeMs` + `windowAfterMs` | 500 + 1000 (merge gap 1.5 s) | A sentence, its subtitle cue and an on-screen reaction fall inside it; separate sentences (pauses of seconds) do not |
| `maxContextMs` | 20 000 | One scene-sized span however long the chain of neighbours is |
| `maxVisualCoverageMs` | 5000 | With the default 10 s sampling a frame stands for about ±5 s; capped so sparse frames cannot reach far |

All four are server configuration (`SAFEWATCH_CONTEXT_*`) and are echoed in the response. **Known behaviour:** continuous text (subtitle cues back to back) correctly forms one long chain, cut at 20 s; very dense frame sampling (step ≤ 1.5 s) chains frames, also cut at 20 s. Choose the sampling step with that in mind.

### 28.4 Model

`ContextEvent { id, startMs, endMs, sources, corroboration, members, ambient, extended, closedBy, facts, confidence }`. `sources` lists the modalities that contributed; `corroboration` is `multi-source` when at least two did (a structural fact, not a strength or safety claim). `facts` are presence flags, counts per kind and up to five strongest distinct visual observations by the provider's own confidence. `confidence` is **per modality** (count, how many reported one, min, max): speech and visual confidences mean different things, so no combined number exists anywhere. Each member says why it joined. There is no field, label or score about acceptability.

### 28.5 Degradation

`ContextAnalysis.status`: `pending` (extraction, text or visual analysis still running: no events, never a partial guess), `ready`, `partial` (some input failed or is not enabled; the events from the rest are returned and `inputs` plus `warnings` name what is missing), `unavailable` (nothing usable). Each input (`speech`, `subtitles`, `visual`) is `used`, `empty` (the stage worked and found nothing), `failed`, `not-enabled` or `pending`. A provider failure is never turned into an empty success.

### 28.6 API, security, privacy

`GET /api/media/:id/context[?evidence=false]`, computed from the in-memory record: no filesystem access, no client-provided paths or evidence (other query parameters are ignored), ids validated like every media route (unknown or malformed ids are 404). Only GET is served. Responses contain no paths. Evidence text is untrusted, rendered as text, never logged. Everything is local. **Unchanged production gates (NOT solved):** authentication (media ids are bearer tokens: anyone with an id can read its context), rate limiting, disk quota, process sandboxing.

### 28.7 Performance

Synthetic evidence, one speech segment and subtitle cue every 6 s and 8 observations per frame every 3 s (`npm run check:context`): 180 items (1 min) 0.24 ms; 5 400 (30 min) 5.5 ms; 64 800 (6 h) 84 ms; 259 200 (24 h) 362 ms: about 1.3 µs per item, linear. The real inputs are bounded (at most 300 frames and an hour of speech by default), so it is far cheaper than extraction or inference.

---

## 29. Safety classification foundation (Checkpoint 7)

The first layer that can say "this evidence contains X". It is deliberately narrow: **one category is implemented (flagged terms in speech and subtitles); four are not supported.** It never reports a verdict, an overall score or a probability that was not measured, and it never acts on a finding (no muting, blurring, skipping or warning).

```
 TextAnalysis.timeline (CP4)  ─┐                                     src/domain/safety
 ContextAnalysis (CP6)        ─┼─► analyzeSafety ─► SafetyClassifier (port) ─► CategoryResult[] ─► SafetyAnalysis
 enabled flagged terms        ─┘        ▲ FlaggedTermClassifier (rule based, deterministic)
                                        └ a future model-backed classifier plugs in here (async allowed)
 MediaService.getSafetyFindings ─► POST|GET /api/media/:id/safety-findings   (pure function of in-memory results, no file access)
```

### 29.1 Taxonomy (`safewatch-taxonomy-1`)

Defined in `src/domain/safety/taxonomy.ts` with, per category: what counts, what does not, supported modalities, limitations and (if unsupported) the blocker.

| Category | Status | Evidence read | Notes |
| --- | --- | --- | --- |
| `flagged-terms` | **implemented** | speech, subtitles | Occurrence of a user-listed word or phrase. No built-in word list ships, so "profanity" is covered only for words the user lists. On-screen (OCR) text is not scanned yet |
| `sexual-content` | unsupported | none | Blocker below |
| `violence` | unsupported | none | A weapon-shaped object, a sport or a loud noise is not evidence |
| `graphic-injury` | unsupported | none | Red colours, medical or cooking scenes are not evidence |
| `drug-content` | unsupported | none | A drug word in an educational or news sentence is not use; users can list words under flagged terms, which says only where the words occur |

No category is `experimental`: nothing runs that is not evaluated.

### 29.2 Why four categories are unsupported (measured, not assumed)

- **Apple sensitive-content analysis** (`SensitiveContentAnalysis`, on-device, the only local nudity classifier on macOS) was tested with a Swift helper: it compiles, but the analysis fails with "User Safety either not entitled for client or not enabled": it needs a signed app with a restricted entitlement and a system setting, which an unsigned command-line helper cannot have.
- **No local model is installed** for sexual content, violence, gore or drugs, and `models/` holds only the speech model. Adding one means hundreds of MB to GB of weights plus a runtime (the earlier ONNX measurement was 145 to 301 MB before any weights), or a vision-language model producing free text without calibrated outputs, or a hosted service (excluded: local only).
- **No labelled evaluation data** for these categories can be obtained and committed responsibly (sensitive content, licensing), and a classifier that cannot be evaluated cannot be claimed.
- The CP5 image labels, person boxes and OCR are descriptive; using them as a stand-in ("a person" for sexual content, "a knife" for violence) would be exactly the misleading substitution this checkpoint rules out.

So the architecture is ready (taxonomy, contract, port, UI, evaluation harness) and the capability is not. The report shows these categories as `not-supported`; they are never silently `evaluated` with zero findings.

### 29.3 Contract

`SafetyFinding { id (sf-<category>-<n>), category, taxonomyVersion, startMs, endMs, status, rawScore, calibratedProbability, evidence[], explanation, warnings[], classifier, attributes }`.

- **Four things are kept apart:** raw classifier output (`rawScore`, `null` for rule engines), a calibrated probability (`calibratedProbability`, `null` unless calibration was measured: it never is today, and the validator rejects a probability without a raw score), a policy threshold (documented below), and a verdict (does not exist). The only confidence carried through is the source's own (recognizer confidence per evidence reference).
- **Status:** `detected` (positive condition holds in unqualified evidence) or `uncertain` (holds, evidence qualified; `warnings` say how). Unsupported categories and missing inputs are in the category report, not findings.
- **Evidence:** modality, kind, integer milliseconds, source id, the context event that holds it, source confidence. Time is canonical integer milliseconds; the validator rejects fractional, negative or inverted ranges, evidence outside the finding, unknown categories, other taxonomy versions, probabilities outside [0, 1], empty explanations and "uncertain without a reason". Invalid findings are dropped and counted (`invalid-finding`), never repaired.
- **Category report:** `evaluated` (ran over its full scope; zero findings means none found within that scope), `partial` (an input is missing and named), `abstained` (cannot run: no terms, text unavailable, classifier failed), `not-supported`.
- **Analysis status:** `pending`, `ready` (every implemented category evaluated), `partial`, `not-evaluated`.

### 29.4 The flagged-term classifier

Reuses the CP4 matcher (`findTextMatches`: NFKC, case folding, zero-width removal, whole-word, phrase, contains and exact modes, word timing) so there is one implementation of matching. It adds: clustering of overlapping matches of the same term across speech and subtitles into one finding with both as evidence (touching intervals count as overlapping; separate occurrences stay separate), the context event of each piece of evidence, status, and abstention.

Policy (ours, documented, not probabilities): speech-only support is `uncertain` when the lowest word confidence is below **0.5** (strictly below) or when subtitle text covering the same time does not contain the term (`subtitle-disagrees`). A subtitle-only finding stays `detected` with a `speech-did-not-confirm` warning (the subtitle is written text; speech recognition misses words). Agreement of speech and subtitle makes a finding `detected` whatever the recognizer confidence. Timing is the matched word's when the transcript has word times, otherwise the whole line, and the finding says so (`coarse-timing`). The match list is capped at 10 000 (CP4 limit) and a `findings-truncated` warning says so.

**Limits, stated:** it detects occurrence, not meaning (a listed word in an educational or quoted sentence is found; so is the same spelling in an unrelated sense); no stemming ("darned"), no leetspeak folding ("d4rn"), no spaced-out letters, no word split across subtitle cues; a word the recognizer misheard is a miss, and a miss is not evidence of absence.

### 29.5 API, privacy, security

`POST /api/media/:id/safety-findings` with `{ "terms": [{ "phrase", "matchMode" }] }`; `GET` runs it with no terms (`not-evaluated`, abstained). The body is strict: exactly that shape, at most 100 terms (the CP4 filter limit), phrases through the same normalisation and limits as the browser's filters, no duplicates, `application/json`, at most 32 KB (read with a hard cap); anything else is `400 INVALID_REQUEST` with a fixed message. Ids are validated like every media route (404). The client supplies only words to look for: never paths, evidence or settings; a path-like phrase is just a word. The result is computed from the in-memory results of earlier stages (no re-extraction, no file access, no subprocess, no model) and contains no paths.

**Privacy change (stated plainly):** until Checkpoint 6 the user's custom filters never left the browser. Now the **enabled terms are sent to the SafeWatch server** for this request (the server is the same local-first process that already holds the media and transcript). They are used for that one request, not stored and not logged (a test asserts neither terms nor transcript text appear in logs). Nothing goes to a third party. Unchanged production gates (NOT solved): authentication (media ids are bearer tokens), rate limiting, disk quota, process sandboxing.

### 29.6 Evaluation

`src/domain/safety/evaluation`: a versioned dataset (`flagged-terms-eval` v1, 43 synthetic examples written for this repository, no media, no third-party data, mild placeholder terms) run through the real pipeline, and a harness that scores true and false positives and negatives, precision, recall, abstention and uncertain rates, interval overlap (IoU) and boundary error. Kinds: positives, benign lookalikes, normalisation, timestamp boundaries, ambiguous, contradictory, missing input, and **six known limitations labelled by human intent** that the matcher cannot get right (they stay in the metrics). `npm run eval:safety`; the test suite pins the numbers.

Result: 43 examples, 37 behave as labelled, 6 known limitations, 0 unexpected failures; TP 28, FP 1, FN 5, TN 9; **precision 0.966, recall 0.848**; 3 abstentions (7%), 2 of 29 findings uncertain (7%); mean IoU 1.0 and maximum boundary error 0 ms where word timing exists. **These are engineering fixtures that pin documented behaviour: they say nothing about accuracy on real speech or real subtitles** (transcripts are given, so recognizer errors are out of the picture). The perfect scores on the first 37 are expected for hand-labelled fixtures against a deterministic matcher; the six known limitations are the honest part.

### 29.7 Performance

`npm run check:safety` (synthetic evidence, one sentence and its cue every 6 s, 12 timed words each): 1 min (20 text events) 0.1 ms with 3 terms, 1.6 ms with 100 terms; 30 min (600 events) 1.9 ms and 77 ms; 3 h (3 600 events) 13 ms and 78 ms. Memory stays near 10 to 130 MB heap. The 100-term runs use common words and hit the 10 000 match cap, which is why the 3 h run is no slower than 30 min. Response size grows with findings (3.4 MB for 3 500 findings), so a term list of very common words is an expensive request: bounded, not rate limited.

---

## 30. Playback safety actions (Checkpoint 8)

The first layer that acts on findings: while the user watches their own file, supported findings can mute or skip. It adds no detection, no category and no server behaviour. It acts only on `flagged-terms` findings (the only implemented category) and never on an invented one.

```
 SafetyAnalysis ──► planCandidates ──► ActionCandidate[] ──► resolveViews(settings) ──► PlaybackAction[] ──► buildSpans ──► PlaybackCoordinator
 (CP7, unchanged)    availability,        user choices           mute | skip              merged, sorted          │ decides from position + signals
                     timing quality,      (in memory)                                                           ▼
                     margin, clamp                                              PlaybackSurface  ◄── VideoSurface(HTMLVideoElement): seconds ↔ integer ms
                                                                                                    (the only place units change)
```

Everything left of `VideoSurface` is pure domain (`src/domain/playback`), tested with a fake player and no real time. The classifier is untouched, findings are never mutated, and no second taxonomy or finding model exists.

### 30.1 Media source (discovered, not assumed)

The application had no player and no endpoint serving the original media (the server stores the upload but exposes only metadata, extraction, evidence and frame images). The smallest safe integration is **the browser playing the user's own `File` through an object URL**: no new endpoint, no path, nothing uploaded again, nothing served. The hook that selects the file keeps it in memory for playback and the object URL is revoked when it is replaced or the panel goes away. Limits: container and codec support is the browser's (a file it cannot decode is reported and nothing is acted on), and the file must still be in the page (a reload loses it; the panel then says so). The alternative (an authenticated, range-capable media endpoint) would be a security decision for the hardening checkpoint: media ids are bearer tokens today.

### 30.2 Intervals and precision

Canonical integer milliseconds, half-open `[start, end)` (the playhead at `end` is outside). Precision comes from the CP7 finding, which says how its timing was obtained:

| Quality | Source | What is reliable | Action interval |
| --- | --- | --- | --- |
| `word` | speech with word timing | start aligned (about 0.1 s in the CP4 tests); **end approximate** (the next word's start, or at most one second after) | finding plus 150 ms before and 250 ms after |
| `cue` | a subtitle cue (alone or with speech) | cue times exact as authored, but the **whole line**, not the word | the cue itself |
| `segment` | speech without word timing | a recognizer boundary: coarse | the segment itself |

Margins are constants in `PLAYBACK_POLICY`. Only one adjustment is ever made: a margin is clamped at 0 and at the media end (unambiguous). A candidate is **unavailable** (listed with its reason, never acted on, never repaired) when: the finding fails the CP7 validator (`invalid-finding`), the category is not implemented, the interval has zero length (`zero-length`), starts at or after the media end (`outside-media`), or the media duration is invalid (`invalid-duration`: not a positive integer; `null` means "not known yet", so no upper clamp). **Real data note:** in the QA run two of three speech findings had a zero-length word (start equal to end, which the CP4 alignment produces when no end can be derived), so they were unavailable; this is the safe outcome but means word-timed speech findings are less actionable than subtitle cues.

### 30.3 Choices and precedence

Per finding: `none` (default), `mute`, `skip`, `ignore`; plus a default for undecided findings (`none`, `mute` or `skip`) and a master switch. Choices are keyed by the **occurrence** (category, exact range, folded term), not by the finding id, because ids are numbered per request and shift when the term list changes. Precedence is immediate: the master switch and any choice are applied to the coordinator on the same render. Uncertain findings and unavailable ones get no action by default; an explicit user choice on an uncertain finding is honoured (it is the user's decision, shown as such), an unavailable one cannot be chosen at all. Choices live in component memory for the open video: nothing is persisted or sent.

### 30.4 Coordinator rules

- **Mute:** muted exactly while the playhead is inside an enabled mute span. Only the `muted` flag changes: **volume is never touched**, so user volume changes are inherently respected. The user's own mute is remembered and restored; if the user unmutes during a span that is respected until the span is left; the echo of the coordinator's own change is ignored. Overlapping or adjacent actions are one span (sound is never restored early). Position decides, so seek into/out/across, pause, resume, replay and playback-rate changes need no special cases.
- **Skip:** when playback **enters** a span (the playhead advances into it, or play starts inside it) the player seeks to the span's end, capped at the duration. A seek the **user** makes into a span is respected (the span is suppressed until the playhead leaves it), so the user is never trapped; a large jump without a seek event counts as the user's. A skip waits for its own seek (stale updates are ignored), always moves strictly forward (so no loop is possible), is retried at most 3 times if the player lands early, then gives up and says so. Replay after the end is a fresh run. Skip wins over mute where they overlap.
- **Off:** with automatic actions off, or without actions, sound is restored at once and nothing is skipped. Switching an action from mute to skip mid-interval unmutes and skips on the next update. `dispose` (media change, unmount) restores the user's sound and clears everything.
- **Boundaries:** `timeupdate` fires about 4 times a second, which would blur boundaries by up to 250 ms. The hook also schedules a timer for the **next boundary** (`msUntilNextBoundary`, in real time at the current rate, 40 ms lead, at least 20 ms and at most 500 ms apart) and runs an animation-frame loop while playing. Both are needed: measured in the embedded browser, animation frames were throttled to about **2 per second**, and a mute that relied on them started 330 ms late; with the boundary timer it started 24 ms after the boundary (sampling resolution 20 ms).

### 30.5 Failure behaviour

An exception anywhere in the coordinator disposes it (restoring the user's sound), stops automatic actions, disables the switch, reports once ("Automatic actions stopped because of an error") and leaves the player and its controls alone. A file the browser cannot play is reported. Pending, unavailable, not-evaluated and partial analyses each have their own message and produce no actions beyond real findings. Malformed findings make candidates unavailable; nothing is guessed.

### 30.6 Security and privacy

No endpoint was added or changed, no filesystem access is possible from playback controls (the browser reads the `File` it was handed), nothing is sent to the server by playback, and client findings are never trusted over server findings (the findings come from the CP7 endpoint unchanged). Terms and reasons render as text. **Unchanged production gates (NOT solved):** authentication (media ids are bearer tokens), rate limiting, disk quota, sandboxing.

### 30.7 Performance

`npm run check:playback` (one hour of 60 fps playback, every frame an event; half the findings skip, half mute): per event 25 to 60 ns at 10 to 10 000 findings; setup (plan, resolve, merge) 0.02 ms at 10, 1.2 ms at 1 000, 13 ms at 10 000 findings, paid only when findings or choices change. Handlers do a binary search and a few comparisons: no sorting, classification or I/O per event.

### 30.8 Limitations

Not sample accurate (see 30.2 and the 20 to 40 ms observed start); muting is the player's own flag, so the file is never edited and there is no beep or audio replacement; the interval of a word-timed finding includes a margin and may cut neighbouring words; subtitle-cue findings mute or skip the whole line; the playhead is polled, so a very short interval can be missed by a stalled player; skipping to the exact end depends on the player's seek accuracy (keyframes) and is retried; formats the browser cannot decode cannot be played; the file must stay in the page; only flagged terms are supported.

## 31. Product experience (Checkpoint 9)

Adds no detection, category or server behaviour. It makes the existing flagged-term findings usable: a timed warning, a saved phrase workflow, validated preferences, local feedback and honest status text.

### 31.1 Warning scheduler

`src/domain/warnings` is pure: `buildWarningGroups` turns resolved CP8 views into groups (overlapping and adjacent findings merge; unavailable, ignored and invalid findings are excluded) and `WarningScheduler` decides from the playhead, an injected monotonic clock and a `WarningSurface`. A group's warning window is `[start - lead, start)`. Rules:

- one warning at a time; later groups queue in start order and a `WARNING_GAP_MS` (500 ms) pause separates consecutive warnings; no group warns twice per pass (re-armed only when the playhead leaves its window, so replay and backward seeks work);
- Skip/Ignore resolve the whole group through the CP8 override path once; expiry, dismissal and disabling never change media or settings;
- a seek or start inside a window warns at once, marked late, with the real time left; a finding that has already begun is never warned about; seeking forward past a finding removes its warning; seeking back out of a window re-arms it; a paused playhead gives no new warning, and a visible warning keeps expiring on real time (it is not frozen by pause); hover and focus hold the countdown and resume with the remaining time; the warning also disappears when its finding begins; end, replay (warns again), media replacement and unmount are handled (`dispose` hides and ignores later signals);
- the confidence is never invented: uncertain findings are labelled uncertain, nothing else is shown;
- the live-region announcement is made once per warning.

`usePlaybackCoordinator` owns both the coordinator and the scheduler with one set of media listeners and one boundary timer (animation frames are throttled in practice, see §30.4). Errors in the scheduler disable only warnings; the CP8 coordinator keeps working, and the reverse.

### 31.2 Stores

`createLocalStore` (`src/lib/localStore.ts`): validated parse on read, in-memory fallback when storage is unavailable or full, `useSyncExternalStore` subscription, never throws. Keys: preferences, feedback reports, filter list. Parsers read own properties only, clamp to allowed options and drop invalid records. No absolute paths, media ids or file names are stored.

### 31.3 Custom phrases

`updateCustomFilter` adds an edit operation with a `not-found` rejection beside the existing add/remove/validation/duplicate rules. `appliedStore` (memory) records which term set the current analysis used; the UI compares it to `termsKey` of the saved enabled terms to show saved / active / not applied. Phrases are sent to the local server only when an analysis is requested and are not logged or persisted there.

### 31.4 Feedback

`src/domain/feedback/report.ts` validates timestamp (`m:ss`, `h:mm:ss` or seconds), phrase (≤ 200), category (`heard`, `subtitle`, `unsure`: what the product can represent), optional note (≤ 200), at most 200 reports. Reports are local only: no endpoint, no logging, never turned into findings and never used to change detection.

### 31.5 Limits

Warnings are as accurate as the CP8 intervals (not sample accurate); timers are scheduled at the real boundary but rendering depends on the browser; a hidden tab is re-evaluated on return; only flagged terms; no overall score; no safety verdict. **Unchanged production gates (NOT solved):** authentication / media-id access control, rate limiting, disk quotas, FFmpeg/helper sandboxing, lifecycle cleanup.

## 32. Security and production readiness (Checkpoint 10)

**Scope and verdict.** Checkpoint 10 hardens SafeWatch for ONE deployment: a single person on one macOS machine, API bound to loopback, SPA and API reached through the same browser. It is **not** a general production-ready release. Every control below is labelled **[T]** implemented and tested, **[P]** implemented but incompletely tested, **[N]** not implemented, **[G]** release gate / deployment dependent.

### 32.1 Trust boundaries and assets

```
 other web pages ──X──┐
 other local users ───┤   Browser (SPA, HttpOnly session cookie) ──► SafeWatch API (127.0.0.1) ──► storage dir (0700)
 other local procs ───┘                                                    │ queues
                                                                           ▼
                                                      FFmpeg · FFprobe · whisper.cpp · Vision helper  (child processes, untrusted media)
```

Assets: uploaded media and everything derived from it (audio, frames, transcripts, phrases the user searches for); disk space; CPU; the user's browser session. Untrusted: every byte of every uploaded file (and therefore all subtitle/stream metadata), every request header, other origins and other local processes. Trusted: the server code, its configuration, the binaries it is told to run.

### 32.2 Audit findings (before this checkpoint)

| # | Severity | Finding (evidence = code read before the change) | Status |
| --- | --- | --- | --- |
| F1 | High | No authentication or ownership. A media id (UUID v4) was the only secret; `MediaService.get/delete/...` took only an id. Anyone who learned an id (log, URL, another local process) could read transcripts and frames or delete the media. | Fixed [T] |
| F2 | High | No `Host` validation: DNS rebinding would give a hostile page same-origin access to the loopback API (upload, resource exhaustion). Code-confirmed; not exploited in practice. | Fixed [T] |
| F3 | Medium | No rate limits: only a concurrent-upload cap. | Fixed [T] |
| F4 | Medium | No disk budget beyond a per-file cap; retention (60 min) was the only bound. | Fixed [T] (see 32.6 for what is not covered) |
| F5 | Medium | Process control: abort killed only the direct child with SIGKILL and did not wait for it (cleanup could race a still-writing tool); descendants and, at shutdown, running tools survived (orphans). | Fixed [T] |
| F6 | Medium | No OS isolation of FFmpeg/FFprobe/whisper/Vision (already documented as a gate in CP2/CP3). | Mitigated on macOS only [T]; open elsewhere [G] |
| F7 | Low | Storage followed symlinks on read (defence in depth; needs write access to a 0700 directory). | Fixed [T] |
| F8 | Low | Query parsing was lenient (`words=maybe` meant true; unknown parameters ignored). | Fixed [T] |
| F9 | Low | `SAFEWATCH_HOST=0.0.0.0` silently exposed an API with no accounts. | Fixed [T] (explicit opt-in + host list) |
| F10 | Low | Relative tool/model paths resolved against the working directory. | Fixed [T] |
| F11 | Info (privacy) | `index.html` loads Google Fonts from `fonts.googleapis.com` (since CP0A): a third-party request on every page load that discloses the visitor's IP and user agent to Google. CP9 documentation wrongly said there were no third-party requests. | **Fixed** [T: verified in a browser]: Inter v4.1 (official release, OFL 1.1) is now served from `public/fonts/`; `index.html` has no external request |
| F12 | Info | No Content-Security-Policy or other security headers for the SPA (the API does not serve the SPA). | Open [N] |
| F13 | Info | Dev dependency advisory: vite 8.3.0-8.3.2 (dev server; high). `npm audit --omit=dev`: 0. | Fixed by lockfile bump to 8.3.5 [T: build and tests re-run] |
| Not findings | | Shell injection (argv arrays, `shell:false`), path traversal through ids (strict UUID + artifact allow-list), logging of phrases/filenames, internal-error leakage: inspected and confirmed already safe; tests added. | |

### 32.3 Authentication and ownership [T]

- **Model:** anonymous per-browser sessions, no accounts, no passwords. The first successful upload from a browser starts a session: 32 random bytes (`crypto.randomBytes`), sent once as `sw_session` in a cookie `HttpOnly; SameSite=Strict; Path=/api; Max-Age=<ttl>` (+`Secure` when `SAFEWATCH_COOKIE_SECURE=true`). The server stores only the SHA-256 digest (the *owner id*); the owner id is kept on each `MediaRecord` and never serialised. Sessions expire after `SAFEWATCH_SESSION_TTL_MINUTES` idle (default 24 h, refreshed by use), are lost on restart (as is all media) and are capped at `SAFEWATCH_MAX_SESSIONS` (least recently used dropped first).
- **Enforcement:** every route that touches media goes through `MediaService.owned(id, ownerId)`: a missing record, a malformed id and another session's record are indistinguishable (`404 NOT_FOUND`, same body). No session or an unknown/expired one is `401 UNAUTHENTICATED` for every id. `DELETE` of something not yours is a silent no-op (204) that changes nothing. `GET /api/health` is the only public route.
- **What this is not:** it separates browser profiles on one machine. It does not identify people, there is no logout, and clearing cookies loses access to your own media (it still expires on schedule). Two tabs of one browser share a session.
- **Session churn (audited):** an idle session is dropped when more than `maxSessions` newer ones are created, so an attacker able to create sessions can invalidate an idle user (401). Mitigations: LRU (active sessions survive, tested), uploads/session creation limited per address (default 10/min), and media of a dropped or expired session is deleted immediately so it neither lingers nor holds quota (tested). Residual: on a shared address (reverse proxy) the limit is pooled.

### 32.4 Browser-origin protections [T]

`checkHost`: the `Host` header must match `SAFEWATCH_ALLOWED_HOSTS` (default `localhost`, `127.0.0.1`, `[::1]`, any port; `name:port` entries match exactly). `checkOrigin`: a request with an `Origin` that is neither allow-listed (`SAFEWATCH_ALLOWED_ORIGINS`) nor equal to the request's own host, or with `Sec-Fetch-Site: cross-site`, is refused (403) before any session or body handling, for every method. CORS never uses `*`; `Access-Control-Allow-Credentials: true` only for exact allow-listed origins. CSRF: `SameSite=Strict` plus the Origin check plus custom headers/JSON content types that force a preflight. JSON endpoints require `application/json`. Responses are `no-store` + `nosniff`. Supported topology: SPA and API on the same site (the Vite proxy in development; one origin in production). Cross-*site* deployments are unsupported (Strict cookies would not be sent).

### 32.5 Rate limits [T]

Fixed-window, per minute, keyed by session (or by remote address before a session exists): uploads 10, analysis (`POST …/safety-findings`) 60, media reads 3000, everything else 300. State is a bounded LRU map (`SAFEWATCH_RATE_MAX_KEYS`, default 10 000). Over the limit: `429 RATE_LIMITED` with `Retry-After`; the body of a rejected POST is never read. In memory: resets on restart, per process, address-based keys are pooled behind a proxy (no `X-Forwarded-For` trust is implemented). Concurrency limits (uploads 4, processing/extraction/speech/vision queues) from earlier checkpoints still apply.

### 32.6 Disk quota [T, with stated gaps]

`StorageQuota` (synchronous, so concurrent uploads cannot oversell): total 10 GB, per session 4 GB, 5 media per session, 512 MB of the volume left free (all configurable; the session budget must be at least the upload limit). An upload reserves its declared length (or the full upload limit when none is declared) *before* a byte is written; the declared length becomes the hard stream limit, so a lying client is cut off. After the write the charge is settled to the real size. Extraction reserves the worst case of its derived files (from the actual audio tracks and planned frames) after probing and settles to the real output; failure returns it. Delete, expiry, failure, cancel and shutdown release; the sweep also finishes and releases accounting that no record backs any more. **Not covered by the quota:** whisper.cpp's temporary JSON (in the OS temp directory, removed in `finally` and by a startup sweep, bounded by the 3600 s audio-duration limit and a 64 MB read cap; the cap is checked after it is written), the in-memory manifests and transcripts, and anything another program writes to the volume. Crash recovery: the in-memory quota and records die with the process and the next start purges the whole storage directory.

### 32.7 Filesystem and uploads [T]

Storage names are server-generated UUIDs with a fixed suffix; ids are validated against a strict pattern before any path is built; artifacts come from a two-folder allow-list; client file names are display text (sanitised, never part of a path, never logged). Files are created with `wx` (exclusive) and mode 0600 in a 0700 directory carrying a marker file; the server refuses to adopt a directory it did not create. Reads reject symlinks (`lstat`, `O_NOFOLLOW`); the extraction directory must be a real directory; purge/cleanup only match owned names and remove links as links. Uploads are streamed to `.part`, renamed when complete, and removed on oversize, truncation, disconnect, abort or sniff failure (tested with raw sockets). The container is decided by the bytes, not the extension or the declared type.

### 32.8 Child processes [T] and the sandbox

All tools run through one function: argv arrays, `shell:false`, minimal environment (`PATH` only), neutral working directory, absolute tool/model paths, closed stdin, capped stdout, `-protocol_whitelist file` and a forced demuxer for every FFmpeg/FFprobe input. Each child is its own process group; abort, timeout, output overflow and shutdown send SIGTERM to the group and SIGKILL after a grace period, and the call settles only after the process has exited (so its output can be deleted safely). A registry lets shutdown stop everything.

**macOS Seatbelt (`sandbox-exec`), enforced and tested with real tools:** deny all network, deny creating processes, deny every file write except the tool's own work directory (and, for whisper.cpp only, `<user cache>/com.apple.metal` so GPU kernels stay cached: without it a transcription took 14.5 s instead of 0.3 s). Verified: network connect fails, writes outside the directory fail (also through a symlink inside it), `fork` fails, FFmpeg refused an output path outside its directory, and real FFprobe, FFmpeg, whisper.cpp and the Vision helper all work inside the sandbox. `SAFEWATCH_SANDBOX=auto` probes for real; production requires it (`SAFEWATCH_REQUIRE_SANDBOX`). **Not enforced by the sandbox:** reads are unrestricted (the tools can read anything the user can), there are no CPU or memory limits, `sandbox-exec` is deprecated by Apple, and the profile was not reviewed by an independent party. **Linux and Windows: no sandbox exists** (production refuses to start there unless the requirement is explicitly turned off). Tool hangs are bounded by timeouts only.

### 32.9 Lifecycle [T]

Media: `uploaded → processing → ready | failed` (illegal transitions throw); a failed job always deletes its files and releases quota. Scheduling an already scheduled job is a no-op. Shutdown (SIGINT/SIGTERM): stop accepting, refuse new uploads, cancel running jobs, stop child processes, purge the storage directory, exit 0; a watchdog forces exit if cleanup stalls. Tested with the real entry point: SIGTERM during FFmpeg extraction, during an upload, when idle, twice in a row, and restart on the same directory. A SIGKILL/crash cannot run cleanup: tools started by a killed server may continue until they finish (`process.on('exit')` kills them on a normal exit only), and the next start purges the directory. `unhandledRejection` is logged by name only.

### 32.10 Validation, errors, logging [T]

Strict body schema (unknown fields, prototype keys, duplicates, oversize rejected), strict query parameters (`true`/`false` only, unknown keys refused), fixed error messages, generic 500s. Logs carry request id, masked route, status, durations and error *names*; never phrases, file names, cookies, media ids in paths or tool output (tested).

### 32.11 Configuration [T]

Loopback by default. A non-loopback `SAFEWATCH_HOST` needs `SAFEWATCH_ALLOW_NETWORK_BIND=true` **and** `SAFEWATCH_ALLOWED_HOSTS`. Production needs an explicit `SAFEWATCH_STORAGE_DIR` and a sandbox. Bad configuration prints one line and exits 1. `.env.example` holds placeholders only. Data is stored **unencrypted** (mode 0600 in a 0700 directory) for at most the retention time.

### 32.12 Release gates (what is NOT done)

| Item | State |
| --- | --- |
| Sandbox for Linux / Windows; read restrictions; CPU/memory limits for children | [N] gate |
| TLS / HTTPS and a verified `Secure` cookie deployment (only the attribute is unit tested) | [N]/[G] |
| Real user accounts, multi-user isolation, logout | [N] |
| Encryption at rest | [N] |
| Shared / distributed rate limiting, proxy-aware client addresses | [N] |
| Content-Security-Policy and security headers for the SPA | [N] |
| Third-party Google Fonts request (F11) | closed (self-hosted Inter) |
| Quota coverage of whisper's temp JSON | [N] |
| Independent security review, fuzzing of the media parsers, penetration test | [N] |
| Cross-site deployment (SPA and API on different sites) | unsupported |
| Behaviour after a hard crash leaves orphan tools until they finish | [P] documented, not fixable in-process |

## 33. YouTube player integration (Checkpoint 11)

**What this is, in one sentence.** A user can paste a YouTube link, watch the video in YouTube's own embedded player inside SafeWatch, and, if they supply a caption file, get phrase warnings, skip and mute for it. **It is not video analysis**: SafeWatch can neither hear nor see an embedded YouTube video, and no permitted way to get the audio, the frames or YouTube's captions for someone else's video exists. The local-file workflow (§§3-32) is unchanged and remains the only path with speech recognition.

Status labels: **[T]** implemented and tested · **[V]** verified in a real browser against real YouTube · **[N]** not implemented / not possible · **[G]** needs a decision or authorisation.

### 33.1 Feasibility (sources: the official IFrame Player API reference, Player Parameters, `captions.download` reference and the YouTube API Services Developer Policies, read on the day of implementation)

| Capability | Available? | Basis |
| --- | --- | --- |
| Embedded playback with YouTube's controls, branding and ads | Yes | IFrame Player API (`YT.Player`) |
| Playback position, duration, state, playback rate | Yes, read-only | `getCurrentTime()`, `getDuration()`, `getPlayerState()`, `getPlaybackRate()`, `onStateChange`, `onPlaybackRateChange` |
| Seek and mute/unmute by the page | Yes | `seekTo(seconds, allowSeekAhead)`, `mute()`, `unMute()`, `isMuted()` (documented methods) |
| Error reporting | Yes | `onError`: 2 invalid parameter, 5 HTML5 error, 100 not found/removed/private, 101 and 150 embedding not allowed, 153 missing referer/client identification |
| Public metadata (title and so on) | Not used | Not needed; no extra request is made |
| Caption TEXT | **No** | The player API exposes only caption font size and a reload switch (`captions` module); it returns no text. `captions.download` requires OAuth with edit permission on the video, i.e. the owner (scopes `youtube.force-ssl` / `youtubepartner`). Unofficial caption endpoints or scrapers are not used (policy III.E.6 forbids scraping; III.I.14 forbids non-API access to API data) |
| Audio of the video | **No** | The embedded player gives the page no audio stream; downloading or separating it is prohibited (III.E.1.a download/cache/store; III.I.7 separate, isolate or modify audio/video components) |
| Frames / picture | **No** | Same; the page cannot read a cross-origin iframe's pixels, and capturing the screen would be an unauthorised extraction |
| Thumbnails, titles, tags as evidence | Not used | They are not evidence of what happens in the video; SafeWatch never invents findings from them |
| Mute/skip by the page | Allowed by the API; no policy rule names it | III.I.6 forbids modifying or blocking the player's functionality, III.I.7 forbids modifying audio/video components, III.F.2.c/I.4 forbid obscuring attribution or links. Calling the documented `mute()`/`seekTo()` is using the player, not editing the audio, but the policy does not address it explicitly: **[G]** keep default = no action, require the user's choice, and re-check with YouTube before any public release |

**Therefore the only analysis input that is both permitted and real is text the user supplies** (an `.srt`/`.vtt` file they already have: they own the video, or the creator shared it). SafeWatch labels it as such everywhere.

### 33.2 Architecture [T]

```
 paste link ─► parseYouTubeUrl (strict) ─► videoId (11 chars, nothing else is kept)
                                              │
              YouTubePlayer (official IFrame API, privacy-enhanced host, no autoplay) ─► YouTubeDriver ──┐
                                                                                                           │ PlaybackDriver
 caption file (.srt/.vtt, read in the browser) ─► parseCaptionFile ─► analyzeCaptions ─► SafetyAnalysis ──┤ (same interface a <video> uses)
        │   same context builder + same flagged-term classifier as local files                            ▼
        └── discovery stamps (late / missed)                          PlaybackShell = findings, actions, warnings, preferences, feedback
                                                                      (extracted from PlaybackPanel; the CP8 coordinator and CP9 scheduler, unchanged)
```

- **No second engine.** `analyzeCaptions` builds a subtitle track and calls the existing `buildContextAnalysis` and `analyzeSafety`. The playback side is the CP8 `PlaybackCoordinator` and CP9 `WarningScheduler`, now bound to a `PlaybackDriver` (a small interface: surface, listen, isPlaying). A `<video>` and the YouTube player are two drivers. The existing local-file tests pass unchanged.
- **`src/domain/youtube`:** `url.ts` (strict parsing), `captions.ts` (SRT/WebVTT, bounded: 2 MB, 20 000 cues), `analysis.ts`, `sourceState.ts` (state machine and capability list), `discovery.ts` (late/missed). All pure.
- **`src/infrastructure/youtube`:** `iframeApi.ts` (loads `https://www.youtube.com/iframe_api` once per page and only when a video is first loaded; shared promise, one script element, a failure removes the script and allows a retry, a pre-existing `onYouTubeIframeAPIReady` is preserved), `youtubeDriver.ts`.
- **`src/features/youtube`:** `YouTubePlayer` (one player per id; destroys it, its timers and listeners when the id changes or the component goes away; ready-timeout 20 s), `YouTubePanel`, `SourceSelector` (tabs; only the chosen source is mounted, so nothing keeps playing in the background and no state leaks across sources).

### 33.3 State model [T]

Player: `idle → source-validated → player-loading → player-ready | player-error(kind)`. Analysis: `unavailable → pending → in-progress → partial | complete | failed`. Findings never appear without a finished analysis. **`complete` is unreachable today**: a finished analysis is `partial` unless the caller explicitly claims full coverage, and no YouTube source can (captions may be incomplete or wrong; there is no speech or picture source). The interface lists, per capability, its source, access method and limits (`youTubeCapabilities`): phrases in captions (available with a file), phrases in speech (unavailable), scene categories (not supported), warnings and actions (available only after an analysis).

### 33.4 The YouTube driver [T][V]

The API has no time-update or seek event, so the driver polls the position every 250 ms while someone listens (like a `<video>`'s `timeupdate`), maps `onStateChange` to the coordinator's signals, treats everything except PLAYING (buffering, cued, ended, paused, unstarted) as "not advancing", reports a seek the page asked for as `seeked` once the playhead lands (or after 1.5 s), and notices a user's mute change by comparing readings. Before ready every reading is neutral and every command is ignored; a player that throws gives neutral readings. The only commands it sends are `seekTo` and `mute`/`unMute`; it never touches the volume, the picture, the controls, the branding or advertisements, and nothing is drawn over the player (warnings appear in the reserved slot under it).

Real-browser evidence (Chromium in the desktop app, public video "Big Buck Bunny", Blender Foundation, id `aqz-KE-bpKQ`; the caption cues were my own synthetic test cues, not YouTube's):

- The embed is served from `https://www.youtube-nocookie.com/embed/<id>?enablejsapi=1&origin=…&autoplay=0&playsinline=1&rel=0&fs=1`: the `host` option is honoured; the iframe title is set; 424×238 px on a 458 px viewport, 286×200 px at 320 px.
- Warnings appeared while the real video played (about 20 s ahead, visible about 3 s); with the cue at 9 s the warning said "about 9 seconds" because the cue is early in the video.
- **Skip:** from 0:09.00 to 0:12.00 executed through `seekTo`. **Mute:** the real player's `isMuted()` turned true at playhead 71.05 s for a cue starting at 71.00 s and false at 76.02 s for a cue ending at 76.00 s (sampled every 50 ms). Sound state was restored.
- Captions added while the video was at 58 s: the banner "1 finding was found less than 20 seconds before it starts, so its warning is late" appeared.
- A nonexistent id returned error 150/101, which SafeWatch reports as "This video cannot be played here" with all the possible reasons (the API gives the same answer for "owner disallows embedding" and, as seen, for a missing video).
- A new link cleared the captions, findings and stages of the previous one.
- **Not verified live:** a video whose owner disallows embedding (none was identified), a private video, age-restricted or region-blocked videos, live streams, Shorts playback, and advertisements. See 33.8.

### 33.5 Privacy and policy [T for the code paths; the policy reading is not legal advice]

- **Requests to YouTube** happen only after a valid link is submitted: `www.youtube.com` (the API script `iframe_api` and the widget script) and `www.youtube-nocookie.com` (the player iframe, privacy-enhanced mode). From then on YouTube receives the usual player information (IP address, browser details, the embedding page's address, cookies it sets) under its terms. Autoplay is off; the player is not started by the page. The player then talks to YouTube and Google video domains on its own: SafeWatch cannot see or limit that. The page discloses this before the first load.
- **Not sent anywhere:** the user's phrases, the caption file, the findings and preferences. In YouTube mode SafeWatch makes no request to the SafeWatch server either (tested: `fetch` is never called). The caption text is read with `File.text()` in the browser and kept in memory for this video only.
- **No stored or copied YouTube content:** nothing is downloaded, recorded, cached, separated or re-encoded. The repository contains no YouTube screenshots or video for the same reason.
- **Content-Security-Policy:** the SPA currently has no CSP (unchanged, finding F12), so nothing was weakened. A deployment that adds one must allow: `script-src https://www.youtube.com https://s.ytimg.com`, `frame-src https://www.youtube-nocookie.com https://www.youtube.com`, `img-src https://i.ytimg.com`, `connect-src 'self'`. The IFrame API (as seen in testing) loads `www-widgetapi.js` from `www.youtube.com`.
- **Origin checks:** the player is given `origin = window.location.origin`; the SafeWatch API is not involved and its Host/Origin/session controls (§32) are untouched. The embed address is built from the validated 11-character id only; arbitrary iframe, script and host URLs are rejected by the parser (tests for 40+ malformed, hostile and look-alike inputs).
- **Policy points to keep checking** (III.E.1, III.F.2.c, III.I.4-7): no download/cache, no obscuring of attribution/links/ads, no modification of player functionality. Automatic mute/skip is the one area the policy does not explicitly address.

### 33.6 Warnings, late and missed findings [T][V]

Warnings are scheduled only from real timestamped findings (cue times exact). Each finding is stamped with the playhead when it was first found. Found at least the lead time before it starts (or before playback began): normal. Found closer than the lead time: **late**, the warning says so ("Found late: the captions were checked when playback was already close to this") and the page banners it. Found after it started: **missed**: no warning is possible and the page says so; it is never presented as an advance warning. Seeking, pausing, buffering, rate changes (the scheduler uses media time ÷ rate), video changes and ending are handled by the unchanged CP9 scheduler (38 tests) and by 9 driver-level integration tests with a fake YouTube player.

### 33.7 Source switching and cleanup [T]

Only the selected source is mounted. Leaving YouTube destroys the player and removes the timers (tested: `destroyed`, no timer left). A new link starts from nothing. `Stop and clear` and unmount do the same. React StrictMode's double effect leaves one live player. A rejected link keeps the current video.

### 33.8 Limitations and open items

- No speech and no scene analysis for YouTube, and none is possible through permitted means. To check speech, use the local file option.
- The caption file may be incomplete or belong to a different cut of the video; SafeWatch cannot verify it. Offsets between a caption file and the video are not corrected.
- Advertisements: the IFrame API can report ad playback as video playback (position and duration of the ad). Not tested; if ads run, warnings and actions could be mis-timed. **Open [G].**
- Mute silences the whole player (no audio-only muting exists); user mute changes made inside the player are noticed within ~250 ms.
- Skip lands where `seekTo` lands (keyframes); the coordinator retries up to 3 times as for files.
- Live streams (duration 0) and videos YouTube refuses to embed are not supported.
- The player's own controls (captions, speed, quality) are YouTube's; a change of captions inside the player does not change what SafeWatch checks.
- Small controls inherited from the playback panel (selects 28 px, checkboxes 20 px at 320 px) are below the 44 px target size (pre-existing, finding B4).
- **Decisions needed:** (1) whether automatic mute/skip on YouTube is acceptable for the intended distribution (policy not explicit); (2) whether owner-authorised captions (OAuth, `captions.download`) are wanted for users' own videos; that needs a Google Cloud project and a consent screen; (3) whether to keep supporting caption files with no way to verify them.
